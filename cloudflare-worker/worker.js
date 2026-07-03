import { connect } from "cloudflare:sockets";

/**
 * Cloudflare Worker — Email Cache Proxy
 * 
 * Features:
 * - Validates session tokens (HMAC-SHA256)
 * - Multi-KV namespace support (EMAIL_CACHE_V2 -> EMAIL_CACHE fallback)
  * - Direct Cloudflare → Gmail IMAP sync support
 * - Proper error logging for KV failures
 * 
 * Environment Variables:
 *   SUPABASE_URL, SUPABASE_KEY, SESSION_SECRET
 * 
 * KV Namespace Bindings:
 *   EMAIL_CACHE (primary), EMAIL_CACHE_V2 (optional secondary)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token, X-Pending-Token, X-Cron-Secret, X-Worker-Config-Secret, Cache-Control",
};

// F7: Bump CACHE_SCHEMA_VERSION whenever the shape of cached email JSON
// changes, or to force every worker/user to drop old snapshots on the next
// read. Version is baked into every KV key so old entries become unreachable
// (and expire naturally) without needing a manual purge.
const CACHE_SCHEMA_VERSION = "v3";
const LEGACY_CACHE_SCHEMA_VERSIONS = ["v2", "v1"];
const CACHE_KEY = `emails_list:${CACHE_SCHEMA_VERSION}`;
const CACHE_TIMESTAMP_KEY = `emails_timestamp:${CACHE_SCHEMA_VERSION}`;
const WORKER_CONFIG_KEY = "inbox_worker_config:v1";
const STALE_SECONDS = 3;

// --- KV helpers: use V2 if available, fallback to V1 ---
function getKV(env) {
  return env.EMAIL_CACHE_V2 || env.EMAIL_CACHE || null;
}

async function kvGet(env, key) {
  const kv = getKV(env);
  if (!kv) return null;
  try {
    return await kv.get(key);
  } catch (err) {
    console.error(`KV read error (key=${key}):`, err.message || err);
    return null;
  }
}

async function kvPut(env, key, value) {
  const kv = getKV(env);
  if (!kv) return false;
  try {
    await kv.put(key, value);
    return true;
  } catch (err) {
    console.error(`KV write error (key=${key}):`, err.message || err);
    // Try the other KV if V2 failed
    if (env.EMAIL_CACHE_V2 && env.EMAIL_CACHE) {
      try {
        await env.EMAIL_CACHE.put(key, value);
        console.log(`KV fallback write succeeded for key=${key}`);
        return true;
      } catch (err2) {
        console.error(`KV fallback write also failed:`, err2.message || err2);
      }
    }
    return false;
  }
}

// --- Session verification ---
async function verifySessionToken(token, secret) {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = new Uint8Array(sigHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function parseEmailList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.emails)) return parsed.emails;
    return [];
  } catch {
    return null;
  }
}

function cachePrefixes() {
  return [CACHE_SCHEMA_VERSION, ...LEGACY_CACHE_SCHEMA_VERSIONS]
    .map((version) => ({ list: `emails_list:${version}`, ts: `emails_timestamp:${version}` }));
}

function mergeEmailPayloads(existingRaw, incomingRaw) {
  if (!existingRaw) return null;
  const existingEmails = parseEmailList(existingRaw);
  const incomingEmails = parseEmailList(incomingRaw);

  if (!existingEmails || !incomingEmails) return null;

  const emailMap = new Map();
  for (const email of [...incomingEmails, ...existingEmails]) {
    if (email?.id) emailMap.set(email.id, email);
  }

  return JSON.stringify(
    Array.from(emailMap.values()).sort(
      (a, b) => new Date(b?.date || 0).getTime() - new Date(a?.date || 0).getTime()
    )
  );
}

// --- Main handler ---
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const sessionToken = request.headers.get("X-Session-Token") || request.headers.get("x-session-token");
    let session = null;

    // F5: prefer the dedicated SESSION_SIGNING_SECRET; fall back to legacy
    // SESSION_SECRET (which used to be the Supabase service-role key) so
    // sessions issued before the rotation still verify until they expire.
    const signingPrimary = env.SESSION_SIGNING_SECRET || env.SESSION_SECRET;
    const signingLegacy = env.SESSION_SECRET;
    const hasSigning = !!signingPrimary;

    if (url.pathname === "/api/config/update" && request.method === "POST") {
      const provided = request.headers.get("X-Worker-Config-Secret") || request.headers.get("x-worker-config-secret") || "";
      if (!signingPrimary || provided !== signingPrimary) {
        return new Response(JSON.stringify({ success: false, error: "Forbidden" }), {
          status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      if (!getKV(env)) {
        return new Response(JSON.stringify({ success: false, error: "KV is not configured" }), {
          status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      let body = null;
      try { body = await request.json(); } catch {}
      if (!body || typeof body !== "object") {
        return new Response(JSON.stringify({ success: false, error: "Invalid config" }), {
          status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      await kvPut(env, WORKER_CONFIG_KEY, JSON.stringify({ ...body, savedAt: Date.now() }));
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (sessionToken && signingPrimary) {
      session = await verifySessionToken(sessionToken, signingPrimary);
      if (!session && signingLegacy && signingLegacy !== signingPrimary) {
        session = await verifySessionToken(sessionToken, signingLegacy);
      }
    }

    if ((url.pathname === "/api/emails" || url.pathname === "/api/emails/sync") && !session) {
      if (hasSigning) {
        return new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }


    if (url.pathname === "/api/emails" && request.method === "GET") {
      const bust = url.searchParams.get("bust") === "1" || url.searchParams.get("bust") === "true";
      const limit = clampLimit(url.searchParams.get("limit"), 3, 200);
      const accountLabels = url.searchParams.getAll("accountLabel").map(v => v.trim()).filter(Boolean);
      return handleGetEmails(env, session, sessionToken, { bust, limit, accountLabels });
    }

    if (url.pathname === "/api/emails/sync" && request.method === "POST") {
      let reqBody = {};
      try { reqBody = await request.clone().json(); } catch {}
      return handleSync(env, session, sessionToken, reqBody, ctx);
    }

    if (url.pathname === "/api/cache/purge" && request.method === "POST") {
      return handleCachePurge(env, session);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return new Response(JSON.stringify({
        ok: true,
        version: CACHE_SCHEMA_VERSION,
        kv: !!getKV(env),
        signing: !!(env.SESSION_SIGNING_SECRET || env.SESSION_SECRET),
        ts: Date.now(),
      }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }

    // F6: /api/debug removed. It disclosed whether SESSION_SECRET / KV bindings
    // were configured, which helped attackers detect when worker auth was off.
    // If you need it back for local debugging, gate it behind env.DEBUG_TOKEN.



    // Proxy manage-app and other edge functions through worker
    if (url.pathname.startsWith("/api/fn/") && request.method === "POST") {
      const fnName = url.pathname.replace("/api/fn/", "");
      return handleFunctionProxy(request, env, fnName);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },

  // Cron/scheduled handler — triggers an IMAP sync automatically
  async scheduled(event, env, ctx) {
    // Background polling is intentionally disabled. User refreshes hit Gmail
    // directly from Cloudflare and update KV only for that scoped inbox.
    console.log("[cron] disabled — no background Supabase/Gmail fetch");
  },
};

function diagHeaders(extra = {}) {
  const base = {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Cache-Version": CACHE_SCHEMA_VERSION,
    "Access-Control-Expose-Headers": "X-Cache-Status, X-Cache-Age, X-Cache-Version, X-Worker-Endpoint, X-Cache-Key",
  };
  return { ...base, ...extra };
}

function clampLimit(value, fallback = 3, max = 50) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

async function handleGetEmails(env, session, rawToken, opts = {}) {
  const hasKV = !!getKV(env);
  const bust = !!opts.bust;
  const limit = clampLimit(opts.limit, 3, 200);
  const accountLabels = Array.isArray(opts.accountLabels) ? opts.accountLabels : [];

  if (!hasKV) {
    return new Response(JSON.stringify([]), { headers: diagHeaders({ "X-Cache-Status": "NO_KV" }) });
  }

  const scopedLabels = accountLabels.length > 0 ? accountLabels : (session?.assignedAccounts || []);
  const userAccountsKey = scopedLabels.length > 0 ? JSON.stringify([...scopedLabels].sort()) : "all";
  const cacheKey = `${CACHE_KEY}:${userAccountsKey}:limit:${limit}`;
  const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;

  // F7: bust=1 → skip KV read, refetch fresh, write back, return with BYPASS status.
  if (bust) {
    const result = await syncDirectFromAccounts(env, session, { accountLabels, limit, source: "user_refresh" });
    const body = JSON.stringify(result.emails || []);
    await Promise.all([kvPut(env, cacheKey, body), kvPut(env, tsKey, Date.now().toString())]);
    return new Response(body, { status: 200, headers: diagHeaders({ "X-Cache-Status": "BYPASS", "X-Cache-Key": cacheKey }) });
  }

  const [cached, timestamp] = await Promise.all([kvGet(env, cacheKey), kvGet(env, tsKey)]);
  const now = Date.now();
  const age = timestamp ? (now - parseInt(timestamp)) / 1000 : Infinity;

  if (!cached) {
    const fallbackKeys = cachePrefixes().flatMap(({ list }) => [
      `${list}:${userAccountsKey}:limit:${limit}`,
      `${list}:${userAccountsKey}:limit:200`,
      `${list}:${userAccountsKey}:limit:50`,
      `${list}:${userAccountsKey}:limit:3`,
      `${list}:${userAccountsKey}`,
      `${list}:all:limit:${limit}`,
      `${list}:all:limit:200`,
      `${list}:all:limit:50`,
      `${list}:all:limit:3`,
      `${list}:all`,
    ]).filter((key, index, arr) => key !== cacheKey && arr.indexOf(key) === index);
    for (const fallbackKey of fallbackKeys) {
      const fallback = await kvGet(env, fallbackKey);
      if (fallback) {
        await Promise.all([kvPut(env, cacheKey, fallback), kvPut(env, tsKey, Date.now().toString())]);
        return new Response(fallback, { headers: diagHeaders({ "X-Cache-Status": "FALLBACK_HIT", "X-Cache-Key": fallbackKey }) });
      }
    }
    return new Response(JSON.stringify([]), { headers: diagHeaders({ "X-Cache-Status": "MISS", "X-Cache-Key": cacheKey }) });
  }

  let status = "HIT";
  if (age > STALE_SECONDS) {
    status = "STALE";
  }

  return new Response(cached, {
    headers: diagHeaders({ "X-Cache-Status": status, "X-Cache-Age": Math.round(age).toString(), "X-Cache-Key": cacheKey }),
  });
}

async function handleCachePurge(env, session) {
  if (!session) {
    return new Response(JSON.stringify({ error: "auth required" }), { status: 401, headers: diagHeaders() });
  }
  const kv = getKV(env);
  if (!kv) return new Response(JSON.stringify({ ok: true, purged: 0, reason: "no_kv" }), { headers: diagHeaders() });
  const userAccountsKey = session?.assignedAccounts ? JSON.stringify(session.assignedAccounts.sort()) : "all";
  const cacheKey = `${CACHE_KEY}:${userAccountsKey}`;
  const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;
  try {
    await Promise.all([kv.delete(cacheKey), kv.delete(tsKey)]);
    return new Response(JSON.stringify({ ok: true, purged: 2, cacheKey }), { headers: diagHeaders({ "X-Cache-Status": "PURGED" }) });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: diagHeaders() });
  }
}

async function handleSync(env, session, rawToken, requestBody, ctx) {
  try {
    const limit = clampLimit(requestBody?.limit, 3, 50);
    const requestedLabels = Array.isArray(requestBody?.accountLabels) ? requestBody.accountLabels : [];
    const result = await syncDirectFromAccounts(env, session, {
      accountLabels: requestedLabels,
      limit,
      source: requestBody?.source || "worker",
    });
    const responseText = JSON.stringify(result);

    // Update KV cache after successful sync without blocking the user response.
    if (getKV(env)) {
      const scopedLabels = requestedLabels.length > 0 ? requestedLabels : (session?.assignedAccounts || []);
      const userAccountsKey = scopedLabels.length > 0 ? JSON.stringify([...scopedLabels].sort()) : "all";
      const cacheKey = `${CACHE_KEY}:${userAccountsKey}:limit:${limit}`;
      const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;

      const cacheWork = (async () => {
        let freshRaw = "[]";
        try {
          if (Array.isArray(result?.emails)) freshRaw = JSON.stringify(result.emails);
        } catch {}
        const fullCacheKey = `${CACHE_KEY}:${userAccountsKey}:limit:200`;
        const existingFull = await kvGet(env, fullCacheKey);
        const mergedFull = mergeEmailPayloads(existingFull, freshRaw) || freshRaw;
        await Promise.all([
          kvPut(env, cacheKey, freshRaw),
          kvPut(env, fullCacheKey, mergedFull),
          kvPut(env, tsKey, Date.now().toString()),
        ]);
      })().catch((err) => console.error("[sync] async KV update failed:", err.message || err));
      if (ctx?.waitUntil) ctx.waitUntil(cacheWork);
    }

    return new Response(responseText, {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message || "Sync request failed" }), {
      status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}

// handleDebug removed (F6). Route no longer exposed.


function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extraHeaders },
  });
}

function imapQuote(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function imapDate(date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(date.getUTCDate()).padStart(2, "0")}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function decodeMimeWords(value = "") {
  return String(value).replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      if (enc.toUpperCase() === "B") {
        const bin = atob(text);
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        return new TextDecoder(charset || "utf-8").decode(bytes);
      }
      const qp = text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      return qp;
    } catch { return text; }
  });
}

function decodeBytes(bytes, charset = "utf-8") {
  try { return new TextDecoder(String(charset || "utf-8").toLowerCase()).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

function decodeBase64Body(input = "", charset = "utf-8") {
  const bin = atob(String(input).replace(/\s+/g, ""));
  return decodeBytes(Uint8Array.from(bin, c => c.charCodeAt(0)), charset);
}

function decodeQuotedPrintable(input = "", charset = "utf-8") {
  const normalized = String(input).replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(i + 1, i + 3))) {
      bytes.push(parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(normalized.charCodeAt(i));
    }
  }
  return decodeBytes(new Uint8Array(bytes), charset);
}

function parseHeaders(raw) {
  const [headerBlock, ...bodyParts] = String(raw || "").split(/\r?\n\r?\n/);
  const headers = {};
  let current = "";
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) headers[current] += " " + line.trim();
    else {
      const idx = line.indexOf(":");
      if (idx > 0) {
        current = line.slice(0, idx).toLowerCase();
        headers[current] = line.slice(idx + 1).trim();
      }
    }
  }
  const body = bodyParts.join("\n\n");
  return { headers, body };
}

function headerParam(value = "", name) {
  const re = new RegExp(`${name}\\*?=(?:\"([^\"]*)\"|([^;\\s]+))`, "i");
  const m = String(value || "").match(re);
  return decodeMimeWords((m?.[1] || m?.[2] || "").trim());
}

function contentMime(headers) {
  return String(headers?.["content-type"] || "text/plain").split(";")[0].trim().toLowerCase() || "text/plain";
}

function decodeTransferBody(body, headers) {
  const enc = String(headers?.["content-transfer-encoding"] || "").trim().toLowerCase();
  const charset = headerParam(headers?.["content-type"] || "", "charset") || "utf-8";
  try {
    if (enc === "base64") return decodeBase64Body(body, charset);
    if (enc === "quoted-printable") return decodeQuotedPrintable(body, charset);
  } catch {}
  return String(body || "");
}

function splitMultipart(body, boundary) {
  if (!boundary) return [];
  return String(body || "")
    .split(`--${boundary}`)
    .map((part) => part.replace(/^\r?\n/, "").replace(/\r?\n$/, ""))
    .filter((part) => part.trim() && part.trim() !== "--" && !part.trim().startsWith("--"));
}

function htmlToText(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|table|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cleanDisplayText(text = "") {
  return String(text || "")
    .replace(/^--[-=_A-Za-z0-9.'+\/]+--?\s*$/gm, "")
    .replace(/^Content-(Type|Transfer-Encoding|Disposition|ID|Description):.*$/gim, "")
    .replace(/^MIME-Version:.*$/gim, "")
    .replace(/^charset=.*$/gim, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 20000);
}

function extractMimeContent(raw, inheritedHeaders = {}) {
  const hasHeaders = inheritedHeaders && Object.keys(inheritedHeaders).length > 0;
  const parsed = hasHeaders ? { headers: inheritedHeaders, body: String(raw || "") } : parseHeaders(raw);
  const type = contentMime(parsed.headers);
  const boundary = headerParam(parsed.headers["content-type"] || "", "boundary");

  if (type.startsWith("multipart/") && boundary) {
    const children = splitMultipart(parsed.body, boundary).map((part) => {
      const child = parseHeaders(part);
      return extractMimeContent(child.body, child.headers);
    });
    const text = children.find((p) => p.type === "text/plain" && p.text)?.text || children.find((p) => p.text)?.text || "";
    const html = children.find((p) => p.type === "text/html" && p.html)?.html || children.find((p) => p.html)?.html || "";
    return { type, text: text || htmlToText(html), html };
  }

  const decoded = decodeTransferBody(parsed.body, parsed.headers);
  if (type === "text/html") return { type, text: htmlToText(decoded), html: decoded };
  return { type, text: decoded, html: "" };
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function extractOtpCode(subject, body) {
  const hay = `${subject || ""}\n${body || ""}`;
  if (!/(sign[\s-]?in code|verification code|one[\s-]?time|login code|enter this code|otp|your code is|use (?:the |this )?code)/i.test(hay)) return null;
  const near = hay.match(/(?:code|otp|verification|sign[\s-]?in)[\s\S]{0,80}?\b(\d{4,8})\b/i);
  if (near?.[1]) return near[1];
  const line = hay.match(/^\s*(\d{4,8})\s*$/m);
  return line?.[1] || null;
}

function parseRawEmail(raw, accountLabel, uid) {
  const { headers, body } = parseHeaders(raw);
  const subject = decodeMimeWords(headers.subject || "");
  const from = decodeMimeWords(headers.from || "Netflix");
  const to = decodeMimeWords(headers.to || "");
  const content = extractMimeContent(body, headers);
  const bodyText = cleanDisplayText(content.text || htmlToText(content.html || body));
  const signal = `${subject} ${from} ${to} ${bodyText.slice(0, 2000)}`;
  if (!/netflix/i.test(signal)) return null;
  const date = headers.date ? new Date(headers.date) : new Date();
  const html = content.html && /<\w+/i.test(content.html) ? content.html : `<pre>${escapeHtml(bodyText)}</pre>`;
  return {
    id: `${accountLabel}:${uid}`,
    message_id: headers["message-id"] || null,
    subject,
    from: from || "Netflix",
    to: to || undefined,
    date: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    otp: extractOtpCode(subject, bodyText),
    preview: bodyText.length > 140 ? `${bodyText.slice(0, 140)}...` : bodyText,
    html,
    account_label: accountLabel,
  };
}

async function createImapConnection(account, timeoutMs = 3500) {
  const socket = connect({ hostname: account.host, port: account.port || 993 }, { secureTransport: "on" });
  await Promise.race([socket.opened, new Promise((_, reject) => setTimeout(() => reject(new Error("IMAP connect timeout")), timeoutMs))]);
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const readChunk = async (deadline) => {
    if (Date.now() > deadline) throw new Error("IMAP read timeout");
    const { value, done } = await reader.read();
    if (done) throw new Error("IMAP socket closed");
    buffer += decoder.decode(value, { stream: true });
  };
  const readLine = async (deadline) => {
    while (true) {
      const idx = buffer.indexOf("\r\n");
      if (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        return line;
      }
      await readChunk(deadline);
    }
  };
  const readBytes = async (n, deadline) => {
    while (buffer.length < n) await readChunk(deadline);
    const out = buffer.slice(0, n);
    buffer = buffer.slice(n);
    return out;
  };
  let tagNo = 1;
  const command = async (cmd, timeoutMs = 2500) => {
    const tag = `A${String(tagNo++).padStart(4, "0")}`;
    const deadline = Date.now() + timeoutMs;
    await writer.write(encoder.encode(`${tag} ${cmd}\r\n`));
    const lines = [];
    const literals = [];
    while (true) {
      const line = await readLine(deadline);
      lines.push(line);
      const lit = line.match(/\{(\d+)\}$/);
      if (lit) {
        const data = await readBytes(Number(lit[1]), deadline);
        literals.push({ meta: line, data });
      }
      if (line.startsWith(`${tag} `)) {
        if (!/^A\d+ OK/i.test(line)) throw new Error(line.replace(/^A\d+\s+/i, ""));
        return { lines, literals };
      }
    }
  };
  const close = async () => {
    try { await command("LOGOUT", 900); } catch {}
    try { writer.releaseLock(); } catch {}
    try { reader.releaseLock(); } catch {}
    try { await socket.close(); } catch {}
  };
  await readLine(Date.now() + timeoutMs);
  return { command, close };
}

async function decryptValue(encrypted, secret) {
  if (!encrypted?.startsWith?.("enc:")) return encrypted;
  const [, ivHex, ctHex] = encrypted.split(":");
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("imap-enc-salt-v1"), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const iv = new Uint8Array(ivHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const ct = new Uint8Array(ctHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

async function loadWorkerConfig(env) {
  const raw = await kvGet(env, WORKER_CONFIG_KEY);
  if (!raw) throw new Error("Worker inbox config missing. Save inbox settings in Admin Panel once.");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("bad config");
    return parsed;
  } catch {
    throw new Error("Worker inbox config is invalid. Save inbox settings in Admin Panel once.");
  }
}

async function loadAccounts(env, session, requestedLabels = []) {
  const settings = await loadWorkerConfig(env);
  const allowed = session?.role === "admin" ? null : Array.isArray(session?.assignedAccounts) ? session.assignedAccounts : [];
  const requested = requestedLabels.length > 0 ? requestedLabels.map(String).map(s => s.trim()).filter(Boolean) : null;
  const finalLabels = allowed === null
    ? requested
    : requested ? requested.filter(label => allowed.includes(label)) : allowed;
  if (Array.isArray(finalLabels) && finalLabels.length === 0) return [];

  const accounts = [];
  const emailAccounts = settings.email_accounts;
  const decryptSecret = env.SESSION_SIGNING_SECRET || env.SESSION_SECRET || env.ENCRYPTION_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY;
  if (!decryptSecret) throw new Error("Worker IMAP decrypt secret is missing");
  if (Array.isArray(emailAccounts)) {
    for (const acc of emailAccounts) {
      const label = String(acc.label || acc.user || "").trim();
      if (!label || (finalLabels && !finalLabels.includes(label))) continue;
      if (!acc.user || !acc.password) continue;
      accounts.push({
        label,
        host: acc.host || "imap.gmail.com",
        port: parseInt(acc.port) || 993,
        user: acc.user,
        password: await decryptValue(acc.password, decryptSecret),
      });
    }
  }
  const config = settings.config || {};
  if ((!finalLabels || finalLabels.includes("Primary")) && config.IMAP_USER && config.IMAP_PASSWORD && !accounts.some(a => a.user === config.IMAP_USER)) {
    accounts.unshift({
      label: "Primary",
      host: config.IMAP_HOST || "imap.gmail.com",
      port: parseInt(config.IMAP_PORT) || 993,
      user: config.IMAP_USER,
      password: await decryptValue(config.IMAP_PASSWORD, decryptSecret),
    });
  }
  return accounts;
}

async function fetchFromImapAccount(account, limit = 3) {
  const imap = await createImapConnection(account);
  try {
    await imap.command(`LOGIN ${imapQuote(account.user)} ${imapQuote(account.password)}`, 2500);
    const selected = await imap.command("SELECT INBOX", 2500);
    const existsLine = selected.lines.find(line => /\*\s+\d+\s+EXISTS/i.test(line));
    const total = Number(existsLine?.match(/\*\s+(\d+)\s+EXISTS/i)?.[1] || 0);
    const since = imapDate(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    let uids = [];
    try {
      const search = await imap.command(`UID SEARCH SINCE ${since} OR FROM ${imapQuote("netflix")} SUBJECT ${imapQuote("netflix")}`, 1800);
      const searchLine = search.lines.find(line => /^\* SEARCH/i.test(line)) || "";
      uids = searchLine.replace(/^\* SEARCH\s*/i, "").trim().split(/\s+/).filter(Boolean).map(Number).filter(Boolean);
    } catch {}

    let literals = [];
    if (uids.length > 0) {
      const newest = Array.from(new Set(uids)).sort((a, b) => b - a).slice(0, Math.max(1, limit));
      const fetched = await imap.command(`UID FETCH ${newest.join(",")} (BODY.PEEK[]<0.24000>)`, 2800);
      literals = fetched.literals;
    } else if (total > 0) {
      const start = Math.max(1, total - 3);
      const fetched = await imap.command(`FETCH ${start}:* (UID BODY.PEEK[]<0.24000>)`, 2800);
      literals = fetched.literals;
    }

    const emails = [];
    for (const item of literals) {
      const uid = Number(item.meta.match(/UID\s+(\d+)/i)?.[1] || 0) || Math.floor(Date.now() + Math.random() * 1000);
      const parsed = parseRawEmail(item.data, account.label, uid);
      if (parsed) emails.push(parsed);
    }
    emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return { emails: emails.slice(0, limit), fetched: emails.length, skipped: Math.max(0, literals.length - emails.length) };
  } finally {
    await imap.close();
  }
}

