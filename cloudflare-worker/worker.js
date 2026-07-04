/**
 * Cloudflare Worker — Email Cache Proxy
 * 
 * Features:
 * - Validates session tokens (HMAC-SHA256)
 * - Multi-KV namespace support (EMAIL_CACHE_V2 -> EMAIL_CACHE fallback)
 * - Supabase fetch-emails proxy + KV cache support
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

// Keep the original unversioned keys so already-cached worker emails remain visible.
const CACHE_SCHEMA_VERSION = "classic";
const LEGACY_CACHE_SCHEMA_VERSIONS = ["v3", "v2", "v1"];
const CACHE_KEY = "emails_list";
const CACHE_TIMESTAMP_KEY = "emails_timestamp";
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

function hasRawMimeMarkers(raw) {
  return /Content-Transfer-Encoding|quoted-printable|MIME-Version:|Content-Type:|=_Part_|--[A-Za-z0-9'_()+,./:=?-]{8,}/i.test(String(raw || ""));
}

function cachePrefixes() {
  return [
    { list: CACHE_KEY, ts: CACHE_TIMESTAMP_KEY },
    ...LEGACY_CACHE_SCHEMA_VERSIONS.map((version) => ({ list: `emails_list:${version}`, ts: `emails_timestamp:${version}` })),
  ];
}

function candidateCacheKeys(userAccountsKey, limit) {
  return cachePrefixes().flatMap(({ list }) => [
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
  ]).filter((key, index, arr) => arr.indexOf(key) === index);
}

async function readBestCachedRaw(env, userAccountsKey, limit, skipKey = "") {
  for (const key of candidateCacheKeys(userAccountsKey, limit)) {
    if (key === skipKey) continue;
    const raw = await kvGet(env, key);
    if (raw) return { key, raw };
  }
  return null;
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

    // Session auth is OPTIONAL. If this worker has SESSION_SIGNING_SECRET set
    // AND the request came with a token that failed to verify → reject.
    // If no secret is configured on this worker, allow through (legacy mode)
    // so new workers can be spun up without matching secrets everywhere.
    if ((url.pathname === "/api/emails" || url.pathname === "/api/emails/sync") && !session) {
      if (hasSigning && sessionToken) {
        return new Response(JSON.stringify({ error: "Invalid session" }), {
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




    // Immutable-HTML cache: single most impactful egress cut. Email HTML never
    // changes after IMAP ingest, so we can KV-cache forever. Authz enforced
    // via session.assignedAccounts / role on cache HIT; MISS forwards to
    // Supabase manage-app (X-Cron-Secret marks trusted-proxy for plaintext).
    if (url.pathname === "/api/inbox/html" && request.method === "POST") {
      return handleInboxHtml(request, env, session, sessionToken, ctx);
    }




    // Proxy manage-app and other edge functions through worker
    if (url.pathname.startsWith("/api/fn/") && request.method === "POST") {
      const fnName = url.pathname.replace("/api/fn/", "");
      return handleFunctionProxy(request, env, fnName);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },

  // Cron/scheduled handler — same as the uploaded worker: proxy sync to Supabase, then refresh KV.
  async scheduled(event, env, ctx) {
    console.log("[cron] Scheduled sync triggered at", new Date().toISOString());
    try {
      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "apikey": env.SUPABASE_KEY,
        ...(env.CRON_SHARED_SECRET ? { "X-Cron-Secret": env.CRON_SHARED_SECRET } : {}),
      };

      const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mode: "sync", source: "cron" }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("[cron] Sync failed:", res.status, text);
        return;
      }

      const cacheRes = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mode: "cache" }),
      });

      if (cacheRes.ok) {
        const cacheData = await cacheRes.text();
        await Promise.all([
          kvPut(env, `${CACHE_KEY}:all`, cacheData),
          kvPut(env, `${CACHE_TIMESTAMP_KEY}:all`, Date.now().toString()),
        ]);
        console.log("[cron] Cache updated successfully");
      }
    } catch (err) {
      console.error("[cron] Error:", err);
    }
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
    return fetchDirectFromSupabase(env, session, rawToken, { accountLabels, limit });
  }

  const scopedLabels = accountLabels.length > 0 ? accountLabels : (session?.assignedAccounts || []);
  const userAccountsKey = scopedLabels.length > 0 ? JSON.stringify([...scopedLabels].sort()) : "all";
  const cacheKey = `${CACHE_KEY}:${userAccountsKey}:limit:${limit}`;
  const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;

  // bust=1 → skip KV read, reload the existing Supabase cache, write back, return with BYPASS status.
  if (bust) {
    const result = await fetchDirectFromSupabase(env, session, rawToken, { accountLabels, limit });
    if (result.status === 200) {
      const body = await result.clone().text();
      await Promise.all([kvPut(env, cacheKey, body), kvPut(env, tsKey, Date.now().toString())]);
      return new Response(body, { status: 200, headers: diagHeaders({ "X-Cache-Status": "BYPASS", "X-Cache-Key": cacheKey }) });
    }
    return result;
  }

  const [cached, timestamp] = await Promise.all([kvGet(env, cacheKey), kvGet(env, tsKey)]);
  const now = Date.now();
  const age = timestamp ? (now - parseInt(timestamp)) / 1000 : Infinity;

  if (!cached) {
    const fallback = await readBestCachedRaw(env, userAccountsKey, limit, cacheKey);
    if (fallback?.raw) {
      await Promise.all([kvPut(env, cacheKey, fallback.raw), kvPut(env, tsKey, Date.now().toString())]);
      if (hasRawMimeMarkers(fallback.raw)) {
        const result = await fetchDirectFromSupabase(env, session, rawToken, { accountLabels, limit });
        if (result.status === 200) {
          const body = await result.clone().text();
          await Promise.all([kvPut(env, cacheKey, body), kvPut(env, tsKey, Date.now().toString())]);
          return new Response(body, { status: 200, headers: diagHeaders({ "X-Cache-Status": "BYPASS_RAW_MIME", "X-Cache-Key": cacheKey }) });
        }
      }
      return new Response(fallback.raw, { headers: diagHeaders({ "X-Cache-Status": "FALLBACK_HIT", "X-Cache-Key": fallback.key }) });
    }
    const result = await fetchDirectFromSupabase(env, session, rawToken, { accountLabels, limit });
    if (result.status === 200) {
      const body = await result.clone().text();
      await Promise.all([kvPut(env, cacheKey, body), kvPut(env, tsKey, now.toString())]);
    }
    return result;
  }

  let status = "HIT";
  if (age > STALE_SECONDS) {
    status = "STALE";
    refreshFromSupabase(env, session, rawToken, cacheKey, tsKey, { accountLabels, limit }).catch(err => console.error("BG refresh error:", err));
  }

  if (hasRawMimeMarkers(cached)) {
    const result = await fetchDirectFromSupabase(env, session, rawToken, { accountLabels, limit });
    if (result.status === 200) {
      const body = await result.clone().text();
      await Promise.all([kvPut(env, cacheKey, body), kvPut(env, tsKey, Date.now().toString())]);
      return new Response(body, {
        headers: diagHeaders({ "X-Cache-Status": "BYPASS_RAW_MIME", "X-Cache-Age": Math.round(age).toString(), "X-Cache-Key": cacheKey }),
      });
    }
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
  const keys = candidateCacheKeys(userAccountsKey, 200);
  const tsKeys = cachePrefixes().map(({ ts }) => `${ts}:${userAccountsKey}`);
  try {
    await Promise.all([...keys, ...tsKeys].map((key) => kv.delete(key)));
    return new Response(JSON.stringify({ ok: true, purged: keys.length + tsKeys.length, keys }), { headers: diagHeaders({ "X-Cache-Status": "PURGED" }) });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500, headers: diagHeaders() });
  }
}

async function handleSync(env, session, rawToken, requestBody, ctx) {
  try {
    const limit = clampLimit(requestBody?.limit, 3, 50);
    const requestedLabels = Array.isArray(requestBody?.accountLabels) ? requestBody.accountLabels : [];
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
    };
    if (rawToken) headers["X-Session-Token"] = rawToken;

    const syncPayload = {
      mode: requestBody?.mode || "sync",
      source: requestBody?.source || "worker",
      limit,
    };
    if (requestedLabels.length > 0) syncPayload.accountLabels = requestedLabels;

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST",
      headers,
      body: JSON.stringify(syncPayload),
    });
    const responseText = await res.text();

    if (!res.ok) {
      let errorMsg = "Sync failed";
      try {
        const parsed = JSON.parse(responseText);
        errorMsg = parsed?.error || errorMsg;
      } catch {}
      return new Response(JSON.stringify({ success: false, error: errorMsg }), {
        status: res.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Update KV cache after successful sync without blocking the user response.
    if (getKV(env)) {
      const scopedLabels = requestedLabels.length > 0 ? requestedLabels : (session?.assignedAccounts || []);
      const userAccountsKey = scopedLabels.length > 0 ? JSON.stringify([...scopedLabels].sort()) : "all";
      const cacheKey = `${CACHE_KEY}:${userAccountsKey}:limit:${limit}`;
      const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;

      const cacheWork = refreshFromSupabase(env, session, rawToken, cacheKey, tsKey, { accountLabels: requestedLabels, limit })
        .catch((err) => console.error("[sync] async KV update failed:", err.message || err));
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


async function fetchDirectFromSupabase(env, session, rawToken, opts = {}) {
  try {
    const accountLabels = Array.isArray(opts.accountLabels) ? opts.accountLabels : [];
    const bodyPayload = { mode: "cache", limit: clampLimit(opts.limit, 500, 500) };
    if (accountLabels.length > 0) bodyPayload.accountLabels = accountLabels;
    else if (session?.assignedAccounts) bodyPayload.accountLabels = session.assignedAccounts;

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
    };
    if (rawToken) headers["X-Session-Token"] = rawToken;

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyPayload),
    });

    const data = await res.text();
    return new Response(data, {
      status: res.status,
      headers: diagHeaders({ "X-Cache-Status": "BYPASS" }),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Worker cannot reach backend: " + (err.message || "Unknown") }), {
      status: 502,
      headers: diagHeaders(),
    });
  }
}

async function refreshFromSupabase(env, session, rawToken, cacheKey, tsKey, opts = {}) {
  try {
    const result = await fetchDirectFromSupabase(env, session, rawToken, opts);
    if (!result.ok) {
      console.error("Supabase cache fetch failed:", result.status);
      return;
    }
    const data = await result.text();
    await Promise.all([
      kvPut(env, cacheKey, data),
      kvPut(env, tsKey, Date.now().toString()),
    ]);
  } catch (err) {
    console.error("Refresh from Supabase error:", err);
  }
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

// ------------------------------------------------------------------
// Email HTML cache — 1 year TTL (immutable content)
// ------------------------------------------------------------------
// Only requires: SUPABASE_URL + SUPABASE_KEY (anon).
// All auth is delegated to the dedicated `email-html` Supabase edge function
// which verifies session tokens internally.
//
// KV key:  email_html:v1:<emailId> → JSON { html, account_label, at }
// Flow:
//   - HIT:  send a tiny authz_only=true request to Supabase (~80 byte
//           response). If allowed, serve cached HTML from Cloudflare edge.
//   - MISS: full request to Supabase, cache 1 year, return.
//
// User impact: none. Emails render identically. Egress drops ~95% because the
// heavy HTML body (50–500 KB) only leaves Supabase on the first-ever open.

const EMAIL_HTML_KEY_PREFIX = "email_html:v1:";
const EMAIL_HTML_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year
const EMAIL_HTML_FUNCTION = "email-html";

function inboxHtmlHeaders(extra = {}) {
  return {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Expose-Headers": "X-Cache-Status, X-Cache-Age",
    ...extra,
  };
}

async function callEmailHtmlFn(env, rawToken, payload) {
  const res = await fetch(`${env.SUPABASE_URL}/functions/v1/${EMAIL_HTML_FUNCTION}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
      "X-Session-Token": rawToken || "",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, text, json };
}

async function handleInboxHtml(request, env, _session, rawToken, ctx) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
    return new Response(JSON.stringify({ success: false, error: "Worker not configured (SUPABASE_URL/KEY missing)" }), {
      status: 500, headers: inboxHtmlHeaders(),
    });
  }
  if (!rawToken) {
    return new Response(JSON.stringify({ success: false, error: "session required" }), {
      status: 401, headers: inboxHtmlHeaders(),
    });
  }

  let body = null;
  try { body = await request.json(); } catch {}
  const id = body && typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return new Response(JSON.stringify({ success: false, error: "id required" }), {
      status: 400, headers: inboxHtmlHeaders(),
    });
  }

  const kv = getKV(env);
  const cacheKey = `${EMAIL_HTML_KEY_PREFIX}${id}`;

  // ---- Cache lookup ----
  if (kv) {
    const raw = await kvGet(env, cacheKey);
    if (raw) {
      let cached = null;
      try { cached = JSON.parse(raw); } catch { cached = null; }
      if (cached && typeof cached.html === "string" && cached.html.length > 0) {
        // Tiny authz check — Supabase verifies session + assigned_accounts.
        // Response is ~80 bytes vs 50-500 KB of HTML. Massive egress win.
        const authz = await callEmailHtmlFn(env, rawToken, { id, authz_only: true });
        if (authz.ok && authz.json?.success && authz.json?.allowed) {
          const age = cached.at ? Math.max(0, Math.round((Date.now() - cached.at) / 1000)) : 0;
          return new Response(
            JSON.stringify({ success: true, id, html: cached.html, account_label: cached.account_label || "" }),
            { headers: inboxHtmlHeaders({ "X-Cache-Status": "HIT", "X-Cache-Age": String(age) }) },
          );
        }
        if (authz.status === 401 || authz.status === 403) {
          return new Response(authz.text || JSON.stringify({ success: false, error: "Not authorized" }), {
            status: authz.status, headers: inboxHtmlHeaders({ "X-Cache-Status": "HIT_DENY" }),
          });
        }
        // Any other error → fall through to full MISS path.
      }
    }
  }

  // ---- Cache miss: fetch full HTML from Supabase ----

  try {
    const upstream = await callEmailHtmlFn(env, rawToken, { id });
    if (!upstream.ok) {
      return new Response(upstream.text || JSON.stringify({ success: false, error: "upstream error" }), {
        status: upstream.status,
        headers: inboxHtmlHeaders({ "X-Cache-Status": "MISS_ERR" }),
      });
    }
    if (upstream.json?.success && typeof upstream.json?.html === "string" && upstream.json.html.length > 0 && kv) {
      const payload = {
        html: upstream.json.html,
        account_label: upstream.json.account_label || "",
        at: Date.now(),
      };
      const writeWork = (async () => {
        try {
          const primaryKV = env.EMAIL_CACHE_V2 || env.EMAIL_CACHE;
          if (primaryKV) {
            await primaryKV.put(cacheKey, JSON.stringify(payload), { expirationTtl: EMAIL_HTML_TTL_SECONDS });
          }
        } catch (err) {
          console.error("[inbox-html] KV write failed:", err.message || err);
        }
      })();
      if (ctx?.waitUntil) ctx.waitUntil(writeWork); else await writeWork;
    }
    return new Response(upstream.text, {
      status: 200,
      headers: inboxHtmlHeaders({ "X-Cache-Status": "MISS" }),
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: "Worker upstream failed: " + (err.message || "Unknown") }), {
      status: 502, headers: inboxHtmlHeaders({ "X-Cache-Status": "MISS_ERR" }),
    });
  }
}
