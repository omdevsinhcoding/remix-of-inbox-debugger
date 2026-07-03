// Shared AES-256-GCM binary transport used by edge functions.
// Wire format:
//   Encrypted request  : [ver(1)][sessionId(16)][iv(12)][ciphertext+tag(N)]
//   Encrypted response : [ver(1)][iv(12)][ciphertext+tag(N)]
// The server auto-detects encrypted requests via
//   Content-Type: application/octet-stream
// and falls back to plain JSON for any other request.

import { createClient } from "npm:@supabase/supabase-js@2";

const VERSION = 0x01;
const SESSION_ID_BYTES = 16;
const IV_BYTES = 12;

const CT_BINARY = "application/octet-stream";

export const cryptoCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-session-token, x-pending-token, x-crypto-session",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function admin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

function uuidBytesToString(bytes: Uint8Array): string {
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function uuidStringToBytes(id: string): Uint8Array {
  const hex = id.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// bytea returned from postgrest as "\\xDEADBEEF..." hex string
function pgByteaToBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") {
    let hex = v;
    if (hex.startsWith("\\x") || hex.startsWith("\\X")) hex = hex.slice(2);
    if (hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  throw new Error("invalid bytea");
}

async function loadKey(sessionId: string): Promise<CryptoKey | null> {
  const sb = admin();
  const { data, error } = await sb
    .from("crypto_sessions")
    .select("aes_key, expires_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  const raw = pgByteaToBytes((data as any).aes_key);
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export interface EncryptedRequestContext {
  sessionId: string;
  key: CryptoKey;
}

// Reads and decrypts an incoming request. Returns:
//  - { encrypted: true, body, ctx } for encrypted binary requests
//  - { encrypted: false, body } for plaintext JSON (backward compat)
// `body` is always the parsed JSON object (or null on empty).
export async function readRequest(req: Request): Promise<
  | { encrypted: false; body: any; ctx: null }
  | { encrypted: true; body: any; ctx: EncryptedRequestContext }
> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (ct.includes(CT_BINARY)) {
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.length < 1 + SESSION_ID_BYTES + IV_BYTES + 16) throw new Error("crypto: short frame");
    if (buf[0] !== VERSION) throw new Error("crypto: bad version");
    const sidBytes = buf.slice(1, 1 + SESSION_ID_BYTES);
    const sessionId = uuidBytesToString(sidBytes);
    const iv = buf.slice(1 + SESSION_ID_BYTES, 1 + SESSION_ID_BYTES + IV_BYTES);
    const ct2 = buf.slice(1 + SESSION_ID_BYTES + IV_BYTES);
    const key = await loadKey(sessionId);
    if (!key) throw new Error("crypto: unknown session");
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct2));
    const text = new TextDecoder().decode(plain);
    const body = text.length ? JSON.parse(text) : null;
    return { encrypted: true, body, ctx: { sessionId, key } };
  }
  // plaintext JSON path
  let body: any = null;
  try { body = await req.json(); } catch { body = null; }
  return { encrypted: false, body, ctx: null };
}

// Encrypts a JSON payload into the binary response frame using the session key.
export async function encryptResponse(payload: any, ctx: EncryptedRequestContext, status = 200): Promise<Response> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify(payload ?? null));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ctx.key, plain));
  const out = new Uint8Array(1 + IV_BYTES + cipher.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(cipher, 1 + IV_BYTES);
  return new Response(out, {
    status,
    headers: { ...cryptoCorsHeaders, "Content-Type": CT_BINARY },
  });
}

// Convenience: wrap a Response (which contains JSON) back into an encrypted frame
// when the request was encrypted. Otherwise, return it unchanged.
export async function maybeEncryptResponse(
  res: Response,
  ctx: EncryptedRequestContext | null,
): Promise<Response> {
  if (!ctx) return res;
  // Read the response body; only encrypt JSON payloads.
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return res;
  const text = await res.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return await encryptResponse(payload, ctx, res.status);
}

// ---------- Handshake (P-256 ECDH -> HKDF-SHA256 -> AES-256) ----------
// Request : [ver(1)][clientPubRaw(65)]
// Response: [ver(1)][sessionId(16)][serverPubRaw(65)]

export async function handleHandshake(req: Request): Promise<Response> {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length !== 1 + 65 || buf[0] !== VERSION) {
    return new Response("bad handshake", { status: 400, headers: cryptoCorsHeaders });
  }
  const clientPubRaw = buf.slice(1);
  const clientPub = await crypto.subtle.importKey(
    "raw", clientPubRaw, { name: "ECDH", namedCurve: "P-256" }, true, [],
  );
  const serverKp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  ) as CryptoKeyPair;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientPub }, serverKp.privateKey, 256,
  ));
  // HKDF-SHA256 to derive 32-byte AES key
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const aesRaw = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: new TextEncoder().encode("lovable-transport-v1") },
    hkdfKey,
    256,
  ));
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverKp.publicKey));

  const sb = admin();
  const hex = "\\x" + Array.from(aesRaw).map((b) => b.toString(16).padStart(2, "0")).join("");
  const { data, error } = await sb
    .from("crypto_sessions")
    .insert({ aes_key: hex })
    .select("id")
    .single();
  if (error || !data) {
    return new Response("session store failed", { status: 500, headers: cryptoCorsHeaders });
  }
  const sidBytes = uuidStringToBytes(data.id);
  const out = new Uint8Array(1 + 16 + 65);
  out[0] = VERSION;
  out.set(sidBytes, 1);
  out.set(serverPubRaw, 1 + 16);
  return new Response(out, {
    status: 200,
    headers: { ...cryptoCorsHeaders, "Content-Type": CT_BINARY },
  });
}
