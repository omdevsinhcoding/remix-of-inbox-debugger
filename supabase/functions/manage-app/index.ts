import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticator } from "npm:otplib@12.0.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token, x-pending-token, x-client-ip",
};

// --- Crypto helpers ---
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$2")) return password === stored;
  if (!stored.startsWith("pbkdf2:")) return password === stored;
  const [, saltHex, hashHex] = stored.split(":");
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  const computedHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  return computedHex === hashHex;
}

// --- Session Token (HMAC-SHA256) ---
async function createSessionToken(payload: Record<string, any>, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = JSON.stringify(payload);
  const dataB64 = btoa(data);
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(dataB64));
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${dataB64}.${sigHex}`;
}

async function verifySessionToken(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- AES-256-GCM encryption for IMAP credentials ---
async function deriveEncKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("imap-enc-salt-v1"), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptValue(plaintext: string, secret: string): Promise<string> {
  const key = await deriveEncKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join("");
  const ctHex = Array.from(new Uint8Array(ciphertext)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `enc:${ivHex}:${ctHex}`;
}

async function decryptValue(encrypted: string, secret: string): Promise<string> {
  if (!encrypted.startsWith("enc:")) return encrypted; // plain text fallback
  const [, ivHex, ctHex] = encrypted.split(":");
  const key = await deriveEncKey(secret);
  const iv = new Uint8Array(ivHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const ct = new Uint8Array(ctHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

// --- Audit logging ---
async function auditLog(supabase: any, action: string, actorId: string | null, targetId: string | null, details: any, ip: string) {
  try {
    await supabase.from("audit_logs").insert({ action, actor_id: actorId, target_id: targetId, details, ip });
  } catch (e) { console.error("Audit log error:", e); }
}

function isPrivateIp(ip: string): boolean {
  if (!ip || ip === "unknown") return true;
  if (ip === "::1" || ip === "127.0.0.1" || ip.startsWith("::ffff:127.")) return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.") || ip.startsWith("100.64.")) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  return false;
}

// Cloudflare's own proxy/Warp ranges. Prefer non-CF candidates when available.
function isCloudflareIp(ip: string): boolean {
  if (!ip) return false;
  if (ip.startsWith("2a06:98c") || ip.startsWith("2606:4700") || ip.startsWith("2803:f800")
    || ip.startsWith("2405:b500") || ip.startsWith("2405:8100") || ip.startsWith("2c0f:f248")
    || ip.startsWith("2a06:98d")) return true;
  if (/^(104\.1[6-9]\.|172\.6[4-9]\.|172\.7[01]\.|173\.245\.[45]\d\.|103\.21\.244\.|103\.22\.200\.|103\.31\.4\.|141\.101\.(6[4-9]|7\d|12[0-7])\.|108\.162\.(19[2-9]|2\d\d)\.|190\.93\.(240|24[1-9]|25[0-5])\.|188\.114\.9[6-9]\.|197\.234\.240\.|198\.41\.(12[8-9]|1[3-9]\d|2\d\d)\.|162\.158\.)/.test(ip)) return true;
  return false;
}

function pickClientIp(candidates: { label: string; ip: string }[]): { ip: string; label: string } {
  const clean = candidates.filter(c => c.ip);
  // 1) first public non-CF
  let sel = clean.find(c => !isPrivateIp(c.ip) && !isCloudflareIp(c.ip));
  if (sel) return sel;
  // 2) first public (may be CF)
  sel = clean.find(c => !isPrivateIp(c.ip));
  if (sel) return sel;
  // 3) anything
  return clean[0] || { ip: "unknown", label: "none" };
}

function collectIpCandidates(req: Request): { label: string; ip: string }[] {
  const out: { label: string; ip: string }[] = [];
  const push = (label: string, val: string | null | undefined) => {
    if (!val) return;
    for (const raw of String(val).split(",")) {
      const ip = raw.trim();
      if (ip) out.push({ label, ip });
    }
  };
  push("x-client-ip", req.headers.get("x-client-ip"));
  push("cf-connecting-ip", req.headers.get("cf-connecting-ip"));
  push("true-client-ip", req.headers.get("true-client-ip"));
  push("x-real-ip", req.headers.get("x-real-ip"));
  push("x-forwarded-for", req.headers.get("x-forwarded-for"));
  return out;
}

function getClientIp(req: Request): string {
  return pickClientIp(collectIpCandidates(req)).ip;
}

function getClientIpTrace(req: Request): { ip: string; source: string; candidates: { label: string; ip: string }[]; cfCountry: string; cfRay: string; workerTrace: any } {
  const candidates = collectIpCandidates(req);
  const picked = pickClientIp(candidates);
  let workerTrace: any = null;
  try {
    const raw = req.headers.get("x-ip-trace");
    if (raw) workerTrace = JSON.parse(raw);
  } catch {}
  return {
    ip: picked.ip,
    source: picked.label,
    candidates,
    cfCountry: req.headers.get("cf-ipcountry") || "",
    cfRay: req.headers.get("cf-ray") || "",
    workerTrace,
  };
}

function esc(s: string): string {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function getTelegramConfig(supabase: any): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const { data } = await supabase.from("app_settings").select("value").eq("key", "config").single();
    const cfg = data?.value as any;
    if (cfg?.TELEGRAM_BOT_TOKEN && cfg?.TELEGRAM_CHAT_ID) {
      return { botToken: cfg.TELEGRAM_BOT_TOKEN, chatId: cfg.TELEGRAM_CHAT_ID };
    }
  } catch {}
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  return botToken && chatId ? { botToken, chatId } : null;
}

// --- Multi-provider IP geolocation (parallel, timeout-guarded) with VPN/proxy detection ---
type LocResult = {
  provider: string;
  ip?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  postal?: string;
  lat?: number;
  lng?: number;
  isp?: string;
  org?: string;
  asn?: string;
  timezone?: string;
  flag?: string;
  // Threat / anonymizer signals
  proxy?: boolean;
  vpn?: boolean;
  tor?: boolean;
  hosting?: boolean;
  threatScore?: number; // 0-100
};

type ClientGeoPayload = {
  status?: string;
  permissionState?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  altitude?: number | null;
  heading?: number | null;
  speed?: number | null;
  timestamp?: number;
  error?: string;
};

function sanitizeClientGeo(input: unknown): ClientGeoPayload | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const allowed = new Set(["granted", "denied", "timeout", "unavailable", "unsupported", "error"]);
  const status = typeof raw.status === "string" && allowed.has(raw.status) ? raw.status : "error";
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  const accuracy = Number(raw.accuracy);
  const granted = status === "granted"
    && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  return {
    status: granted ? "granted" : status,
    permissionState: typeof raw.permissionState === "string" ? raw.permissionState.slice(0, 24) : undefined,
    latitude: granted ? latitude : undefined,
    longitude: granted ? longitude : undefined,
    accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : undefined,
    altitude: typeof raw.altitude === "number" && Number.isFinite(raw.altitude) ? raw.altitude : null,
    heading: typeof raw.heading === "number" && Number.isFinite(raw.heading) ? raw.heading : null,
    speed: typeof raw.speed === "number" && Number.isFinite(raw.speed) ? raw.speed : null,
    timestamp: typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp) ? raw.timestamp : undefined,
    error: typeof raw.error === "string" ? raw.error.slice(0, 180) : undefined,
  };
}

function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { headers: { Accept: "application/json" }, signal: ctrl.signal, ...(init || {}) })
    .finally(() => clearTimeout(t));
}

function countryToFlag(cc?: string): string {
  const code = (cc || "").trim().toUpperCase();
  if (code.length !== 2) return "🌐";
  const A = 0x1f1e6;
  return String.fromCodePoint(A + code.charCodeAt(0) - 65, A + code.charCodeAt(1) - 65);
}

async function providerIpapiCo(ip: string): Promise<LocResult | null> {
  try {
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip)) return null;
    const r = await fetchWithTimeout(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, 2500);
    if (!r.ok) return null;
    const d = await r.json();
    if (d?.error) return null;
    return {
      provider: "ipapi.co",
      ip: d.ip,
      country: d.country_name, countryCode: d.country_code,
      region: d.region, city: d.city, postal: d.postal,
      lat: typeof d.latitude === "number" ? d.latitude : undefined,
      lng: typeof d.longitude === "number" ? d.longitude : undefined,
      isp: d.org, org: d.org, asn: d.asn,
      timezone: d.timezone,
      flag: countryToFlag(d.country_code),
    };
  } catch { return null; }
}

async function providerIpApiCom(ip: string): Promise<LocResult | null> {
  try {
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip)) return null;
    // include proxy/hosting/mobile flags for VPN detection
    const r = await fetchWithTimeout(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query,proxy,hosting,mobile`,
      2500,
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (d?.status !== "success") return null;
    return {
      provider: "ip-api.com",
      ip: d.query,
      country: d.country, countryCode: d.countryCode,
      region: d.regionName || d.region, city: d.city, postal: d.zip,
      lat: typeof d.lat === "number" ? d.lat : undefined,
      lng: typeof d.lon === "number" ? d.lon : undefined,
      isp: d.isp, org: d.org, asn: d.as,
      timezone: d.timezone,
      flag: countryToFlag(d.countryCode),
      proxy: d.proxy === true,
      hosting: d.hosting === true,
    };
  } catch { return null; }
}

