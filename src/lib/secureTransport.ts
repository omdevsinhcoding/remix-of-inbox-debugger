// Client-side encrypted transport for Supabase edge functions.
// Wire format (binary, application/octet-stream):
//   Handshake req : [ver(1)][clientPubRaw(65)]
//   Handshake res : [ver(1)][sessionId(16)][serverPubRaw(65)][expiresAtMs(8, BE)]
//   Encrypted req : [ver(1)][sessionId(16)][iv(12)][ciphertext+tag]
//   Encrypted res : [ver(1)][iv(12)][ciphertext+tag]
//
// Encrypted-only transport. If crypto/session negotiation fails, calls fail.
// Sessions auto-rotate before their 15-min TTL. Each request carries a v2
// envelope { __v:2, n:<nonce>, t:<ts>, o:<origin_hash>, b:<body> } inside the
// encrypted payload so the server can detect replays.

const VERSION = 0x01;
const SESSION_ID_BYTES = 16;
const IV_BYTES = 12;
const CT_BINARY = "application/octet-stream";
const HKDF_INFO = "lovable-transport-v1";
const ROTATE_BEFORE_EXPIRY_MS = 60_000; // rotate 1 min before expiry
const FALLBACK_TTL_MS = 14 * 60_000; // if server omits expiresAt, assume 14min

type Session = { sidBytes: Uint8Array; key: CryptoKey; expiresAt: number };
let sessionPromise: Promise<Session> | null = null;

function fnBase(): string {
  return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
}
function anonKey(): string {
  return import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
async function sha256Hex(str: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)));
  return Array.from(h).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let originHashPromise: Promise<string> | null = null;
function getOriginHash(): Promise<string> {
  if (!originHashPromise) {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    originHashPromise = sha256Hex(origin);
  }
  return originHashPromise;
}

async function doHandshake(): Promise<Session> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const req = new Uint8Array(1 + pubRaw.length);
  req[0] = VERSION;
  req.set(pubRaw, 1);

  const res = await fetch(`${fnBase()}/crypto-handshake`, {
    method: "POST",
    headers: {
      "Content-Type": CT_BINARY,
      Authorization: `Bearer ${anonKey()}`,
      apikey: anonKey(),
    },
    body: req,
  });
  if (!res.ok) throw new Error(`handshake ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // Support both legacy (no expiresAt) and v2 (with 8-byte expiresAt suffix).
  const legacyLen = 1 + SESSION_ID_BYTES + 65;
  const withExpLen = legacyLen + 8;
  if ((buf.length !== legacyLen && buf.length !== withExpLen) || buf[0] !== VERSION) {
    throw new Error("handshake shape");
  }
  const sidBytes = buf.slice(1, 1 + SESSION_ID_BYTES);
  const serverPubRaw = buf.slice(1 + SESSION_ID_BYTES, legacyLen);
  let expiresAt = Date.now() + FALLBACK_TTL_MS;
  if (buf.length === withExpLen) {
    const dv = new DataView(buf.buffer, buf.byteOffset + legacyLen, 8);
    expiresAt = Number(dv.getBigUint64(0, false));
  }

  const serverPub = await crypto.subtle.importKey(
    "raw", serverPubRaw, { name: "ECDH", namedCurve: "P-256" }, true, [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: serverPub }, kp.privateKey, 256,
  ));
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const aesRaw = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: new TextEncoder().encode(HKDF_INFO) },
    hkdfKey,
    256,
  ));
  const key = await crypto.subtle.importKey("raw", aesRaw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { sidBytes, key, expiresAt };
}

async function getSession(): Promise<Session> {
  if (sessionPromise) {
    try {
      const s = await sessionPromise;
      if (s.expiresAt - Date.now() > ROTATE_BEFORE_EXPIRY_MS) return s;
      // near expiry — rotate
      sessionPromise = null;
    } catch {
      sessionPromise = null;
    }
  }
  if (!sessionPromise) {
    sessionPromise = doHandshake().catch((e) => {
      sessionPromise = null;
      throw e;
    });
  }
  return sessionPromise;
}

function resetSession() { sessionPromise = null; }

export interface SecureInvokeOptions {
  headers?: Record<string, string>;
}

function makeNonceB64(): string {
  const n = crypto.getRandomValues(new Uint8Array(16));
  return toB64(n);
}

async function wrapV2(body: any): Promise<any> {
  return {
    __v: 2,
    n: makeNonceB64(),
    t: Date.now(),
    o: await getOriginHash(),
    b: body ?? null,
  };
}

// Encrypted POST to `${fnBase}/<functionName>`. Returns parsed JSON payload.
export async function secureFetchJson(
  functionName: string,
  body: any,
  opts: SecureInvokeOptions = {},
): Promise<any> {
  const s = await getSession();
  const envelope = await wrapV2(body);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify(envelope));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, s.key, plain));
  const frame = new Uint8Array(1 + SESSION_ID_BYTES + IV_BYTES + cipher.length);
  frame[0] = VERSION;
  frame.set(s.sidBytes, 1);
  frame.set(iv, 1 + SESSION_ID_BYTES);
  frame.set(cipher, 1 + SESSION_ID_BYTES + IV_BYTES);

  const headers: Record<string, string> = {
    "Content-Type": CT_BINARY,
    Authorization: `Bearer ${anonKey()}`,
    apikey: anonKey(),
    ...(opts.headers || {}),
  };

  const res = await fetch(`${fnBase()}/${functionName}`, {
    method: "POST",
    headers,
    body: frame,
  });
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes(CT_BINARY)) {
    resetSession();
    const preview = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(
      `secureTransport: non-binary response from ${functionName} (status ${res.status}, ct=${ct || "none"})${preview ? `: ${preview}` : ""}`,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 1 + IV_BYTES + 16 || buf[0] !== VERSION) {
    resetSession();
    throw new Error("secureTransport: bad frame");
  }
  const rIv = buf.slice(1, 1 + IV_BYTES);
  const rCt = buf.slice(1 + IV_BYTES);
  let dec: Uint8Array;
  try {
    dec = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: rIv }, s.key, rCt));
  } catch (e) {
    resetSession();
    throw e;
  }
  const text = new TextDecoder().decode(dec);
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `Request failed with status ${res.status}`);
  return data;
}

export async function invokeEdge(
  functionName: string,
  body: any,
  opts: SecureInvokeOptions = {},
): Promise<any> {
  try {
    return await secureFetchJson(functionName, body, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/handshake|unknown session|bad frame|non-binary|OperationError|Failed to fetch|NetworkError|stale request|replay|origin mismatch/i.test(msg)) {
      resetSession();
      return await secureFetchJson(functionName, body, opts);
    }
    throw err;
  }
}
