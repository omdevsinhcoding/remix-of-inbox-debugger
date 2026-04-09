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
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token",
};

const CACHE_KEY = "emails_list";
const CACHE_TIMESTAMP_KEY = "emails_timestamp";
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

    if (sessionToken && env.SESSION_SECRET) {
      session = await verifySessionToken(sessionToken, env.SESSION_SECRET);
    }

    if ((url.pathname === "/api/emails" || url.pathname === "/api/emails/sync") && !session) {
      if (env.SESSION_SECRET) {
        return new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname === "/api/emails" && request.method === "GET") {
      return handleGetEmails(env, session, sessionToken);
    }

    if (url.pathname === "/api/emails/sync" && request.method === "POST") {
      let reqBody = {};
      try { reqBody = await request.clone().json(); } catch {}
      return handleSync(env, session, sessionToken, reqBody);
    }

    if (url.pathname === "/api/debug" && request.method === "GET") {
      return handleDebug(env);
    }

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

      // Fetch fresh cache to store
      const cacheRes = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
        method: "POST", headers, body: JSON.stringify({ mode: "cache" }),
      });

      if (cacheRes.ok) {
        const cacheData = await cacheRes.text();
        await Promise.all([
          kvPut(env, cacheKey, cacheData),
          kvPut(env, tsKey, Date.now().toString()),
        ]);
        console.log("[cron] Cache updated successfully");
      }
    } catch (err) {
      console.error("[cron] Error:", err);
    }
  },
};

async function handleGetEmails(env, session, rawToken) {
  const hasKV = !!getKV(env);

  if (!hasKV) {
    return fetchDirectFromSupabase(env, session, rawToken);
  }

  const userAccountsKey = session?.assignedAccounts ? JSON.stringify(session.assignedAccounts.sort()) : "all";
  const cacheKey = `${CACHE_KEY}:${userAccountsKey}`;
  const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;

  const [cached, timestamp] = await Promise.all([
    kvGet(env, cacheKey),
    kvGet(env, tsKey),
  ]);

  const now = Date.now();
  const age = timestamp ? (now - parseInt(timestamp)) / 1000 : Infinity;

  if (!cached) {
    const result = await fetchDirectFromSupabase(env, session, rawToken);
    if (result.status === 200) {
      const body = await result.clone().text();
      await Promise.all([
        kvPut(env, cacheKey, body),
        kvPut(env, tsKey, now.toString()),
      ]);
    }
    return result;
  }

  if (age > STALE_SECONDS) {
    await kvPut(env, tsKey, now.toString());
    refreshFromSupabase(env, session, rawToken, cacheKey, tsKey).catch(err => console.error("BG refresh error:", err));
  }

  return new Response(cached, {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "X-Cache-Age": Math.round(age).toString() },
  });
}

async function handleSync(env, session, rawToken, requestBody) {
  try {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
    };
    if (rawToken) headers["X-Session-Token"] = rawToken;

    // Pass through accountLabels from the request body for per-account routing
    const syncPayload = { mode: "sync" };
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

    // Update KV cache after successful sync
    if (getKV(env)) {
      const userAccountsKey = session?.assignedAccounts ? JSON.stringify(session.assignedAccounts.sort()) : "all";
      const cacheKey = `${CACHE_KEY}:${userAccountsKey}`;
      const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;

      // Fetch fresh cache data since sync response may contain extra metadata
      await refreshFromSupabase(env, session, rawToken, cacheKey, tsKey);
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

async function handleDebug(env) {
  const info = {
    has_supabase_url: !!env.SUPABASE_URL,
    has_supabase_key: !!env.SUPABASE_KEY,
    has_session_secret: !!env.SESSION_SECRET,
    has_kv_v1: !!env.EMAIL_CACHE,
    has_kv_v2: !!env.EMAIL_CACHE_V2,
    active_kv: env.EMAIL_CACHE_V2 ? "V2" : env.EMAIL_CACHE ? "V1" : "none",
    timestamp: new Date().toISOString(),
  };
  return new Response(JSON.stringify(info, null, 2), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function fetchDirectFromSupabase(env, session, rawToken) {
  try {
    const bodyPayload = { mode: "cache" };
    if (session?.assignedAccounts) {
      bodyPayload.accountLabels = session.assignedAccounts;
    }

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
    };
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

async function refreshFromSupabase(env, session, rawToken, cacheKey, tsKey) {
  try {
    const bodyPayload = { mode: "cache" };
    if (session?.assignedAccounts) {
      bodyPayload.accountLabels = session.assignedAccounts;
    }

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
    };
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

// --- Proxy any Supabase edge function through the worker ---
async function handleFunctionProxy(request, env, fnName) {
  try {
    const body = await request.text();
    const sessionToken = request.headers.get("X-Session-Token") || request.headers.get("x-session-token");

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
    };
    if (sessionToken) headers["X-Session-Token"] = sessionToken;

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