async function providerIpwhoIs(ip: string): Promise<LocResult | null> {
  try {
    // NEVER call ipwho.is without an IP — it would geolocate the CALLER (Supabase edge = Portland).
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip)) return null;
    const url = `https://ipwho.is/${encodeURIComponent(ip)}`;
    console.log("[ipwho.is] Request:", url);
    const r = await fetchWithTimeout(url, 2500);
    if (!r.ok) return null;
    const d = await r.json();
    console.log("[ipwho.is] Response:", JSON.stringify({ ip: d.ip, country: d.country, city: d.city, isp: d.connection?.isp, org: d.connection?.org }));
    if (!d?.success) return null;
    return {
      provider: "ipwho.is",
      ip: d.ip,
      country: d.country, countryCode: d.country_code,
      region: d.region, city: d.city, postal: d.postal,
      lat: typeof d.latitude === "number" ? d.latitude : undefined,
      lng: typeof d.longitude === "number" ? d.longitude : undefined,
      isp: d.connection?.isp, org: d.connection?.org,
      asn: d.connection?.asn ? `AS${d.connection.asn}` : undefined,
      timezone: d.timezone?.id,
      flag: d.flag?.emoji || countryToFlag(d.country_code),
    };
  } catch { return null; }
}

async function providerIpinfoIo(ip: string): Promise<LocResult | null> {
  try {
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip)) return null;
    const r = await fetchWithTimeout(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, 2500);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || d.error) return null;
    const [latStr, lngStr] = typeof d.loc === "string" ? d.loc.split(",") : [];
    return {
      provider: "ipinfo.io",
      ip: d.ip,
      country: d.country, countryCode: d.country,
      region: d.region, city: d.city, postal: d.postal,
      lat: latStr ? Number(latStr) : undefined,
      lng: lngStr ? Number(lngStr) : undefined,
      isp: d.org, org: d.org,
      timezone: d.timezone,
      flag: countryToFlag(d.country),
      // ipinfo's free tier hints "hosting/vpn" in the org string
      hosting: typeof d.org === "string" && /hosting|datacenter|cloud|server|vpn|proxy/i.test(d.org),
    };
  } catch { return null; }
}

async function providerFreeIpApi(ip: string): Promise<LocResult | null> {
  try {
    const r = await fetchWithTimeout(`https://freeipapi.com/api/json/${encodeURIComponent(ip)}`, 2500);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || (!d.ipAddress && !d.countryName)) return null;
    return {
      provider: "freeipapi.com",
      ip: d.ipAddress,
      country: d.countryName, countryCode: d.countryCode,
      region: d.regionName, city: d.cityName, postal: d.zipCode,
      lat: typeof d.latitude === "number" ? d.latitude : undefined,
      lng: typeof d.longitude === "number" ? d.longitude : undefined,
      timezone: d.timeZone,
      flag: countryToFlag(d.countryCode),
    };
  } catch { return null; }
}

async function reverseGpsLocation(geo: ClientGeoPayload): Promise<LocResult | null> {
  if (geo.status !== "granted" || typeof geo.latitude !== "number" || typeof geo.longitude !== "number") return null;
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(String(geo.latitude))}&longitude=${encodeURIComponent(String(geo.longitude))}&localityLanguage=en`;
    const r = await fetchWithTimeout(url, 2200);
    if (!r.ok) throw new Error("reverse geocode failed");
    const d = await r.json();
    const countryCode = d.countryCode || d.principalSubdivisionCode?.split("-")?.[0];
    return {
      provider: "device-gps",
      country: d.countryName,
      countryCode,
      region: d.principalSubdivision,
      city: d.city || d.locality || d.localityInfo?.administrative?.[2]?.name,
      postal: d.postcode,
      lat: geo.latitude,
      lng: geo.longitude,
      timezone: d.localityInfo?.informative?.find?.((x: any) => x?.description === "time zone")?.name,
      flag: countryToFlag(countryCode),
    };
  } catch {
    return {
      provider: "device-gps",
      lat: geo.latitude,
      lng: geo.longitude,
      flag: "📍",
    };
  }
}

// Dedicated VPN/proxy detector (proxycheck.io — 1000/day free without key)
async function detectAnonymizer(ip: string): Promise<{ proxy: boolean; vpn: boolean; tor: boolean; hosting: boolean; type?: string; provider?: string } | null> {
  try {
    const r = await fetchWithTimeout(`https://proxycheck.io/v2/${encodeURIComponent(ip)}?vpn=1&asn=1&risk=1`, 2500);
    if (!r.ok) return null;
    const d = await r.json();
    const node = d?.[ip];
    if (!node) return null;
    const type = (node.type || "").toLowerCase(); // "VPN","TOR","PUB","Hosting","Business","Residential"
    return {
      proxy: node.proxy === "yes",
      vpn: /vpn/.test(type),
      tor: /tor/.test(type),
      hosting: /hosting|server|datacenter/.test(type),
      type: node.type,
      provider: node.provider,
    };
  } catch { return null; }
}

// Reject responses that clearly geolocate our own infrastructure (Supabase/Deno edge
// in Oregon/Portland, or a Cloudflare datacenter) — happens when a provider is called
// without a valid client IP and falls back to the CALLER's IP.
function isInfraResponse(r: LocResult): boolean {
  const org = `${r.isp || ""} ${r.org || ""}`.toLowerCase();
  if (/cloudflare|amazon|aws|google|microsoft|azure|digitalocean|hetzner|ovh|linode|oracle|fastly|akamai|deno|supabase|datacenter|hosting/.test(org)) return true;
  const city = (r.city || "").toLowerCase();
  const region = (r.region || "").toLowerCase();
  // Supabase edge in us-west-2 geolocates to Portland/Boardman, Oregon
  if (city === "portland" && /oregon|or/.test(region)) return true;
  if (city === "boardman") return true;
  return false;
}