async function syncDirectFromAccounts(env, session, opts = {}) {
  if (!session) throw new Error("Authentication required");
  const accountLabels = Array.isArray(opts.accountLabels) ? opts.accountLabels : [];
  const limit = clampLimit(opts.limit, 3, 50);
  const accounts = await loadAccounts(env, session, accountLabels);
  if (accounts.length === 0) return { success: true, emails: [], stats: {}, totalFetched: 0, inserted: 0, source: "cloudflare-imap" };

  const settled = await Promise.allSettled(accounts.map(async (account) => ({ account, result: await fetchFromImapAccount(account, limit) })));
  const emails = [];
  const stats = {};
  const warnings = [];
  settled.forEach((item, index) => {
    const label = accounts[index]?.label || `Account ${index + 1}`;
    if (item.status === "fulfilled") {
      stats[label] = { fetched: item.value.result.fetched, skipped: item.value.result.skipped };
      emails.push(...item.value.result.emails);
    } else {
      const msg = item.reason?.message || String(item.reason || "IMAP failed");
      stats[label] = { fetched: 0, skipped: 0, error: msg };
      warnings.push(`${label}: ${msg}`);
    }
  });
  if (warnings.length === accounts.length) throw new Error(warnings.join(" | "));
  emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return { success: true, emails: emails.slice(0, Math.max(limit, 3)), stats, totalFetched: emails.length, inserted: emails.length, warnings, source: "cloudflare-imap" };
}

