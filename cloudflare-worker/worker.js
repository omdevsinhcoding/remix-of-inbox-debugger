/**
 * Cloudflare Worker — Email Cache Proxy (Security Hardened)
 * 
 * - Validates session tokens (HMAC-SHA256)
 * - Passes user's assigned accounts to backend
 * - Forwards real errors instead of masking them
 * 
 * Environment Variables:
 *   SUPABASE_URL, SUPABASE_KEY, SESSION_SECRET
 * 
 * KV Namespace Binding:
 *   EMAIL_CACHE
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token",
};

const CACHE_KEY = "emails_list";
const CACHE_TIMESTAMP_KEY = "emails_timestamp";
const STALE_SECONDS = 3;

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

  if (!existingEmails || !incomingEmails) {
    return null;
  }

  const emailMap = new Map();
  for (const email of [...incomingEmails, ...existingEmails]) {
    if (email?.id) {
      emailMap.set(email.id, email);
    }
  }

  return JSON.stringify(
    Array.from(emailMap.values()).sort(
      (a, b) => new Date(b?.date || 0).getTime() - new Date(a?.date || 0).getTime()
    )
  );
}


export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    // Get the raw session token from the request header (forward as-is)
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
      return handleSync(env, session, sessionToken);
    }

    if (url.pathname === "/api/debug" && request.method === "GET") {
      return handleDebug(env);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
};

async function handleGetEmails(env, session, rawToken) {
  if (!env.EMAIL_CACHE) {
    return fetchDirectFromSupabase(env, session, rawToken);
  }

  const userAccountsKey = session?.assignedAccounts ? JSON.stringify(session.assignedAccounts.sort()) : "all";
  const cacheKey = `${CACHE_KEY}:${userAccountsKey}`;
  const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;

  const [cached, timestamp] = await Promise.all([
    env.EMAIL_CACHE.get(cacheKey),
    env.EMAIL_CACHE.get(tsKey),
  ]);

  const now = Date.now();
  const age = timestamp ? (now - parseInt(timestamp)) / 1000 : Infinity;

  if (!cached) {
    // No cache — fetch directly and return real result (including errors)
    const result = await fetchDirectFromSupabase(env, session, rawToken);
    // Also populate cache if successful
    if (result.status === 200) {
      const body = await result.clone().text();
      if (env.EMAIL_CACHE) {
        await Promise.all([
          env.EMAIL_CACHE.put(cacheKey, body),
          env.EMAIL_CACHE.put(tsKey, now.toString()),
        ]);
      }
    }
    return result;
  }

  if (age > STALE_SECONDS) {
    await env.EMAIL_CACHE.put(tsKey, now.toString());
    refreshFromSupabase(env, session, rawToken, cacheKey, tsKey).catch(err => console.error("BG refresh error:", err));
  }

  return new Response(cached, {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "X-Cache-Age": Math.round(age).toString() },
  });
}

async function handleSync(env, session, rawToken) {
  try {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
    };
    // Forward the raw signed session token so backend can verify it
    if (rawToken) {
      headers["X-Session-Token"] = rawToken;
    }

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST", headers, body: JSON.stringify({ mode: "sync" }),
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

    if (env.EMAIL_CACHE) {
      const userAccountsKey = session?.assignedAccounts ? JSON.stringify(session.assignedAccounts.sort()) : "all";
      const cacheKey = `${CACHE_KEY}:${userAccountsKey}`;
      const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;
      const existingCached = await env.EMAIL_CACHE.get(cacheKey);
      const mergedPayload = mergeEmailPayloads(existingCached, responseText);

      if (mergedPayload) {
        await Promise.all([
          env.EMAIL_CACHE.put(cacheKey, mergedPayload),
          env.EMAIL_CACHE.put(tsKey, Date.now().toString()),
        ]);
      } else {
        await refreshFromSupabase(env, session, rawToken, cacheKey, tsKey);
      }
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
    has_kv_binding: !!env.EMAIL_CACHE,
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
    // Forward the real signed token
    if (rawToken) {
      headers["X-Session-Token"] = rawToken;
    }

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST", headers, body: JSON.stringify(bodyPayload),
    });

    const data = await res.text();

    if (!res.ok) {
      // Return real error instead of masking it
      return new Response(data, {
        status: res.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json", "X-Cache": "bypass" },
      });
    }

    return new Response(data, {
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
    if (rawToken) {
      headers["X-Session-Token"] = rawToken;
    }

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST", headers, body: JSON.stringify(bodyPayload),
    });

    if (!res.ok) {
      console.error("Supabase cache fetch failed:", res.status);
      return;
    }

    const data = await res.text();

    if (env.EMAIL_CACHE) {
      await Promise.all([
        env.EMAIL_CACHE.put(cacheKey, data),
        env.EMAIL_CACHE.put(tsKey, Date.now().toString()),
      ]);
    }
  } catch (err) {
    console.error("Refresh from Supabase error:", err);
  }
}
