// Client-side encrypted transport for Supabase edge functions.
// Wire format (binary, application/octet-stream):
//   Handshake req : [ver(1)][clientPubRaw(65)]
//   Handshake res : [ver(1)][sessionId(16)][serverPubRaw(65)]
//   Encrypted req : [ver(1)][sessionId(16)][iv(12)][ciphertext+tag]
//   Encrypted res : [ver(1)][iv(12)][ciphertext+tag]
//
// If any step of the encrypted path fails, callers fall back to plaintext
// (the edge functions accept both). This keeps existing flows working even
// when the browser blocks SubtleCrypto or the handshake endpoint is down.

const VERSION = 0x01;
const SESSION_ID_BYTES = 16;
const IV_BYTES = 12;
const CT_BINARY = "application/octet-stream";
const HKDF_INFO = "lovable-transport-v1";

type Session = { sidBytes: Uint8Array; key: CryptoKey };
let sessionPromise: Promise<Session> | null = null;

function fnBase(): string {
  return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
}
function anonKey(): string {
  return import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
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
  if (buf.length !== 1 + SESSION_ID_BYTES + 65 || buf[0] !== VERSION) {
    throw new Error("handshake shape");
  }
  const sidBytes = buf.slice(1, 1 + SESSION_ID_BYTES);
  const serverPubRaw = buf.slice(1 + SESSION_ID_BYTES);

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
  return { sidBytes, key };
}

async function getSession(): Promise<Session> {
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

// Encrypted POST to `${fnBase}/<functionName>`. Returns parsed JSON payload.
// Throws on failure — callers should fall back to plaintext.
export async function secureFetchJson(
  functionName: string,
  body: any,
  opts: SecureInvokeOptions = {},
): Promise<any> {
  const s = await getSession();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify(body ?? null));
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
  if (ct.includes(CT_BINARY)) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 1 + IV_BYTES + 16 || buf[0] !== VERSION) throw new Error("bad frame");
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
  // Fallback: server returned plaintext JSON (unexpected but tolerate).
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || `Request failed with status ${res.status}`);
  return data;
}

// Best-effort helper: try encrypted, fall back to plaintext fetch.
export async function invokeEdge(
  functionName: string,
  body: any,
  opts: SecureInvokeOptions = {},
): Promise<any> {
  try {
    return await secureFetchJson(functionName, body, opts);
  } catch (err) {
    console.warn(`[secureTransport] falling back to plaintext for ${functionName}:`, err);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anonKey()}`,
      apikey: anonKey(),
      ...(opts.headers || {}),
    };
    const res = await fetch(`${fnBase()}/${functionName}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.error || `Request failed with status ${res.status}`);
    return data;
  }
}