// --- IP helpers ---
function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === "::1" || ip === "127.0.0.1" || ip.startsWith("::ffff:127.")) return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.") || ip.startsWith("100.64.")) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  return false;
}
// Cloudflare's own IP ranges (Warp/proxy). If cf-connecting-ip returns one of these,
// the *real* user is likely behind Warp — but a forwarded IPv4 might still be better.
function isCloudflareIp(ip) {
  if (!ip) return false;
  if (ip.startsWith("2a06:98c") || ip.startsWith("2606:4700") || ip.startsWith("2803:f800")
    || ip.startsWith("2405:b500") || ip.startsWith("2405:8100") || ip.startsWith("2c0f:f248")
    || ip.startsWith("2a06:98d")) return true;
  // Common IPv4 CF ranges (partial list)
  if (/^(104\.16\.|104\.17\.|104\.18\.|104\.19\.|172\.6[4-7]\.|172\.68\.|172\.69\.|172\.70\.|172\.71\.|173\.245\.4[8-9]\.|173\.245\.5\d\.|103\.21\.244\.|103\.22\.200\.|103\.31\.4\.|141\.101\.6[4-9]\.|141\.101\.7\d\.|141\.101\.12[0-7]\.|108\.162\.19[2-9]\.|108\.162\.2\d\d\.|190\.93\.240\.|190\.93\.24[1-9]\.|190\.93\.25[0-5]\.|188\.114\.9[6-9]\.|197\.234\.240\.|198\.41\.12[8-9]\.|198\.41\.1[3-9]\d\.|198\.41\.2\d\d\.|162\.158\.)/.test(ip)) return true;
  return false;
}

