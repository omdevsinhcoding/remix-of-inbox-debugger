// Public endpoint: performs a P-256 ECDH handshake and returns a session id
// plus the server's ephemeral public key. All bytes on the wire, no JSON.
import { cryptoCorsHeaders, handleHandshake } from "../_shared/crypto.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cryptoCorsHeaders });
  if (req.method !== "POST") return new Response("method", { status: 405, headers: cryptoCorsHeaders });
  try {
    return await handleHandshake(req);
  } catch (_e) {
    return new Response("handshake error", { status: 400, headers: cryptoCorsHeaders });
  }
});
