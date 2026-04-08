/**
 * Cloudflare Worker — Email Cache Proxy
 * 
 * Eliminates Supabase egress by caching email data in Cloudflare KV.
 * Users read from KV (free). Only this worker reads from Supabase (1 call per 10s max).
 * 
 * Environment Variables (set in Cloudflare dashboard):
 *   SUPABASE_URL  — e.g. https://xxxx.supabase.co
 *   SUPABASE_KEY  — anon/service key
 * 
 * KV Namespace Binding:
 *   EMAIL_CACHE   — bound in wrangler.toml
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const CACHE_KEY = "emails_list";
const CACHE_TIMESTAMP_KEY = "emails_timestamp";
const REFRESH_LOCK_KEY = "emails_refresh_lock";
const SYNC_LOCK_KEY = "emails_sync_lock";
const STALE_SECONDS = 10;
const SYNC_STALE_SECONDS = 300;
const LOCK_TTL_SECONDS = 30;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/emails" && request.method === "GET") {
      return handleGetEmails(env);
    }

    if (url.pathname === "/api/emails/sync" && request.method === "POST") {
      return handleSync(env);
    }

    // Debug endpoint — check if Supabase connection works
    if (url.pathname === "/api/debug" && request.method === "GET") {
      return handleDebug(env);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runSyncAndRefresh(env, "cron"));
  },
};

async function handleGetEmails(env) {
  // Check if KV is available
  if (!env.EMAIL_CACHE) {
    // No KV binding — fall through to Supabase directly
    return fetchDirectFromSupabase(env);
  }

  const [cached, timestamp] = await Promise.all([
    env.EMAIL_CACHE.get(CACHE_KEY),
    env.EMAIL_CACHE.get(CACHE_TIMESTAMP_KEY),
  ]);

  const now = Date.now();
  const age = timestamp ? (now - parseInt(timestamp)) / 1000 : Infinity;

  // If no cache at all (first load), await the refresh
  if (!cached) {
    await refreshFromSupabase(env);
    const freshData = await env.EMAIL_CACHE.get(CACHE_KEY);
    return new Response(freshData || "[]", {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "X-Cache-Age": "0" },
    });
  }

  // If stale, refresh in background
  if (age > STALE_SECONDS) {
    const refreshLock = await tryAcquireLock(env, REFRESH_LOCK_KEY, LOCK_TTL_SECONDS);
    if (refreshLock) {
      refreshFromSupabase(env).catch((err) => {
        console.error("Background cache-refresh failure:", err);
      });
    }
  }

  // If very stale, optionally trigger sync + refresh in the background
  if (age > SYNC_STALE_SECONDS) {
    const syncLock = await tryAcquireLock(env, SYNC_LOCK_KEY, LOCK_TTL_SECONDS);
    if (syncLock) {
      runSyncAndRefresh(env, "stale-cache").catch((err) => {
        console.error("Background sync failure:", err);
      });
    }
  }

  return new Response(cached, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "X-Cache-Age": Math.round(age).toString(),
    },
  });
}

async function handleSync(env) {
  try {
    await runSyncAndRefresh(env, "manual");

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Sync error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}

async function runSyncAndRefresh(env, source) {
  await callSupabaseSync(env, source);
  if (env.EMAIL_CACHE) {
    await refreshFromSupabase(env);
  }
}

async function callSupabaseSync(env, source) {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "apikey": env.SUPABASE_KEY,
      },
      body: JSON.stringify({ mode: "sync" }),
    });

    if (!res.ok) {
      console.error(
        `[SYNC FAILURE][${source}] Supabase sync failed with status ${res.status}:`,
        await res.text(),
      );
      throw new Error(`Supabase sync failed with status ${res.status}`);
    }
  } catch (err) {
    console.error(`[SYNC FAILURE][${source}] Sync request error:`, err);
    throw err;
  }
}

async function handleDebug(env) {
  const info = {
    has_supabase_url: !!env.SUPABASE_URL,
    supabase_url_preview: env.SUPABASE_URL ? env.SUPABASE_URL.substring(0, 30) + "..." : "NOT SET",
    has_supabase_key: !!env.SUPABASE_KEY,
    supabase_key_preview: env.SUPABASE_KEY ? env.SUPABASE_KEY.substring(0, 20) + "..." : "NOT SET",
    has_kv_binding: !!env.EMAIL_CACHE,
    timestamp: new Date().toISOString(),
  };

  // Try to fetch from Supabase
  try {
    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "apikey": env.SUPABASE_KEY,
      },
      body: JSON.stringify({ mode: "cache" }),
    });

    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }

    info.supabase_status = res.status;
    info.supabase_ok = res.ok;
    info.email_count = Array.isArray(parsed) ? parsed.length : "not_array";
    info.response_preview = typeof text === "string" ? text.substring(0, 200) : "N/A";
  } catch (err) {
    info.supabase_error = err.message;
  }

  // Check KV state
  if (env.EMAIL_CACHE) {
    try {
      const ts = await env.EMAIL_CACHE.get(CACHE_TIMESTAMP_KEY);
      const cached = await env.EMAIL_CACHE.get(CACHE_KEY);
      info.kv_timestamp = ts || "empty";
      info.kv_has_data = !!cached;
      info.kv_data_length = cached ? cached.length : 0;
      if (ts) {
        info.kv_age_seconds = Math.round((Date.now() - parseInt(ts)) / 1000);
      }
    } catch (err) {
      info.kv_error = err.message;
    }
  }

  return new Response(JSON.stringify(info, null, 2), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function fetchDirectFromSupabase(env) {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "apikey": env.SUPABASE_KEY,
      },
      body: JSON.stringify({ mode: "cache" }),
    });
    const data = await res.text();
    return new Response(data, {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "X-Cache": "bypass" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}

async function refreshFromSupabase(env) {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "apikey": env.SUPABASE_KEY,
      },
      body: JSON.stringify({ mode: "cache" }),
    });

    if (!res.ok) {
      console.error("[CACHE REFRESH FAILURE] Supabase cache fetch failed:", res.status, await res.text());
      return;
    }

    const data = await res.text();

    if (env.EMAIL_CACHE) {
      await Promise.all([
        env.EMAIL_CACHE.put(CACHE_KEY, data),
        env.EMAIL_CACHE.put(CACHE_TIMESTAMP_KEY, Date.now().toString()),
      ]);
      console.log("KV cache refreshed from Supabase");
    }
  } catch (err) {
    console.error("[CACHE REFRESH FAILURE] Refresh from Supabase error:", err);
  }
}

async function tryAcquireLock(env, lockKey, lockTtlSeconds) {
  if (!env.EMAIL_CACHE) return false;

  const existing = await env.EMAIL_CACHE.get(lockKey);
  if (existing) return false;

  await env.EMAIL_CACHE.put(lockKey, Date.now().toString(), {
    expirationTtl: lockTtlSeconds,
  });
  return true;
}