function normalizeIp(raw) {
  if (!raw) return "";
  let ip = String(raw).trim().replace(/^"|"$/g, "");
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const bracket = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) return bracket[1].trim();
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");
  return ip.trim();
}

function isKnownEdgeIp(ip) {
  // AWS Global Accelerator / Vercel-style edge IPs often appear in XFF when the
  // request chain is browser → hosting/CDN → Supabase. They are not the user's ISP.
  return /^(13\.248\.|76\.223\.|75\.2\.)/.test(ip || "");
}

function isPublic(ip) {
  return !!ip && !isPrivateIp(ip);
}

function isRealPublicClientIp(ip) {
  return isPublic(ip) && !isCloudflareIp(ip) && !isKnownEdgeIp(ip);
}

// --- Proxy any Supabase edge function through the worker ---
async function handleFunctionProxy(request, env, fnName) {
  try {
    const body = await request.text();
    const sessionToken = request.headers.get("X-Session-Token") || request.headers.get("x-session-token");
    const pendingToken = request.headers.get("X-Pending-Token") || request.headers.get("x-pending-token");

    // Collect ALL possible client-IP signals, in preference order.
    const rawCandidates = [];
    const push = (label, val) => {
      const ip = normalizeIp(val);
      if (ip) rawCandidates.push({ label, ip });
    };
    push("cf-connecting-ip", request.headers.get("cf-connecting-ip"));
    push("true-client-ip", request.headers.get("true-client-ip"));
    push("x-real-ip", request.headers.get("x-real-ip"));
    const xff = request.headers.get("x-forwarded-for") || "";
    xff.split(",").forEach((p, i) => push(`xff[${i}]`, p));

    // Deduplicate while preserving order.
    const seen = new Set();
    const candidates = rawCandidates.filter(c => c.ip && !seen.has(c.ip) && seen.add(c.ip));

    // Selection priority: when traffic is really behind Cloudflare, CF-Connecting-IP
    // is the browser's visible client IP. Do not skip it in favor of an AWS/Vercel
    // X-Forwarded-For hop, because that is how Portland/edge IPs leaked into alerts.
    let selected = candidates.find(c => c.label === "cf-connecting-ip" && isRealPublicClientIp(c.ip))
      || candidates.find(c => c.label === "true-client-ip" && isRealPublicClientIp(c.ip))
      || candidates.find(c => c.label === "x-real-ip" && isRealPublicClientIp(c.ip))
      || candidates.find(c => c.label.startsWith("xff[") && isRealPublicClientIp(c.ip))
      || candidates.find(c => isRealPublicClientIp(c.ip));
    const clientIp = selected?.ip || "";
    const clientIpSource = selected?.label || "unknown";
    const cfCountry = request.headers.get("cf-ipcountry") || "";
    const cfRay = request.headers.get("cf-ray") || "";

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
    };
    if (sessionToken) headers["X-Session-Token"] = sessionToken;
    if (pendingToken) headers["X-Pending-Token"] = pendingToken;
    if (clientIp) headers["X-Client-IP"] = clientIp;
    const ua = request.headers.get("user-agent") || "";
    const acceptLanguage = request.headers.get("accept-language") || "";
    const chPlatform = request.headers.get("sec-ch-ua-platform") || "";
    if (ua) headers["X-Client-User-Agent"] = ua;
    if (acceptLanguage) headers["X-Client-Accept-Language"] = acceptLanguage;
    if (chPlatform) headers["X-Client-Platform"] = chPlatform;
    // Full trace (compact JSON) so backend can log & display which header we picked.
    try {
      headers["X-IP-Trace"] = JSON.stringify({
        selected: clientIp,
        selectedFrom: clientIpSource,
        cfCountry,
        cfRay,
        candidates: candidates.map(c => ({ h: c.label, ip: c.ip })),
      }).slice(0, 1800);
    } catch {}

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/${fnName}`, {
      method: "POST",
      headers,
      body,
    });

    const responseText = await res.text();

    return new Response(responseText, {
      status: res.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Proxy error: " + (err.message || "Unknown") }), {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}