async function resolveLocation(ip: string, opts?: { allowIpwho?: boolean }): Promise<{
  merged: LocResult; confidence: "high" | "medium" | "low"; agreed: number; results: LocResult[];
  anonymizer: { proxy: boolean; vpn: boolean; tor: boolean; hosting: boolean; type?: string; provider?: string } | null;
}> {
  // Fail closed: ipwho.is must be explicitly enabled by admin.
  const allowIpwho = opts?.allowIpwho === true;

  // HARD GUARD: never call geo providers without a real, public, non-CF client IP.
  // Otherwise every provider falls back to the CALLER (Supabase edge = Portland, OR).
  if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip)) {
    console.warn("[resolveLocation] refusing lookup — invalid client IP:", JSON.stringify({ ip, reason: !ip || ip === "unknown" ? "missing" : isPrivateIp(ip) ? "private" : "cloudflare-edge" }));
    return { merged: { provider: "none", ip: ip || "unknown" }, confidence: "low", agreed: 0, results: [], anonymizer: null };
  }

  const providers: Array<Promise<LocResult | null>> = [
    providerIpapiCo(ip),
    providerIpApiCom(ip),
    providerIpinfoIo(ip),
    providerFreeIpApi(ip),
  ];
  if (allowIpwho) providers.push(providerIpwhoIs(ip));
  const [settled, anonymizer] = await Promise.all([
    Promise.allSettled(providers),
    detectAnonymizer(ip),
  ]);
  let results = settled.map(s => s.status === "fulfilled" ? s.value : null).filter(Boolean) as LocResult[];

  // Drop any provider result that geolocates OUR infra (Portland/CF/AWS/etc.) —
  // that indicates the provider ignored our IP and geolocated the caller.
  const filtered = results.filter(r => !isInfraResponse(r));
  if (filtered.length > 0) results = filtered;

  if (results.length === 0) {
    console.warn("[resolveLocation] all providers returned infra/no data for ip=", ip);
    return { merged: { provider: "none", ip }, confidence: "low", agreed: 0, results: [], anonymizer };
  }
  const buckets = new Map<string, LocResult[]>();
  for (const r of results) {
    const k = `${(r.countryCode || r.country || "").toLowerCase()}|${(r.city || "").toLowerCase()}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(r);
  }
  const priority = ["ipapi.co", "ip-api.com", "ipinfo.io", "ipwho.is", "freeipapi.com"];
  let bestBucket: LocResult[] = [];
  let bestSize = 0;
  for (const bucket of buckets.values()) {
    if (bucket.length > bestSize) { bestBucket = bucket; bestSize = bucket.length; }
  }
  bestBucket.sort((a, b) => priority.indexOf(a.provider) - priority.indexOf(b.provider));
  const primary = bestBucket[0];
  const merged: LocResult = { ...primary };
  for (const r of results) {
    for (const key of ["country","countryCode","region","city","postal","lat","lng","isp","org","asn","timezone","flag","ip","proxy","hosting"] as const) {
      if (merged[key] === undefined || merged[key] === null || merged[key] === "") {
        (merged as any)[key] = (r as any)[key];
      }
    }
  }
  merged.flag = merged.flag || countryToFlag(merged.countryCode);
  if (anonymizer) {
    merged.proxy = merged.proxy || anonymizer.proxy;
    merged.vpn = anonymizer.vpn;
    merged.tor = anonymizer.tor;
    merged.hosting = merged.hosting || anonymizer.hosting;
  }
  const agreed = bestSize;
  const confidence: "high" | "medium" | "low" =
    agreed >= 3 ? "high" : agreed >= 2 ? "medium" : "low";
  return { merged, confidence, agreed, results, anonymizer };
}

function parseUserAgent(ua: string): { browser: string; os: string } {
  const s = ua || "";
  let browser = "Unknown";
  if (/Edg\//.test(s)) browser = "Edge";
  else if (/OPR\//.test(s)) browser = "Opera";
  else if (/Chrome\//.test(s) && !/Edg\//.test(s)) browser = "Chrome";
  else if (/Firefox\//.test(s)) browser = "Firefox";
  else if (/Safari\//.test(s) && !/Chrome\//.test(s)) browser = "Safari";
  let os = "Unknown";
  if (/Windows NT/.test(s)) os = "Windows";
  else if (/Android/.test(s)) os = "Android";
  else if (/iPhone|iPad|iOS/.test(s)) os = "iOS";
  else if (/Mac OS X/.test(s)) os = "macOS";
  else if (/Linux/.test(s)) os = "Linux";
  return { browser, os };
}

async function sendPrimaryLoginAlert(
  supabase: any, req: Request, user: any, status: "success" | "failed", ip: string,
  loc: LocResult, ipLoc: LocResult, confidence: string, agreed: number,
  anonymizer: { proxy: boolean; vpn: boolean; tor: boolean; hosting: boolean; type?: string; provider?: string } | null,
  totalProviders: number,
  clientGeo: ClientGeoPayload | null,
  ipTrace: { ip: string; source: string; candidates: { label: string; ip: string }[]; cfCountry: string; cfRay: string; workerTrace: any } | null,
) {
  const tg = await getTelegramConfig(supabase);
  if (!tg) return;
  const { browser, os } = parseUserAgent(req.headers.get("user-agent") || "");
  const displayName = user?.name || user?.username || "Unknown";
  const role = user?.role || "user";
  const isGps = loc.provider === "device-gps";

  // GPS wins entirely for map + coords when granted.
  const gpsLat = clientGeo?.status === "granted" ? clientGeo.latitude : undefined;
  const gpsLng = clientGeo?.status === "granted" ? clientGeo.longitude : undefined;
  const mapLat = typeof gpsLat === "number" ? gpsLat : (typeof loc.lat === "number" ? loc.lat : undefined);
  const mapLng = typeof gpsLng === "number" ? gpsLng : (typeof loc.lng === "number" ? loc.lng : undefined);
  const mapLink = (typeof mapLat === "number" && typeof mapLng === "number")
    ? `https://www.google.com/maps?q=${mapLat},${mapLng}` : null;

  const flag = loc.flag || countryToFlag(loc.countryCode);
  const locLine = isGps && typeof loc.lat === "number" && typeof loc.lng === "number"
    ? `${[loc.city, loc.region, loc.country].filter(Boolean).join(", ") || "GPS coordinates"} (${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)})`
    : [loc.city, loc.region, loc.country].filter(Boolean).join(", ") || "Unknown location";
  const isp = ipLoc.isp || ipLoc.org || loc.isp || loc.org || "Unknown ISP";
  const time = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
  const statusEmoji = status === "success" ? "✅" : "❌";

  const isAnon = !!(ipLoc.vpn || ipLoc.proxy || ipLoc.tor || ipLoc.hosting || anonymizer?.vpn || anonymizer?.proxy || anonymizer?.tor || anonymizer?.hosting);
  const anonBadge = (ipLoc.tor || anonymizer?.tor) ? "🧅 TOR" : (ipLoc.vpn || anonymizer?.vpn) ? "🛡 VPN" : (ipLoc.proxy || anonymizer?.proxy) ? "🎭 PROXY" : (ipLoc.hosting || anonymizer?.hosting) ? "🖥 HOSTING/DC" : "";
  const anonNote = isAnon
    ? `⚠️ <b>Anonymizer detected</b> — ${anonBadge}${anonymizer?.provider ? ` · <i>${esc(anonymizer.provider)}</i>` : ""}\n<i>${isGps ? "Device GPS was used for the map; IP location is a VPN/proxy exit-node." : "User did not provide device GPS, so displayed location is only IP/VPN exit-node — NOT the real user location."}</i>`
    : "";

  const gpsLine = clientGeo?.status === "granted"
    ? `🛰 <b>GPS:</b> granted · accuracy ${clientGeo.accuracy ? `±${esc(String(clientGeo.accuracy))}m` : "unknown"}${clientGeo.timestamp ? ` · fix ${esc(new Date(clientGeo.timestamp).toISOString())}` : ""}`
    : `🛰 <b>GPS:</b> ${esc(clientGeo?.status || "not sent")}${clientGeo?.permissionState ? ` · permission ${esc(clientGeo.permissionState)}` : ""}${clientGeo?.error ? ` · ${esc(clientGeo.error)}` : ""}`;

  const locationSource = isGps ? "Device GPS (exact)" : "IP lookup (approximate — may be VPN/proxy)";

  const ipTraceLine = ipTrace ? `🧭 <b>IP source:</b> <code>${esc(ipTrace.source)}</code>${ipTrace.cfCountry ? ` · CF ${esc(ipTrace.cfCountry)}` : ""}${ipTrace.candidates?.length ? ` · seen ${ipTrace.candidates.length}` : ""}` : "";

  const text = [
    `🔔 <b>New Login</b> — ${esc(displayName)} ${statusEmoji}`,
    `━━━━━━━━━━━━━━━━`,
    `👤 <b>User:</b> ${esc(displayName)} (<code>${esc(user?.username || "")}</code>) · <b>${esc(role)}</b>`,
    `🕐 <b>Time:</b> ${esc(time)} IST`,
    `🌐 <b>Network IP:</b> <code>${esc(ip)}</code>`,
    ipTraceLine,
    `📍 ${flag} <b>${esc(locationSource)}:</b> ${esc(locLine)}${loc.postal ? ` · ${esc(loc.postal)}` : ""}`,
    gpsLine,
    `🏢 <b>ISP:</b> ${esc(isp)}${(ipLoc.asn || loc.asn) ? ` (${esc(ipLoc.asn || loc.asn || "")})` : ""}`,
    loc.timezone ? `⏱ <b>Timezone:</b> ${esc(loc.timezone)}` : "",
    `📱 <b>Device:</b> ${esc(browser)} on ${esc(os)}`,
    mapLink ? `🗺 <a href="${mapLink}">Open in Google Maps</a> ${isGps ? "(GPS)" : "(IP — approximate)"}` : "",
    anonNote,
    `━━━━━━━━━━━━━━━━`,
    isGps ? `Confidence: <b>GPS verified</b>${clientGeo?.accuracy ? ` (±${esc(String(clientGeo.accuracy))}m)` : ""}` : `Confidence: <b>${esc(confidence)}</b> (${agreed}/${totalProviders} IP providers agreed)`,
  ].filter(Boolean).join("\n");
  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!tgRes.ok) console.error("[tg primary alert] failed:", await tgRes.text());
  } catch (e) { console.error("[tg primary alert] error:", e); }
}

