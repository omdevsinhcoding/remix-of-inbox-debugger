/**
 * Cloudflare Worker — Email Cache Proxy
 * 
 * Features:
 * - Validates session tokens (HMAC-SHA256)
 * - Multi-KV namespace support (EMAIL_CACHE_V2 -> EMAIL_CACHE fallback)
 * - Cron/scheduled sync support
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
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token, X-Pending-Token, X-Cron-Secret, Cache-Control",
};

// F7: Bump CACHE_SCHEMA_VERSION whenever the shape of cached email JSON
// changes, or to force every worker/user to drop old snapshots on the next
// read. Version is baked into every KV key so old entries become unreachable
// (and expire naturally) without needing a manual purge.
const CACHE_SCHEMA_VERSION = "v3";
const CACHE_KEY = `emails_list:${CACHE_SCHEMA_VERSION}`;
const CACHE_TIMESTAMP_KEY = `emails_timestamp:${CACHE_SCHEMA_VERSION}`;
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
  async fetch(request, env) {
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
      const limit = clampLimit(url.searchParams.get("limit"), 3, 50);
      const accountLabels = url.searchParams.getAll("accountLabel").map(v => v.trim()).filter(Boolean);
      return handleGetEmails(env, session, sessionToken, { bust, limit, accountLabels });
    }

    if (url.pathname === "/api/emails/sync" && request.method === "POST") {
      let reqBody = {};
      try { reqBody = await request.clone().json(); } catch {}
      return handleSync(env, session, sessionToken, reqBody);
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
    console.log("[cron] Scheduled sync triggered at", new Date().toISOString());
    try {
      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "apikey": env.SUPABASE_KEY,
      };
      if (env.CRON_SHARED_SECRET) headers["X-Cron-Secret"] = env.CRON_SHARED_SECRET;

      const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
        method: "POST", headers, body: JSON.stringify({ mode: "sync" }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("[cron] Sync failed:", res.status, text);
        return;
      }

      const data = await res.text();
      console.log("[cron] Sync completed, updating cache");

      // Update cache for "all" users
      const cacheKey = `${CACHE_KEY}:all`;
      const tsKey = `${CACHE_TIMESTAMP_KEY}:all`;

      // Cache reads are session-protected now; users refresh their own scoped cache on next open.
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
  const limit = clampLimit(opts.limit, 3, 50);
  const accountLabels = Array.isArray(opts.accountLabels) ? opts.accountLabels : [];

  if (!hasKV) {
    const r = await fetchDirectFromSupabase(env, session, rawToken, limit, accountLabels);
    // wrap so we keep diag headers
    const body = await r.clone().text();
    return new Response(body, { status: r.status, headers: diagHeaders({ "X-Cache-Status": "NO_KV" }) });
  }

  const scopedLabels = accountLabels.length > 0 ? accountLabels : (session?.assignedAccounts || []);
  const userAccountsKey = scopedLabels.length > 0 ? JSON.stringify([...scopedLabels].sort()) : "all";
  const cacheKey = `${CACHE_KEY}:${userAccountsKey}:limit:${limit}`;
  const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;

  // F7: bust=1 → skip KV read, refetch fresh, write back, return with BYPASS status.
  if (bust) {
    const result = await fetchDirectFromSupabase(env, session, rawToken, limit, accountLabels);
    if (result.status === 200) {
      const body = await result.clone().text();
      await Promise.all([kvPut(env, cacheKey, body), kvPut(env, tsKey, Date.now().toString())]);
      return new Response(body, { status: 200, headers: diagHeaders({ "X-Cache-Status": "BYPASS", "X-Cache-Key": cacheKey }) });
    }
    const body = await result.clone().text();
    return new Response(body, { status: result.status, headers: diagHeaders({ "X-Cache-Status": "BYPASS_ERR", "X-Cache-Key": cacheKey }) });
  }

  const [cached, timestamp] = await Promise.all([kvGet(env, cacheKey), kvGet(env, tsKey)]);
  const now = Date.now();
  const age = timestamp ? (now - parseInt(timestamp)) / 1000 : Infinity;

  if (!cached) {
    const result = await fetchDirectFromSupabase(env, session, rawToken, limit, accountLabels);
    if (result.status === 200) {
      const body = await result.clone().text();
      await Promise.all([kvPut(env, cacheKey, body), kvPut(env, tsKey, now.toString())]);
      return new Response(body, { status: 200, headers: diagHeaders({ "X-Cache-Status": "MISS", "X-Cache-Key": cacheKey }) });
    }
    return result;
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

async function handleSync(env, session, rawToken, requestBody) {
  try {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
    };
    if (env.CRON_SHARED_SECRET) headers["X-Cron-Secret"] = env.CRON_SHARED_SECRET;
    if (rawToken) headers["X-Session-Token"] = rawToken;

    // Pass through accountLabels from the request body for per-account routing
      const limit = clampLimit(requestBody?.limit, 3, 50);
      const requestedMode = requestBody?.mode === "sync" ? "sync" : requestBody?.mode === "user_sync" ? "user_sync" : "sync_async";
      const syncPayload = { mode: requestedMode, source: requestBody?.source || "worker", limit };
    if (requestBody?.accountLabels && Array.isArray(requestBody.accountLabels)) {
      syncPayload.accountLabels = requestBody.accountLabels;
    }

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST", headers, body: JSON.stringify(syncPayload),
    });

    const responseText = await res.text();

    if (!res.ok) {
      let errorMsg = "Sync failed";
      try {
        const parsed = JSON.parse(responseText);
        errorMsg = parsed?.error || errorMsg;
      } catch {}
      return new Response(JSON.stringify({ success: false, error: errorMsg }), {
        status: res.status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (res.status === 202) {
      if (getKV(env)) {
        const userAccountsKey = session?.assignedAccounts ? JSON.stringify(session.assignedAccounts.sort()) : "all";
        await Promise.all([
          kvPut(env, `${CACHE_KEY}:${userAccountsKey}:limit:${limit}`, JSON.stringify(JSON.parse(responseText).emails || [])),
          kvPut(env, `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`, Date.now().toString()),
        ]).catch(() => {});
      }
      return new Response(responseText, {
        status: 202,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Update KV cache after successful sync
    if (getKV(env)) {
      const userAccountsKey = session?.assignedAccounts ? JSON.stringify(session.assignedAccounts.sort()) : "all";
      const cacheKey = `${CACHE_KEY}:${userAccountsKey}:limit:${limit}`;
      const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;

      // Fetch fresh cache data since sync response may contain extra metadata
      await refreshFromSupabase(env, session, rawToken, cacheKey, tsKey, limit);
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


async function fetchDirectFromSupabase(env, session, rawToken, limit = 3, accountLabels = []) {
  try {
    const bodyPayload = { mode: "cache", limit: clampLimit(limit, 3, 50) };
    if (Array.isArray(accountLabels) && accountLabels.length > 0) {
      bodyPayload.accountLabels = accountLabels;
    } else if (session?.assignedAccounts) {
      bodyPayload.accountLabels = session.assignedAccounts;
    }

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
    };
    if (env.CRON_SHARED_SECRET) headers["X-Cron-Secret"] = env.CRON_SHARED_SECRET;
    if (rawToken) headers["X-Session-Token"] = rawToken;

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST", headers, body: JSON.stringify(bodyPayload),
    });

    const data = await res.text();

    return new Response(data, {
      status: res.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "X-Cache": "bypass" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Worker cannot reach backend: " + err.message }), {
      status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}

async function refreshFromSupabase(env, session, rawToken, cacheKey, tsKey, limit = 3) {
  try {
    const bodyPayload = { mode: "cache", limit: clampLimit(limit, 3, 50) };
    if (session?.assignedAccounts) {
      bodyPayload.accountLabels = session.assignedAccounts;
    }

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
    };
    if (env.CRON_SHARED_SECRET) headers["X-Cron-Secret"] = env.CRON_SHARED_SECRET;
    if (rawToken) headers["X-Session-Token"] = rawToken;

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST", headers, body: JSON.stringify(bodyPayload),
    });

    if (!res.ok) {
      console.error("Supabase cache fetch failed:", res.status);
      return;
    }

    const data = await res.text();
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