async function sendLegacyIpwhoAlert(
  supabase: any, user: any, status: "success" | "failed", ip: string, results: LocResult[],
) {
  const tg = await getTelegramConfig(supabase);
  if (!tg) return;
  const ipwho = results.find(r => r.provider === "ipwho.is");
  if (!ipwho) return;
  const displayName = user?.name || user?.username || "Unknown";
  const locLine = [ipwho.city, ipwho.region, ipwho.country].filter(Boolean).join(", ");
  const map = (typeof ipwho.lat === "number" && typeof ipwho.lng === "number")
    ? `https://www.google.com/maps?q=${ipwho.lat},${ipwho.lng}` : null;
  const text = [
    `🛰 <b>Legacy ipwho.is location</b> for ${esc(displayName)} (${status})`,
    `<b>IP:</b> <code>${esc(ip)}</code>`,
    `<b>Place:</b> ${esc(locLine || "Unknown")}`,
    ipwho.isp ? `<b>ISP:</b> ${esc(ipwho.isp)}` : "",
    map ? `<b>Map:</b> <a href="${map}">Open</a>` : "",
  ].filter(Boolean).join("\n");
  try {
    await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch {}
}


async function sendLoginNotification(
  supabase: any,
  req: Request,
  user: any,
  status: "success" | "failed",
  rawClientGeo?: unknown,
) {
  try {
    if (!user) return;
    const ipTrace = getClientIpTrace(req);
    const ip = ipTrace.ip;
    const clientGeo = sanitizeClientGeo(rawClientGeo);

    // Check admin toggle FIRST so ipwho.is is fully skipped when disabled.
    let ipwhoEnabled = false;
    try {
      const { data } = await supabase.from("app_settings").select("value").eq("key", "ipwho_alert").single();
      ipwhoEnabled = data?.value?.enabled === true;
    } catch {}

    console.log("[login-notify] ip=", ip, "source=", ipTrace.source, "candidates=", ipTrace.candidates.map(c => `${c.label}:${c.ip}`).join("|"), "gps=", clientGeo?.status, "ipwhoEnabled=", ipwhoEnabled);

    const [locRes, gpsLoc] = await Promise.all([
      resolveLocation(ip, { allowIpwho: ipwhoEnabled }),
      clientGeo?.status === "granted" ? reverseGpsLocation(clientGeo) : Promise.resolve(null),
    ]);
    const { merged, confidence, agreed, results, anonymizer } = locRes;
    const totalProviders = ipwhoEnabled ? 5 : 4;
    const displayLoc = gpsLoc || merged;

    await sendPrimaryLoginAlert(
      supabase, req, user, status,
      merged.ip || ip, displayLoc, merged, confidence, agreed, anonymizer,
      totalProviders, clientGeo, ipTrace,
    );

    if (ipwhoEnabled) {
      try { await sendLegacyIpwhoAlert(supabase, user, status, merged.ip || ip, results); } catch {}
    }
  } catch (err) {
    console.error("[notification] login notify failed:", err);
  }
}


async function loadWorkerUrls(supabase: any): Promise<string[]> {
  const workerUrls: string[] = [];
  try {
    const { data: primaryCfSetting } = await supabase.from("app_settings").select("value").eq("key", "primary_cloudflare_urls").single();
    if (Array.isArray(primaryCfSetting?.value)) {
      for (const u of primaryCfSetting.value) if (typeof u === "string" && u.length > 0 && !workerUrls.includes(u)) workerUrls.push(u);
    }
    const { data: emailAccountsSetting } = await supabase.from("app_settings").select("value").eq("key", "email_accounts").single();
    if (Array.isArray(emailAccountsSetting?.value)) {
      for (const acct of emailAccountsSetting.value) {
        if (Array.isArray(acct.cloudflareUrls)) {
          for (const u of acct.cloudflareUrls) if (typeof u === "string" && u.length > 0 && !workerUrls.includes(u)) workerUrls.push(u);
        }
      }
    }
  } catch (e) {
    console.error("Failed to fetch worker URLs:", e);
  }
  return workerUrls;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const SESSION_SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ip = getClientIp(req);

  // --- Persist a session row in DB (source of truth for logged-in status) ---
  async function persistSession(userId: string, role: string, token: string, expiresAtMs: number) {
    const tokenHash = await sha256Hex(token);
    const ua = req.headers.get("user-agent") || null;
    await supabase.from("app_sessions").insert({
      user_id: userId,
      role,
      token_hash: tokenHash,
      expires_at: new Date(expiresAtMs).toISOString(),
      ip,
      user_agent: ua,
    });
    // Best-effort cleanup of expired rows for this user
    supabase.from("app_sessions").delete().lt("expires_at", new Date().toISOString()).eq("user_id", userId).then(() => {});
  }

  // Helper to verify session from header AND ensure a live DB row exists
  async function requireSession(req: Request): Promise<Record<string, any>> {
    const token = req.headers.get("x-session-token");
    if (!token) throw new Error("Authentication required");
    const session = await verifySessionToken(token, SESSION_SECRET);
    if (!session) throw new Error("Session expired or invalid");
    const tokenHash = await sha256Hex(token);
    const { data: row } = await supabase
      .from("app_sessions")
      .select("id, expires_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (!row) throw new Error("Session revoked. Please sign in again.");
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await supabase.from("app_sessions").delete().eq("id", row.id);
      throw new Error("Session expired. Please sign in again.");
    }
    // Fire-and-forget touch
    supabase.from("app_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", row.id).then(() => {});
    return session;
  }

  async function requireAdmin(req: Request): Promise<Record<string, any>> {
    const session = await requireSession(req);
    if (session.role !== "admin") throw new Error("Admin access required");
    return session;
  }

  async function requirePendingAdmin(req: Request, userId?: string): Promise<{ pending: Record<string, any>; token: string; tokenHash: string; state: any }> {
    const token = req.headers.get("x-pending-token") || req.headers.get("x-session-token");
    if (!token) throw new Error("Pending admin verification required");
    const pending = await verifySessionToken(token, SESSION_SECRET);
    if (!pending || pending.role !== "admin" || pending.pending !== true) throw new Error("Invalid or expired pending admin token");
    if (userId && pending.userId !== userId) throw new Error("Pending token does not match this admin");
    const tokenHash = await sha256Hex(token);
    const { data: state, error } = await supabase
      .from("app_admin_2fa_state")
      .select("*")
      .eq("token_hash", tokenHash)
      .eq("user_id", pending.userId)
      .gte("expires_at", new Date().toISOString())
      .single();
    if (error || !state) throw new Error("Pending admin verification expired");
    return { pending, token, tokenHash, state };
  }

  try {
    const { action, ...params } = await req.json();

    // --- Public actions (no session needed) ---

    // Bootstrap: returns profiles, recaptcha config, and worker URLs for fresh browsers
    if (action === "bootstrap_public") {
      // Public profile picker — only non-admin users, minimal fields.
      const { data: users, error: usersErr } = await supabase
        .from("app_users")
        .select("id, username, name, role, profile_prefs")
        .neq("role", "admin")
        .order("created_at", { ascending: true });
      if (usersErr) throw usersErr;

      let recaptcha = null;
      try {
        const { data: rcData } = await supabase.from("app_settings").select("value").eq("key", "recaptcha").single();
        if (rcData?.value?.enabled === true && rcData?.value?.siteKey) {
          recaptcha = { enabled: true, siteKey: rcData.value.siteKey };
        }
      } catch {}

      let workerUrls: string[] = [];
      try {
        const { data: pcf } = await supabase.from("app_settings").select("value").eq("key", "primary_cloudflare_urls").single();
        if (pcf?.value && Array.isArray(pcf.value)) {
          workerUrls = pcf.value.filter((u: any) => typeof u === "string" && u.length > 0);
        }
      } catch {}

      let emailFilters: any = {};
      try {
        const { data: efData } = await supabase.from("app_settings").select("value").eq("key", "email_filters").single();
        if (efData?.value && typeof efData.value === "object") emailFilters = efData.value;
      } catch {}

      const mappedUsers = (users || []).map((u: any) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        role: u.role,
        profileAvatar: u.profile_prefs?.avatarId || null,
      }));
      return new Response(JSON.stringify({ success: true, users: mappedUsers, recaptcha, workerUrls, emailFilters }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "list") {
      // Admin dashboard only
      await requireAdmin(req);
      const { data, error } = await supabase
        .from("app_users")
        .select("id, username, name, role, assigned_accounts, profile_prefs")
        .order("created_at", { ascending: true });
      if (error) throw error;
      const mappedData = (data || []).map((u: any) => ({
        ...u,
        assignedAccounts: u.assigned_accounts || null,
        profileAvatar: u.profile_prefs?.avatarId || null,
      }));
      return new Response(JSON.stringify({ success: true, users: mappedData }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "login") {
      const { username, password, clientGeo } = params;
      if (!username || !password) throw new Error("Username and password required");
      const verifiedClientGeo = sanitizeClientGeo(clientGeo);
      if (verifiedClientGeo?.status !== "granted" || typeof verifiedClientGeo.latitude !== "number" || typeof verifiedClientGeo.longitude !== "number") {
        const status = verifiedClientGeo?.status || "missing";
        if (status === "denied") throw new Error("Location is blocked. Allow location for this site, then try again.");
        if (status === "timeout") throw new Error("Location is allowed, but your device did not return GPS coordinates. Turn on device Location/Precise Location and try again.");
        if (status === "unsupported") throw new Error("This browser/device does not support GPS location.");
        throw new Error("Device GPS coordinates are required to sign in. VPN/IP location is not accepted.");
      }

      const { data: user, error } = await supabase
        .from("app_users")
        .select("*")
        .eq("username", username)
        .single();

      if (error || !user) {
        await auditLog(supabase, "login_failed", null, null, { username }, ip);
        throw new Error("Invalid username or password");
      }

      const passwordMatch = await verifyPassword(password, user.password);
      if (!passwordMatch) {
        await auditLog(supabase, "login_failed", user.id, null, { username }, ip);
        ((globalThis as any).EdgeRuntime?.waitUntil?.(sendLoginNotification(supabase, req, user, "failed", verifiedClientGeo)) ?? sendLoginNotification(supabase, req, user, "failed", verifiedClientGeo).catch(() => {}));
        throw new Error("Invalid username or password");
      }

      // Upgrade to PBKDF2 if not already
      if (!user.password.startsWith("pbkdf2:")) {
        const hashed = await hashPassword(password);
        await supabase.from("app_users").update({ password: hashed }).eq("id", user.id);
      }

      await auditLog(supabase, "login_success", user.id, null, { username, role: user.role }, ip);
      ((globalThis as any).EdgeRuntime?.waitUntil?.(sendLoginNotification(supabase, req, user, "success", verifiedClientGeo)) ?? sendLoginNotification(supabase, req, user, "success", verifiedClientGeo).catch(() => {}));

      if (user.role === "admin") {
        const pendingPayload = { userId: user.id, username: user.username, role: "admin", pending: true, exp: Date.now() + 5 * 60 * 1000 };
        const pendingToken = await createSessionToken(pendingPayload, SESSION_SECRET);
        const tokenHash = await sha256Hex(pendingToken);
        await supabase.from("app_admin_2fa_state").delete().eq("user_id", user.id);
        const { error: stateErr } = await supabase.from("app_admin_2fa_state").insert({
          token_hash: tokenHash,
          user_id: user.id,
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });
        if (stateErr) throw stateErr;
        return new Response(JSON.stringify({
          success: true,
          pendingToken,
          user: {
            id: user.id,
            username: user.username,
            name: user.name,
            role: user.role,
            totpConfigured: !!user.totp_secret,
            mustChangePassword: user.must_change_password,
          },
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Create normal user session token (30 min expiry)
      const expMs = Date.now() + 30 * 60 * 1000;
      const sessionPayload = {
        userId: user.id,
        username: user.username,
        role: user.role,
        assignedAccounts: user.assigned_accounts || null,
        exp: expMs,
      };
      const sessionToken = await createSessionToken(sessionPayload, SESSION_SECRET);
      await persistSession(user.id, user.role, sessionToken, expMs);
      const workerUrls = await loadWorkerUrls(supabase);

      return new Response(JSON.stringify({
        success: true,
        sessionToken,
        workerUrls,
        user: {
          id: user.id, username: user.username, name: user.name, role: user.role,
          mustChangePassword: user.must_change_password,
          assignedAccounts: user.assigned_accounts,
          profilePrefs: user.profile_prefs || {},
          profileAvatar: user.profile_prefs?.avatarId || null,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "create") {
      const { username, password, name, role, assigned_accounts } = params;
      if (!username || !password || !name) throw new Error("All fields required");

      // Optionally require admin session for creating users
      let bootstrapCreate = false;
      let actorId: string | null = null;
      try {
        const admin = await requireAdmin(req);
        actorId = admin.userId;
      } catch {
        // Allow first user creation without session (bootstrap)
        const { data: existing } = await supabase.from("app_users").select("id").limit(1);
        if (existing && existing.length > 0) throw new Error("Admin session required to create users");
        bootstrapCreate = true;
      }

      const hashed = await hashPassword(password);
      const { data, error } = await supabase
        .from("app_users")
        .insert({ username, password: hashed, name, role: role || "user", assigned_accounts: assigned_accounts || null })
        .select("id, username, name, role, assigned_accounts, profile_prefs")
        .single();
      if (error) throw error;

      await auditLog(supabase, bootstrapCreate ? "bootstrap_admin_created" : "user_created", actorId, data.id, { username, role: role || "user" }, ip);

      return new Response(JSON.stringify({ success: true, user: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete") {
      const session = await requireAdmin(req);
      const { id } = params;
      const { error } = await supabase.from("app_users").delete().eq("id", id);
      if (error) throw error;
      await auditLog(supabase, "user_deleted", session.userId, id, {}, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "change_password") {
      const { id, current_password, new_password } = params;
      if (!id || !new_password) throw new Error("ID and new password required");
      if (new_password.length < 6) throw new Error("Password must be at least 6 characters");

      const { data: user, error: fetchErr } = await supabase
        .from("app_users")
        .select("*")
        .eq("id", id)
        .single();
      if (fetchErr || !user) throw new Error("User not found");

      if (current_password) {
        // Normal self-change: verify current password
        const match = await verifyPassword(current_password, user.password);
        if (!match) throw new Error("Current password is incorrect");
      } else {
        // Either admin reset OR forced first-time password set
        const token = req.headers.get("x-session-token");
        if (!token) throw new Error("Authentication required to change password");
        const session = await verifySessionToken(token, SESSION_SECRET);
        if (!session) throw new Error("Session expired or invalid");

        if (session.role === "admin") {
          // Admin reset — allowed
        } else if (session.userId === id && user.must_change_password) {
          // First-time forced password set — allowed
        } else {
          throw new Error("Provide your current password or contact an admin");
        }
      }

      const hashed = await hashPassword(new_password);
      const { error } = await supabase.from("app_users").update({ password: hashed, must_change_password: false }).eq("id", id);
      if (error) throw error;
      await auditLog(supabase, "password_changed", id, id, {}, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_profile_prefs") {
      const session = await requireSession(req);
      const { profile_prefs } = params;
      if (!profile_prefs || typeof profile_prefs !== "object" || Array.isArray(profile_prefs)) {
        throw new Error("Profile settings are invalid");
      }

      const cleanPrefs = {
        avatarId: typeof profile_prefs.avatarId === "string" ? profile_prefs.avatarId : null,
        hiddenBefore: typeof profile_prefs.hiddenBefore === "string" ? profile_prefs.hiddenBefore : null,
        hiddenEmailIds: Array.isArray(profile_prefs.hiddenEmailIds)
          ? profile_prefs.hiddenEmailIds.filter((id: any) => typeof id === "string").slice(0, 2000)
          : [],
      };

      const { error } = await supabase
        .from("app_users")
        .update({ profile_prefs: cleanPrefs })
        .eq("id", session.userId);
      if (error) throw error;

      await auditLog(supabase, "profile_prefs_updated", session.userId, session.userId, { avatarId: cleanPrefs.avatarId, hiddenBefore: cleanPrefs.hiddenBefore }, ip);
      return new Response(JSON.stringify({ success: true, profilePrefs: cleanPrefs }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_totp") {
      const { user_id } = params;
      const { pending } = await requirePendingAdmin(req, user_id);
      const { data: existing, error: exErr } = await supabase
        .from("app_users").select("id, username, totp_secret").eq("id", pending.userId).single();
      if (exErr) throw exErr;
      if (existing?.totp_secret) throw new Error("TOTP is already configured");
      const secret = authenticator.generateSecret();
      const otpauthUrl = authenticator.keyuri(existing.username, "AdminPanel", secret);
      const { error } = await supabase.from("app_users").update({ totp_secret: secret }).eq("id", pending.userId);
      if (error) throw error;
      await auditLog(supabase, "totp_setup_created", pending.userId, pending.userId, {}, ip);
      return new Response(JSON.stringify({ success: true, secret, otpauthUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // NOTE: The insecure `create_otp` action was removed. OTPs are generated
    // server-side by `request_admin_otp` and never accepted from the client.

    if (action === "request_admin_otp") {
      const { user_id } = params;
      if (!user_id) throw new Error("user_id required");
      await requirePendingAdmin(req, user_id);

      // Generate OTP
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

      // Save OTP to DB
      await supabase.from("app_otps").delete().eq("user_id", user_id);
      const { error: otpErr } = await supabase.from("app_otps").insert({ user_id, otp: otpCode });
      if (otpErr) throw otpErr;

      // Get Telegram config
      let tgConfig: { botToken: string; chatId: string } | null = null;
      try {
        const { data: settingsData } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "config")
          .single();
        if (settingsData?.value) {
          const cfg = settingsData.value as any;
          if (cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID) {
            tgConfig = { botToken: cfg.TELEGRAM_BOT_TOKEN, chatId: cfg.TELEGRAM_CHAT_ID };
          }
        }
      } catch {}
      if (!tgConfig) {
        const bt = Deno.env.get("TELEGRAM_BOT_TOKEN");
        const ci = Deno.env.get("TELEGRAM_CHAT_ID");
        if (bt && ci) tgConfig = { botToken: bt, chatId: ci };
      }

      if (!tgConfig) {
        throw new Error("Telegram not configured. Set bot token and chat ID in admin settings.");
      }

      // Send OTP via Telegram
      const telegramRes = await fetch(`https://api.telegram.org/bot${tgConfig.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: tgConfig.chatId,
          text: `🛡 Admin 3FA OTP: <code>${otpCode}</code>\nValid for 5 minutes.`,
          parse_mode: "HTML",
        }),
      });

      if (!telegramRes.ok) {
        const errText = await telegramRes.text();
        console.error("Telegram API error:", errText);
        throw new Error("Failed to send OTP via Telegram. Check bot token and chat ID.");
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify_otp") {
      const { pending, tokenHash } = await requirePendingAdmin(req, params.user_id);
      const { user_id, otp } = params;
      const { data, error } = await supabase
        .from("app_otps")
        .select("*")
        .eq("user_id", user_id)
        .eq("otp", otp)
        .gte("expires_at", new Date().toISOString())
        .single();

      if (error || !data) throw new Error("Invalid or expired OTP");
      await supabase.from("app_otps").delete().eq("id", data.id);
      await supabase.from("app_admin_2fa_state").update({ otp_verified_at: new Date().toISOString() }).eq("token_hash", tokenHash).eq("user_id", pending.userId);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify_totp") {
      const { pending, tokenHash } = await requirePendingAdmin(req, params.user_id);
      const { code } = params;
      if (!code || String(code).length < 6) throw new Error("TOTP code required");
      const { data: user, error } = await supabase.from("app_users").select("totp_secret").eq("id", pending.userId).single();
      if (error || !user?.totp_secret) throw new Error("TOTP is not configured");
      if (!authenticator.check(String(code), user.totp_secret)) throw new Error("Invalid Google Authenticator code");
      await supabase.from("app_admin_2fa_state").update({ totp_verified_at: new Date().toISOString() }).eq("token_hash", tokenHash).eq("user_id", pending.userId);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "finalize_admin_session") {
      const { pending, tokenHash, state } = await requirePendingAdmin(req, params.user_id);
      const now = Date.now();
      const otpAt = state.otp_verified_at ? new Date(state.otp_verified_at).getTime() : 0;
      const totpAt = state.totp_verified_at ? new Date(state.totp_verified_at).getTime() : 0;
      if (!otpAt || now - otpAt > 60_000) throw new Error("Telegram OTP proof expired");
      if (!totpAt || now - totpAt > 60_000) throw new Error("Authenticator proof expired");

      const { data: user, error } = await supabase.from("app_users").select("*").eq("id", pending.userId).single();
      if (error || !user || user.role !== "admin") throw new Error("Admin not found");
      const expMs = Date.now() + 30 * 60 * 1000;
      const sessionPayload = {
        userId: user.id,
        username: user.username,
        role: "admin",
        assignedAccounts: user.assigned_accounts || null,
        exp: expMs,
      };
      const sessionToken = await createSessionToken(sessionPayload, SESSION_SECRET);
      await persistSession(user.id, "admin", sessionToken, expMs);
      const workerUrls = await loadWorkerUrls(supabase);
      await supabase.from("app_admin_2fa_state").delete().eq("token_hash", tokenHash);
      await auditLog(supabase, "admin_2fa_finalized", user.id, user.id, {}, ip);
      return new Response(JSON.stringify({
        success: true,
        sessionToken,
        workerUrls,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          mustChangePassword: user.must_change_password,
          assignedAccounts: user.assigned_accounts,
          profilePrefs: user.profile_prefs || {},
          profileAvatar: user.profile_prefs?.avatarId || null,
        },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "get_settings") {
      const { key } = params;
      let session: Record<string, any> | null = null;

      // Fully admin-only keys
      const adminOnlyKeys = ["config", "cron_config"];
      if (adminOnlyKeys.includes(key)) {
        session = await requireAdmin(req);
      }

      // Keys that any authenticated user can read (with masked sensitive data)
      const authenticatedKeys = ["primary_cloudflare_urls", "email_accounts", "recaptcha", "email_filters", "session_config", "admin_session_config", "ipwho_alert"];
      if (!session && authenticatedKeys.includes(key)) {
        session = await requireSession(req);
      }

      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", key)
        .single();

      let value = data?.value || null;

      if (key === "ipwho_alert") {
        value = { enabled: value?.enabled === true };
      }

      // Mask IMAP passwords in email_accounts for non-admin users
      if (key === "email_accounts" && Array.isArray(value)) {
        const isAdmin = session?.role === "admin";
        value = value.map((acc: any) => ({
          ...acc,
          password: isAdmin ? acc.password : "••••••••",
          // Non-admin users only see cloudflare URLs and label
          ...(isAdmin ? {} : { host: undefined, port: undefined, user: undefined }),
        }));
      }

      if (key === "recaptcha" && value && session?.role !== "admin") {
        const { secretKey, ...safeValue } = value;
        value = safeValue;
      }

      return new Response(JSON.stringify({ success: true, value }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "set_settings") {
      const session = await requireAdmin(req);
      const { key, value } = params;

      let processedValue = value;

      if (key === "ipwho_alert") {
        processedValue = { enabled: value?.enabled === true };
      }

      // Encrypt IMAP passwords in email_accounts
      if (key === "email_accounts" && Array.isArray(value)) {
        // Get existing accounts to preserve encrypted passwords when masked
        const { data: existingData } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "email_accounts")
          .single();
        const existingAccounts = existingData?.value || [];

        processedValue = await Promise.all(value.map(async (acc: any, i: number) => {
          let password = acc.password;
          if (password === "••••••••" && existingAccounts[i]?.password) {
            password = existingAccounts[i].password; // Keep existing encrypted password
          } else if (password && !password.startsWith("enc:")) {
            password = await encryptValue(password, SESSION_SECRET); // Encrypt new password
          }
          return { ...acc, password };
        }));
      }

      const { error } = await supabase
        .from("app_settings")
        .upsert({ key, value: processedValue }, { onConflict: "key" });
      if (error) throw error;
      await auditLog(supabase, "settings_changed", session.userId, null, { key }, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_user") {
      const session = await requireAdmin(req);
      const { id, assigned_accounts } = params;
      if (!id) throw new Error("User ID required");
      const { error } = await supabase.from("app_users").update({ assigned_accounts }).eq("id", id);
      if (error) throw error;
      await auditLog(supabase, "user_updated", session.userId, id, { assigned_accounts }, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "impersonate") {
      const session = await requireAdmin(req);
      const { target_user_id } = params;
      if (!target_user_id) throw new Error("Target user ID required");

      const { data: targetUser, error } = await supabase
        .from("app_users")
        .select("*")
        .eq("id", target_user_id)
        .single();
      if (error || !targetUser) throw new Error("User not found");

      const expMs = Date.now() + 30 * 60 * 1000;
      const impersonatePayload = {
        userId: targetUser.id,
        username: targetUser.username,
        role: "user",
        assignedAccounts: targetUser.assigned_accounts || null,
        impersonated: true,
        adminId: session.userId,
        exp: expMs,
      };
      const token = await createSessionToken(impersonatePayload, SESSION_SECRET);
      await persistSession(targetUser.id, "user", token, expMs);

      await auditLog(supabase, "impersonate", session.userId, targetUser.id, { targetUsername: targetUser.username }, ip);

      return new Response(JSON.stringify({
        success: true,
        sessionToken: token,
        user: {
          id: targetUser.id, username: targetUser.username, name: targetUser.name, role: "user",
          assignedAccounts: targetUser.assigned_accounts, mustChangePassword: false,
          profilePrefs: targetUser.profile_prefs || {},
          profileAvatar: targetUser.profile_prefs?.avatarId || null,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Decrypt IMAP passwords (internal use for fetch-emails)
    if (action === "get_decrypted_accounts") {
      // Only allow from internal edge functions (check for service role key in auth header)
      const authHeader = req.headers.get("authorization") || "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      if (!authHeader.includes(serviceKey)) throw new Error("Unauthorized");

      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "email_accounts")
        .single();

      if (!data?.value || !Array.isArray(data.value)) {
        return new Response(JSON.stringify({ success: true, accounts: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const decrypted = await Promise.all(data.value.map(async (acc: any) => ({
        ...acc,
        password: acc.password ? await decryptValue(acc.password, SESSION_SECRET) : "",
      })));

      return new Response(JSON.stringify({ success: true, accounts: decrypted }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify_session") {
      const token = params.token || req.headers.get("x-session-token");
      if (!token) throw new Error("No token provided");
      const session = await verifySessionToken(token, SESSION_SECRET);
      if (!session) throw new Error("Invalid or expired session");
      return new Response(JSON.stringify({ success: true, session }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Hydrate the logged-in user from the DB. Used on page load / refresh so
    // localStorage cannot be trusted for who the user is or their role.
    if (action === "me") {
      const session = await requireSession(req);
      const { data: user, error } = await supabase
        .from("app_users")
        .select("id, username, name, role, must_change_password, assigned_accounts, profile_prefs")
        .eq("id", session.userId)
        .single();
      if (error || !user) throw new Error("Account not found");
      return new Response(JSON.stringify({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          mustChangePassword: user.must_change_password,
          assignedAccounts: user.assigned_accounts,
          profilePrefs: user.profile_prefs || {},
          profileAvatar: user.profile_prefs?.avatarId || null,
          impersonated: session.impersonated === true,
        },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "logout") {
      const token = req.headers.get("x-session-token");
      if (token) {
        const tokenHash = await sha256Hex(token);
        await supabase.from("app_sessions").delete().eq("token_hash", tokenHash);
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- User: clear own inbox (hide-only) ----------
    if (action === "clear_user_inbox") {
      const session = await requireSession(req);
      const { visibleIds } = params as { visibleIds?: string[] };
      const { data: u, error: uErr } = await supabase
        .from("app_users").select("profile_prefs").eq("id", session.userId).single();
      if (uErr || !u) throw new Error("User not found");
      const prefs = (u.profile_prefs || {}) as any;
      const existing: string[] = Array.isArray(prefs.hiddenEmailIds) ? prefs.hiddenEmailIds : [];
      const merged = Array.from(new Set([...existing, ...(Array.isArray(visibleIds) ? visibleIds : [])])).slice(-5000);
      const nextPrefs = { ...prefs, hiddenBefore: new Date().toISOString(), hiddenEmailIds: merged };
      const { error: upErr } = await supabase.from("app_users").update({ profile_prefs: nextPrefs }).eq("id", session.userId);
      if (upErr) throw upErr;
      await auditLog(supabase, "user_clear_inbox", session.userId, session.userId, { count: merged.length }, ip);
      return new Response(JSON.stringify({ success: true, profilePrefs: nextPrefs }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- Admin: destructive DB clear ----------
    if (action === "admin_clear_inbox") {
      const session = await requireAdmin(req);
      const { mode, accountLabel, days, confirm } = params as any;
      let q = supabase.from("cached_emails").delete();
      let details: any = { mode };
      if (mode === "all") {
        if (confirm !== "DELETE ALL") throw new Error("Confirmation phrase required");
        q = q.neq("id", "__nonexistent__");
      } else if (mode === "label") {
        if (!accountLabel) throw new Error("accountLabel required");
        q = q.eq("account_label", accountLabel);
        details.accountLabel = accountLabel;
      } else if (mode === "days") {
        const n = Number(days);
        if (!Number.isFinite(n) || n < 0) throw new Error("Valid days required");
        const cutoff = new Date(Date.now() - n * 86400_000).toISOString();
        q = q.lt("date", cutoff);
        details.days = n;
      } else {
        throw new Error("Invalid mode");
      }
      const { error, count } = await q.select("id", { count: "exact", head: true });
      if (error) throw error;
      details.deleted = count || 0;
      await auditLog(supabase, "admin_clear_inbox", session.userId, null, details, ip);
      return new Response(JSON.stringify({ success: true, deleted: count || 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- Notifications: user side ----------
    if (action === "list_notifications") {
      const session = await requireSession(req);
      const nowIso = new Date().toISOString();
      const { data: notes, error: nErr } = await supabase
        .from("notifications")
        .select("id, title, body, audience, target_user_id, created_at, expires_at")
        .or(`audience.eq.all,target_user_id.eq.${session.userId}`)
        .order("created_at", { ascending: false })
        .limit(50);
      if (nErr) throw nErr;
      const active = (notes || []).filter((n: any) => !n.expires_at || n.expires_at > nowIso);
      const ids = active.map((n: any) => n.id);
      let readMap = new Set<string>();
      if (ids.length) {
        const { data: reads } = await supabase
          .from("notification_reads")
          .select("notification_id")
          .in("notification_id", ids)
          .eq("user_id", session.userId);
        readMap = new Set((reads || []).map((r: any) => r.notification_id));
      }
      const payload = active.map((n: any) => ({
        id: n.id, title: n.title, body: n.body, audience: n.audience,
        created_at: n.created_at, expires_at: n.expires_at, read: readMap.has(n.id),
      }));
      return new Response(JSON.stringify({ success: true, notifications: payload }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "mark_notification_read") {
      const session = await requireSession(req);
      const { notification_id } = params as { notification_id?: string };
      if (!notification_id) throw new Error("notification_id required");
      const { error } = await supabase.from("notification_reads").upsert(
        { notification_id, user_id: session.userId },
        { onConflict: "notification_id,user_id" },
      );
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "mark_all_notifications_read") {
      const session = await requireSession(req);
      const nowIso = new Date().toISOString();
      const { data: notes } = await supabase
        .from("notifications")
        .select("id, expires_at")
        .or(`audience.eq.all,target_user_id.eq.${session.userId}`);
      const ids = (notes || []).filter((n: any) => !n.expires_at || n.expires_at > nowIso).map((n: any) => n.id);
      if (ids.length) {
        const rows = ids.map((id: string) => ({ notification_id: id, user_id: session.userId }));
        const { error } = await supabase.from("notification_reads").upsert(rows, { onConflict: "notification_id,user_id" });
        if (error) throw error;
      }
      return new Response(JSON.stringify({ success: true, count: ids.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- Notifications: admin side ----------
    if (action === "admin_create_notification") {
      const session = await requireAdmin(req);
      const { title, body, audience, target_user_id, expiresInDays } = params as any;
      if (!title || !body) throw new Error("Title and body required");
      if (!["all", "user"].includes(audience)) throw new Error("Invalid audience");
      if (audience === "user" && !target_user_id) throw new Error("target_user_id required for user audience");
      const expires_at = expiresInDays && Number(expiresInDays) > 0
        ? new Date(Date.now() + Number(expiresInDays) * 86400_000).toISOString()
        : null;
      const { data, error } = await supabase.from("notifications").insert({
        title: String(title).slice(0, 200),
        body: String(body).slice(0, 4000),
        audience,
        target_user_id: audience === "user" ? target_user_id : null,
        created_by: session.userId,
        expires_at,
      }).select("id").single();
      if (error) throw error;
      await auditLog(supabase, "notification_created", session.userId, data?.id || null, { audience, target_user_id }, ip);
      return new Response(JSON.stringify({ success: true, id: data?.id }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_list_notifications") {
      await requireAdmin(req);
      const { data: notes, error } = await supabase
        .from("notifications")
        .select("id, title, body, audience, target_user_id, created_at, expires_at")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      // Attach read counts
      const ids = (notes || []).map((n: any) => n.id);
      const readCounts = new Map<string, number>();
      if (ids.length) {
        const { data: reads } = await supabase
          .from("notification_reads")
          .select("notification_id")
          .in("notification_id", ids);
        for (const r of reads || []) readCounts.set(r.notification_id, (readCounts.get(r.notification_id) || 0) + 1);
      }
      // Total recipients: for 'all', count non-admin users; for 'user', 1.
      const { count: totalUsers } = await supabase.from("app_users").select("id", { count: "exact", head: true }).neq("role", "admin");
      const payload = (notes || []).map((n: any) => ({
        ...n,
        read_count: readCounts.get(n.id) || 0,
        total_recipients: n.audience === "all" ? (totalUsers || 0) : 1,
      }));
      return new Response(JSON.stringify({ success: true, notifications: payload }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_delete_notification") {
      const session = await requireAdmin(req);
      const { id } = params as { id?: string };
      if (!id) throw new Error("id required");
      const { error } = await supabase.from("notifications").delete().eq("id", id);
      if (error) throw error;
      await auditLog(supabase, "notification_deleted", session.userId, id, {}, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error("Unknown action: " + action);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
