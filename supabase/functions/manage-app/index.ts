import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticator } from "npm:otplib@12.0.1";
import { readRequest, maybeEncryptResponse, EncryptedRequestContext, PlaintextRejectedError, plaintextRejectedResponse, TransportError, transportErrorResponse } from "../_shared/crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token, x-pending-token, x-client-ip, x-crypto-session, x-accept-encoding, x-cron-secret",
};

// Warm-instance memo for bootstrap_public. Deno edge instances stay warm for
// ~15 min; 10-second TTL means at 5k concurrent users we serve most calls from
// this in-memory cache, dropping DB reads + egress on the public bootstrap
// path by ~99%. Invalidated on any admin write to app_users / app_settings
// (see bumpBootstrapVersion below).
let __bootstrapCache: { at: number; payload: any } | null = null;
const BOOTSTRAP_TTL_MS = 10_000;
function invalidateBootstrapCache() { __bootstrapCache = null; }

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

// Verify with the new signing secret first, then fall back to the legacy secret
// so sessions issued before the rotation still work until they expire naturally.
async function verifySessionTokenDual(token: string, primary: string, legacy: string): Promise<Record<string, any> | null> {
  const p = await verifySessionToken(token, primary);
  if (p) return p;
  if (legacy && legacy !== primary) return await verifySessionToken(token, legacy);
  return null;
}


async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyRecaptchaToken(secretKey: string, token: string, ip?: string): Promise<boolean> {
  const body = new URLSearchParams();
  body.set("secret", secretKey);
  body.set("response", token);
  if (ip && ip !== "unknown") body.set("remoteip", ip);

  const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return false;
  const data = await res.json().catch(() => null) as any;
  return data?.success === true;
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

// --- Audit logging (D.3: enriched with user_agent + optional result) ---
async function auditLog(
  supabase: any,
  action: string,
  actorId: string | null,
  targetId: string | null,
  details: any,
  ip: string,
  extras?: { userAgent?: string | null; result?: string | null },
) {
  try {
    await supabase.from("audit_logs").insert({
      action,
      actor_id: actorId,
      target_id: targetId,
      details,
      ip,
      user_agent: extras?.userAgent ?? null,
      result: extras?.result ?? null,
    });
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

function normalizeIp(raw: string | null | undefined): string {
  if (!raw) return "";
  let ip = String(raw).trim().replace(/^"|"$/g, "");
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const bracket = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) return bracket[1].trim();
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");
  return ip.trim();
}

function isPlausibleIp(ip: string): boolean {
  if (!ip) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").every(part => {
      const n = Number(part);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  return /^[0-9a-f:]+$/i.test(ip) && ip.includes(":") && ip.length <= 45;
}

function isKnownEdgeIp(ip: string): boolean {
  // AWS Global Accelerator / Vercel-style edge ranges commonly show up as an
  // intermediate XFF hop. They are infrastructure, not the user's residential IP.
  return /^(13\.248\.|76\.223\.|75\.2\.)/.test(ip || "");
}

function isPublicIp(ip: string): boolean {
  return !!ip && ip !== "unknown" && isPlausibleIp(ip) && !isPrivateIp(ip);
}

function isRealPublicClientIp(ip: string): boolean {
  return isPublicIp(ip) && !isCloudflareIp(ip) && !isKnownEdgeIp(ip);
}

function pickClientIp(candidates: { label: string; ip: string }[]): { ip: string; label: string } {
  const clean = candidates
    .map(c => ({ label: c.label, ip: normalizeIp(c.ip) }))
    .filter(c => c.ip);
  const sel = clean.find(c => c.label === "cf-connecting-ip" && isRealPublicClientIp(c.ip))
    || clean.find(c => c.label === "true-client-ip" && isRealPublicClientIp(c.ip))
    || clean.find(c => c.label === "x-real-ip" && isRealPublicClientIp(c.ip))
    || clean.find(c => c.label === "x-client-ip" && isRealPublicClientIp(c.ip))
    || clean.find(c => c.label === "x-forwarded-for" && isRealPublicClientIp(c.ip))
    || clean.find(c => isRealPublicClientIp(c.ip))
    || clean[0];
  return sel || { ip: "unknown", label: "none" };
}

function collectIpCandidates(req: Request): { label: string; ip: string }[] {
  const out: { label: string; ip: string }[] = [];
  const push = (label: string, val: string | null | undefined) => {
    if (!val) return;
    for (const raw of String(val).split(",")) {
      const ip = normalizeIp(raw);
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
  const picked = pickClientIp(collectIpCandidates(req));
  return isRealPublicClientIp(picked.ip) ? picked.ip : "unknown";
}

function getClientIpTrace(req: Request): { ip: string; source: string; candidates: { label: string; ip: string }[]; cfCountry: string; cfRay: string; workerTrace: any } {
  const candidates = collectIpCandidates(req);
  const picked = pickClientIp(candidates);
  let workerTrace: any = null;
  try {
    const raw = req.headers.get("x-ip-trace");
    if (raw) workerTrace = JSON.parse(raw);
  } catch {}
  const workerCandidates = Array.isArray(workerTrace?.candidates)
    ? workerTrace.candidates.map((c: any) => ({ label: String(c?.h || c?.label || "worker"), ip: normalizeIp(c?.ip) })).filter((c: any) => c.ip)
    : [];
  const combined = [...candidates, ...workerCandidates];
  const best = pickClientIp(combined);
  const safeBest = isRealPublicClientIp(best.ip) ? best : { ip: "unknown", label: "none" };
  return {
    ip: safeBest.ip,
    source: safeBest.label,
    candidates: combined,
    cfCountry: req.headers.get("cf-ipcountry") || workerTrace?.cfCountry || "",
    cfRay: req.headers.get("cf-ray") || workerTrace?.cfRay || "",
    workerTrace,
  };
}

function esc(s: string): string {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanR2Text(value: any): string {
  return typeof value === "string"
    ? value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim()
    : "";
}

function normalizeR2AccessKeyId(value: any): { value: string; warnings: string[]; error?: string } {
  const warnings: string[] = [];
  const raw = cleanR2Text(value);
  const cleaned = raw.replace(/\s+/g, "");
  if (raw && raw !== cleaned) {
    warnings.push("Access Key ID contained whitespace; spaces/newlines were removed.");
  }
  if (/[Oo]/.test(cleaned)) {
    warnings.push("Access Key ID contains the letter O. It is being used exactly as entered — verify Cloudflare shows O, not zero 0.");
  }
  if (cleaned && !/^[A-Za-z0-9]{16,128}$/.test(cleaned)) {
    return {
      value: cleaned,
      warnings,
      error: "Access Key ID looks invalid. Paste the R2 S3 Access Key ID exactly as Cloudflare shows it, without spaces.",
    };
  }
  if (cleaned && cleaned.length !== 32) {
    warnings.push("R2 Access Key IDs are usually 32 characters. The exact value entered is being used for the test.");
  }
  return { value: cleaned, warnings };
}

function normalizeR2Config(raw: any, previousSecret = "") {
  const warnings: string[] = [];
  const errors: string[] = [];
  const accountId = cleanR2Text(raw?.accountId).replace(/\s+/g, "").toLowerCase();
  if (accountId && !/^[a-f0-9]{32}$/.test(accountId)) {
    errors.push("Account ID must be the 32-character Cloudflare Account ID, not a Zone ID.");
  }

  const access = normalizeR2AccessKeyId(raw?.accessKeyId);
  warnings.push(...access.warnings);
  if (access.error) errors.push(access.error);

  const secretAccessKey = (cleanR2Text(raw?.secretAccessKey).replace(/\s+/g, "") || previousSecret || "");
  if (secretAccessKey && !/^[a-f0-9]{64}$/i.test(secretAccessKey)) {
    warnings.push("Secret Access Key does not look like Cloudflare's 64-character R2 S3 secret. If test fails, recreate the R2 API token.");
  }

  const bucket = cleanR2Text(raw?.bucket).replace(/^\/+|\/+$/g, "");
  if (bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    errors.push("Bucket name looks invalid. Use the exact R2 bucket name, case-sensitive, without slashes.");
  }

  const publicBaseUrl = cleanR2Text(raw?.publicBaseUrl).replace(/\s+/g, "").replace(/\/+$/, "");
  if (publicBaseUrl && !/^https:\/\//i.test(publicBaseUrl)) {
    warnings.push("Public Base URL should start with https:// for browser image loading.");
  }

  let pathPrefix = cleanR2Text(raw?.pathPrefix) || "notifications/";
  pathPrefix = pathPrefix.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  if (pathPrefix && !pathPrefix.endsWith("/")) pathPrefix += "/";

  return {
    config: {
      accountId,
      accessKeyId: access.value,
      secretAccessKey,
      bucket,
      publicBaseUrl,
      pathPrefix: pathPrefix || "notifications/",
      enabled: raw?.enabled === true,
    },
    warnings,
    errors,
  };
}

function r2FailureMessage(status: number, body: string, warnings: string[]): string {
  const compactBody = body.replace(/\s+/g, " ").trim().slice(0, 220);
  const xmlTag = (tag: string) => {
    const m = body.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return m?.[1]?.replace(/\s+/g, " ").trim() || "";
  };
  const cfCode = xmlTag("Code");
  const cfMessage = xmlTag("Message");
  const responseText = cfCode
    ? `Cloudflare response: ${cfCode}${cfMessage ? ` — ${cfMessage}` : ""}`
    : compactBody ? `Cloudflare response: ${compactBody}` : "";
  if (status === 401) {
    return [
      `PUT 401 Unauthorized from Cloudflare R2.`,
      "This means R2 rejected the Access Key ID / Secret Access Key / Account ID combination before upload.",
      warnings.length ? `Note: ${warnings.join(" ")}` : "",
      responseText,
    ].filter(Boolean).join(" ");
  }
  if (status === 403) {
    if (/SignatureDoesNotMatch/i.test(cfCode)) {
      return [
        `PUT 403 Forbidden from Cloudflare R2.`,
        "SignatureDoesNotMatch means the Secret Access Key does not match this Access Key ID, or one value was copied/rotated incorrectly. The app now signs using the exact Access Key ID you entered; recreate one R2 API token and paste both values from the same token.",
        warnings.length ? `Note: ${warnings.join(" ")}` : "",
        responseText,
      ].filter(Boolean).join(" ");
    }
    if (/AccessDenied|InvalidAccessKeyId|Unauthorized/i.test(cfCode + " " + cfMessage)) {
      return [
        `PUT 403 Forbidden from Cloudflare R2.`,
        "Cloudflare accepted the request format but rejected access. Check that this token has Object Read & Write permission for this exact bucket.",
        warnings.length ? `Note: ${warnings.join(" ")}` : "",
        responseText,
      ].filter(Boolean).join(" ");
    }
    return [
      `PUT 403 Forbidden from Cloudflare R2.`,
      "Cloudflare rejected the signed upload request.",
      warnings.length ? `Note: ${warnings.join(" ")}` : "",
      responseText,
    ].filter(Boolean).join(" ");
  }
  return `PUT ${status}: ${compactBody}`;
}

// Cache Telegram config in-memory (per-isolate) for 60s to avoid a DB
// round-trip on every alert/OTP send.
let __tgCfgCache: { at: number; cfg: { botToken: string; chatId: string } | null } | null = null;
async function getTelegramConfig(supabase: any): Promise<{ botToken: string; chatId: string } | null> {
  if (__tgCfgCache && Date.now() - __tgCfgCache.at < 60_000) return __tgCfgCache.cfg;
  let cfg: { botToken: string; chatId: string } | null = null;
  try {
    const { data } = await supabase.from("app_settings").select("value").eq("key", "config").single();
    const c = data?.value as any;
    if (c?.TELEGRAM_BOT_TOKEN && c?.TELEGRAM_CHAT_ID) {
      cfg = { botToken: c.TELEGRAM_BOT_TOKEN, chatId: c.TELEGRAM_CHAT_ID };
    }
  } catch {}
  if (!cfg) {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
    if (botToken && chatId) cfg = { botToken, chatId };
  }
  __tgCfgCache = { at: Date.now(), cfg };
  return cfg;
}

// Timeout-guarded Telegram sendMessage. Prevents a stalled Telegram edge
// (occasional 20-30s hangs) from blocking the whole edge-function response.
async function postTelegram(
  tg: { botToken: string; chatId: string },
  payload: Record<string, unknown>,
  timeoutMs = 6000,
): Promise<Response> {
  return await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: tg.chatId, parse_mode: "HTML", disable_web_page_preview: true, ...payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
// Fire-and-forget wrapper for non-critical alerts. Uses EdgeRuntime.waitUntil
// so the response can return immediately while the alert flushes in the bg.
function postTelegramBg(tg: { botToken: string; chatId: string }, payload: Record<string, unknown>) {
  const p = postTelegram(tg, payload, 6000).then(() => {}).catch((e) => console.error("[tg bg] failed:", e));
  const wu = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof wu === "function") wu(p); else void p;
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

type DeviceFingerprint = {
  userAgent?: string;
  platform?: string;
  vendor?: string;
  deviceName?: string;
  deviceModel?: string;
  deviceVendor?: string;
  deviceType?: string;
  deviceInfoSource?: string;
  deviceInfoConfidence?: string;
  osName?: string;
  osVersion?: string;
  browserName?: string;
  browserVersion?: string;
  language?: string;
  languages?: string[];
  screen?: { width: number; height: number; dpr: number; availWidth?: number; availHeight?: number; colorDepth?: number; pixelDepth?: number };
  viewport?: { width: number; height: number };
  orientation?: string;
  timezone?: string;
  utcOffsetMinutes?: number;
  touchPoints?: number;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  cookieEnabled?: boolean;
  onLine?: boolean;
  pdfViewerEnabled?: boolean;
  mobile?: boolean;
  uaBrands?: { brand: string; version: string }[];
  uaPlatform?: string;
  uaPlatformVersion?: string;
  uaModel?: string;
  uaArchitecture?: string;
  uaBitness?: string;
  uaFullVersion?: string;
  network?: { type?: string; effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
  battery?: { level?: number; charging?: boolean; chargingTime?: number; dischargingTime?: number };
  colorScheme?: string;
  reducedMotion?: boolean;
  hdr?: boolean;
  webglVendor?: string;
  webglRenderer?: string;
  canvasHash?: string;
  webdriver?: boolean;
  fingerprintHash?: string;
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
  publicIp?: string;
  publicIpSource?: string;
  device?: DeviceFingerprint;
};

function sanitizeDevice(raw: any): DeviceFingerprint | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const str = (v: any, max = 240) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const bool = (v: any) => (typeof v === "boolean" ? v : undefined);
  const d: DeviceFingerprint = {
    userAgent: str(raw.userAgent, 512),
    platform: str(raw.platform, 64),
    vendor: str(raw.vendor, 64),
    deviceName: str(raw.deviceName, 160),
    deviceModel: str(raw.deviceModel, 128),
    deviceVendor: str(raw.deviceVendor, 64),
    deviceType: str(raw.deviceType, 32),
    deviceInfoSource: str(raw.deviceInfoSource, 32),
    deviceInfoConfidence: str(raw.deviceInfoConfidence, 32),
    osName: str(raw.osName, 48),
    osVersion: str(raw.osVersion, 64),
    browserName: str(raw.browserName, 48),
    browserVersion: str(raw.browserVersion, 64),
    language: str(raw.language, 32),
    languages: Array.isArray(raw.languages) ? raw.languages.filter((l: any) => typeof l === "string").slice(0, 6).map((l: string) => l.slice(0, 32)) : undefined,
    timezone: str(raw.timezone, 64),
    utcOffsetMinutes: num(raw.utcOffsetMinutes),
    touchPoints: num(raw.touchPoints),
    deviceMemory: num(raw.deviceMemory),
    hardwareConcurrency: num(raw.hardwareConcurrency),
    cookieEnabled: bool(raw.cookieEnabled),
    onLine: bool(raw.onLine),
    pdfViewerEnabled: bool(raw.pdfViewerEnabled),
    mobile: bool(raw.mobile),
    uaPlatform: str(raw.uaPlatform, 64),
    uaPlatformVersion: str(raw.uaPlatformVersion, 64),
    uaModel: str(raw.uaModel, 128),
    uaArchitecture: str(raw.uaArchitecture, 32),
    uaBitness: str(raw.uaBitness, 8),
    uaFullVersion: str(raw.uaFullVersion, 64),
    colorScheme: str(raw.colorScheme, 24),
    reducedMotion: bool(raw.reducedMotion),
    hdr: bool(raw.hdr),
    webglVendor: str(raw.webglVendor, 128),
    webglRenderer: str(raw.webglRenderer, 200),
    canvasHash: str(raw.canvasHash, 128),
    webdriver: bool(raw.webdriver),
    fingerprintHash: str(raw.fingerprintHash, 128),
    orientation: str(raw.orientation, 32),
  };
  if (raw.screen && typeof raw.screen === "object") {
    const w = num(raw.screen.width), h = num(raw.screen.height), dpr = num(raw.screen.dpr);
    if (w && h) d.screen = {
      width: w, height: h, dpr: dpr || 1,
      availWidth: num(raw.screen.availWidth), availHeight: num(raw.screen.availHeight),
      colorDepth: num(raw.screen.colorDepth), pixelDepth: num(raw.screen.pixelDepth),
    };
  }
  if (raw.viewport && typeof raw.viewport === "object") {
    const w = num(raw.viewport.width), h = num(raw.viewport.height);
    if (w && h) d.viewport = { width: w, height: h };
  }
  if (raw.network && typeof raw.network === "object") {
    d.network = { type: str(raw.network.type, 32), effectiveType: str(raw.network.effectiveType, 16), downlink: num(raw.network.downlink), rtt: num(raw.network.rtt), saveData: bool(raw.network.saveData) };
  }
  if (raw.battery && typeof raw.battery === "object") {
    d.battery = { level: num(raw.battery.level), charging: bool(raw.battery.charging), chargingTime: num(raw.battery.chargingTime), dischargingTime: num(raw.battery.dischargingTime) };
  }
  if (Array.isArray(raw.uaBrands)) {
    d.uaBrands = raw.uaBrands
      .filter((b: any) => b && typeof b.brand === "string")
      .slice(0, 6)
      .map((b: any) => ({ brand: b.brand.slice(0, 64), version: typeof b.version === "string" ? b.version.slice(0, 32) : "" }));
  }
  return d;
}



function sanitizeClientGeo(input: unknown): ClientGeoPayload | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const allowed = new Set(["granted", "denied", "timeout", "unavailable", "unsupported", "error"]);
  const status = typeof raw.status === "string" && allowed.has(raw.status) ? raw.status : "error";
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  const accuracy = Number(raw.accuracy);
  const publicIp = normalizeIp(typeof raw.publicIp === "string" ? raw.publicIp : "");
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
    publicIp: isRealPublicClientIp(publicIp) ? publicIp : undefined,
    publicIpSource: isRealPublicClientIp(publicIp) ? "browser-ipwho.is" : undefined,
    device: sanitizeDevice((raw as any).device),
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
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip)) return null;
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
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip)) return null;
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
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip)) return null;
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
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip)) return null;
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
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip)) return null;
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
  const lat = geo.latitude, lng = geo.longitude;

  // Provider 1: BigDataCloud (fast, generous free tier, no key)
  const tryBdc = async (): Promise<LocResult | null> => {
    try {
      const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
      const r = await fetchWithTimeout(url, 3500);
      if (!r.ok) return null;
      const d = await r.json();
      const countryCode = d.countryCode || d.principalSubdivisionCode?.split("-")?.[0];
      const city = d.city || d.locality || d.localityInfo?.administrative?.[3]?.name || d.localityInfo?.administrative?.[2]?.name;
      if (!city && !d.principalSubdivision && !d.countryName) return null;
      return {
        provider: "device-gps",
        country: d.countryName, countryCode,
        region: d.principalSubdivision,
        city,
        postal: d.postcode,
        lat, lng,
        timezone: d.localityInfo?.informative?.find?.((x: any) => x?.description === "time zone")?.name,
        flag: countryToFlag(countryCode),
      };
    } catch { return null; }
  };

  // Provider 2: OpenStreetMap Nominatim (very accurate, free, requires UA)
  const tryNominatim = async (): Promise<LocResult | null> => {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`;
      const r = await fetchWithTimeout(url, 4000, { headers: { "User-Agent": "netflix-otp-manager/1.0 (login-alerts)", "Accept-Language": "en" } as any });
      if (!r.ok) return null;
      const d = await r.json();
      const a = d.address || {};
      const city = a.city || a.town || a.village || a.municipality || a.suburb || a.county || a.state_district;
      const countryCode = (a.country_code || "").toUpperCase();
      if (!city && !a.state && !a.country) return null;
      return {
        provider: "device-gps",
        country: a.country, countryCode,
        region: a.state || a.region,
        city, postal: a.postcode,
        lat, lng,
        flag: countryToFlag(countryCode),
      };
    } catch { return null; }
  };

  // Try both in parallel; prefer whichever returns a city first.
  const [a, b] = await Promise.all([tryBdc(), tryNominatim()]);
  const pick = (a?.city ? a : (b?.city ? b : (a || b)));
  if (pick) return pick;

  return { provider: "device-gps", lat, lng, flag: "📍" };
}


// Dedicated VPN/proxy detector (proxycheck.io — 1000/day free without key)
async function detectAnonymizer(ip: string): Promise<{ proxy: boolean; vpn: boolean; tor: boolean; hosting: boolean; type?: string; provider?: string } | null> {
  try {
    if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip)) return null;
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
  if (!ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip)) {
    console.warn("[resolveLocation] refusing lookup — invalid client IP:", JSON.stringify({ ip, reason: !ip || ip === "unknown" ? "missing" : isPrivateIp(ip) ? "private" : isCloudflareIp(ip) ? "cloudflare-edge" : "hosting-edge-hop" }));
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

function parseUserAgent(ua: string): { browser: string; browserVersion?: string; os: string; osVersion?: string } {
  const s = ua || "";
  let browser = "Unknown"; let browserVersion: string | undefined;
  const m = (re: RegExp) => { const r = s.match(re); return r?.[1]; };
  if (/Edg\//.test(s)) { browser = "Edge"; browserVersion = m(/Edg\/([\d.]+)/); }
  else if (/OPR\/|Opera/.test(s)) { browser = "Opera"; browserVersion = m(/OPR\/([\d.]+)/); }
  else if (/SamsungBrowser\//.test(s)) { browser = "Samsung Internet"; browserVersion = m(/SamsungBrowser\/([\d.]+)/); }
  else if (/MiuiBrowser\//.test(s)) { browser = "Mi Browser"; browserVersion = m(/MiuiBrowser\/([\d.]+)/); }
  else if (/Chrome\//.test(s) && !/Edg\//.test(s)) { browser = "Chrome"; browserVersion = m(/Chrome\/([\d.]+)/); }
  else if (/Firefox\//.test(s)) { browser = "Firefox"; browserVersion = m(/Firefox\/([\d.]+)/); }
  else if (/Safari\//.test(s) && !/Chrome\//.test(s)) { browser = "Safari"; browserVersion = m(/Version\/([\d.]+)/); }
  let os = "Unknown"; let osVersion: string | undefined;
  if (/Windows NT/.test(s)) { os = "Windows"; const v = m(/Windows NT ([\d.]+)/); const map: Record<string,string> = {"10.0":"10/11","6.3":"8.1","6.2":"8","6.1":"7"}; osVersion = v ? (map[v] || v) : undefined; }
  else if (/Android/.test(s)) { os = "Android"; osVersion = m(/Android ([\d.]+)/); }
  else if (/iPhone|iPad|iPod/.test(s)) { os = /iPad/.test(s) ? "iPadOS" : "iOS"; osVersion = (m(/OS ([\d_]+)/) || "").replace(/_/g, "."); }
  else if (/Mac OS X/.test(s)) { os = "macOS"; osVersion = (m(/Mac OS X ([\d_.]+)/) || "").replace(/_/g, "."); }
  else if (/CrOS/.test(s)) { os = "ChromeOS"; }
  else if (/Linux/.test(s)) { os = "Linux"; }
  return { browser, browserVersion, os, osVersion };
}

function normalizedVersion(value?: string) {
  const v = String(value || "").trim();
  if (!v) return "";
  const parts = v.split(".").filter(Boolean);
  if (parts.length >= 2 && parts.slice(1).every((p) => p === "0")) return parts[0];
  return parts.slice(0, 3).join(".");
}

function isReliableDeviceModel(model?: string) {
  const m = String(model || "").trim();
  return !!m && m.length >= 2 && !/^(k|android|mobile|linux|build|wv|unknown|generic)$/i.test(m);
}

function normalizeDeviceIdentity(ua: string, device?: DeviceFingerprint): { model: string; type: string; vendor: string; source: string; confidence: string } {
  const inferred = inferDeviceModel(ua, device);
  const model = isReliableDeviceModel(device?.deviceModel) ? device!.deviceModel! : isReliableDeviceModel(device?.uaModel) ? device!.uaModel! : inferred.model;
  const type = device?.deviceType || inferred.type;
  const vendor = device?.deviceVendor || inferred.vendor;
  const source = device?.deviceInfoSource || (isReliableDeviceModel(device?.uaModel) ? "ua-ch" : "ua/fallback");
  const confidence = device?.deviceInfoConfidence || (isReliableDeviceModel(device?.uaModel) ? "high" : isReliableDeviceModel(model) ? "medium" : "low");
  return { model, type, vendor, source, confidence };
}

function inferDeviceModel(ua: string, device?: DeviceFingerprint): { model: string; type: string; vendor: string } {
  const s = ua || "";
  let model = isReliableDeviceModel(device?.uaModel) ? device!.uaModel! : "";
  let vendor = "";
  let type = "Desktop";
  const mobile = device?.mobile ?? /Mobi|Android|iPhone|iPod/.test(s);
  const tablet = /iPad|Tablet|Nexus 7|Nexus 10|SM-T\d/.test(s);
  type = tablet ? "Tablet" : mobile ? "Mobile" : "Desktop";
  if (!model) {
    if (/iPhone/.test(s)) { model = "iPhone"; vendor = "Apple"; }
    else if (/iPad/.test(s)) { model = "iPad"; vendor = "Apple"; }
    else if (/iPod/.test(s)) { model = "iPod"; vendor = "Apple"; }
    else {
      const andm = s.match(/Android[^;]*;\s*[^;]*;\s*([^;)]+)\s+Build/) || s.match(/;\s*([^;)]+)\)\s+AppleWebKit/);
      if (andm) model = andm[1].trim();
      const m2 = s.match(/;\s*([A-Z]{1,4}-[A-Z0-9]+)\s/i); if (m2 && !model) model = m2[1];
    }
  }
  if (!vendor) {
    if (/Samsung|SM-|GT-/.test(s + " " + model)) vendor = "Samsung";
    else if (/Xiaomi|Redmi|MI |POCO/i.test(s + " " + model)) vendor = "Xiaomi";
    else if (/OnePlus/i.test(s + " " + model)) vendor = "OnePlus";
    else if (/Pixel/i.test(s + " " + model)) vendor = "Google";
    else if (/HUAWEI|Honor/i.test(s + " " + model)) vendor = "Huawei";
    else if (/Realme/i.test(s + " " + model)) vendor = "Realme";
    else if (/OPPO/i.test(s + " " + model)) vendor = "Oppo";
    else if (/Vivo/i.test(s + " " + model)) vendor = "Vivo";
    else if (/Motorola|Moto /i.test(s + " " + model)) vendor = "Motorola";
    else if (/Apple|iPhone|iPad|Macintosh/.test(s)) vendor = "Apple";
    else if (/Windows/.test(s)) vendor = "PC";
  }
  if (!model && device?.uaPlatform && device.uaPlatform !== "Android") model = `${device.uaPlatform}${device.uaPlatformVersion ? " " + normalizedVersion(device.uaPlatformVersion) : ""}`;
  if (!model) model = type;
  return { model, type, vendor };
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
  const forwardedUa = clientGeo?.device?.userAgent || req.headers.get("x-client-user-agent") || req.headers.get("user-agent") || "";
  const parsedUa = parseUserAgent(forwardedUa);
  const identity = normalizeDeviceIdentity(forwardedUa, clientGeo?.device);
  const browser = clientGeo?.device?.browserName || parsedUa.browser;
  const browserVersion = clientGeo?.device?.browserVersion || parsedUa.browserVersion;
  const os = clientGeo?.device?.osName || parsedUa.os;
  const osVersion = clientGeo?.device?.osVersion || parsedUa.osVersion;
  const browserStr = `${browser}${browserVersion ? " " + normalizedVersion(browserVersion) : ""}`;
  const osStr = `${os}${osVersion ? " " + normalizedVersion(osVersion) : ""}`;
  const deviceStr = `${identity.vendor ? identity.vendor + " " : ""}${identity.model}${identity.model !== identity.type ? ` (${identity.type})` : ""}`;
  const deviceConfidenceLine = identity.confidence !== "high"
    ? `ℹ️ Device model exact name hidden by browser privacy; showing best stable value (${esc(identity.source)} · ${esc(identity.confidence)}).`
    : `✅ Device model verified by browser Client Hints (${esc(identity.source)}).`;
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

  const isInvalidEdgeIp = !ip || ip === "unknown" || isPrivateIp(ip) || isCloudflareIp(ip) || isKnownEdgeIp(ip);
  const isAnon = !isGps && !!(ipLoc.vpn || ipLoc.proxy || ipLoc.tor || ipLoc.hosting || anonymizer?.vpn || anonymizer?.proxy || anonymizer?.tor || anonymizer?.hosting);
  const anonBadge = (ipLoc.tor || anonymizer?.tor) ? "🧅 TOR" : (ipLoc.vpn || anonymizer?.vpn) ? "🛡 VPN" : (ipLoc.proxy || anonymizer?.proxy) ? "🎭 PROXY" : (ipLoc.hosting || anonymizer?.hosting) ? "🖥 HOSTING/DC" : "";
  const anonNote = isAnon
    ? `⚠️ <b>Network IP is masked</b> — ${anonBadge}${anonymizer?.provider ? ` · <i>${esc(anonymizer.provider)}</i>` : ""}\n<i>No device GPS was available, so IP location may be only a VPN/proxy exit-node.</i>`
    : "";

  const gpsLine = clientGeo?.status === "granted"
    ? `🛰 <b>GPS:</b> granted · accuracy ${clientGeo.accuracy ? `±${esc(String(clientGeo.accuracy))}m` : "unknown"}${clientGeo.timestamp ? ` · fix ${esc(new Date(clientGeo.timestamp).toISOString())}` : ""}`
    : `🛰 <b>GPS:</b> ${esc(clientGeo?.status || "not sent")}${clientGeo?.permissionState ? ` · permission ${esc(clientGeo.permissionState)}` : ""}${clientGeo?.error ? ` · ${esc(clientGeo.error)}` : ""}`;

  const locationSource = isGps ? "Device GPS (exact)" : "IP lookup (approximate — may be VPN/proxy)";

  const networkIpLine = isInvalidEdgeIp
    ? `🌐 <b>Network IP:</b> <code>unavailable</code> <i>(only edge/proxy hop seen${ip && ip !== "unknown" ? `: ${esc(ip)}` : ""})</i>`
    : `🌐 <b>Network IP:</b> <code>${esc(ip)}</code>`;
  const ipTraceLine = ipTrace ? `🧭 <b>IP source:</b> <code>${esc(ipTrace.source)}</code>${ipTrace.cfCountry ? ` · CF ${esc(ipTrace.cfCountry)}` : ""}${ipTrace.candidates?.length ? ` · checked ${ipTrace.candidates.length}` : ""}` : "";

  const statusBanner = status === "success"
    ? `✅ <b>LOGIN SUCCESS</b>`
    : `❌ <b>LOGIN FAILED</b>`;
  const roleBadge = role === "admin" ? "👑 ADMIN" : "👤 USER";
  const gpsBadge = isGps ? "🎯 <b>GPS LOCKED</b>" : "📡 <b>IP APPROX</b>";
  const trustBadge = isGps
    ? `🟢 <b>TRUSTED</b> · GPS ±${esc(String(clientGeo?.accuracy || "?"))}m`
    : (isAnon ? `🔴 <b>MASKED</b> · ${anonBadge}` : `🟡 <b>NETWORK ONLY</b>`);
  const cityLine = [loc.city, loc.region, loc.country].filter(Boolean).join(", ") || "Unknown";
  const coordsLine = (typeof mapLat === "number" && typeof mapLng === "number")
    ? `<code>${mapLat.toFixed(6)}, ${mapLng.toFixed(6)}</code>` : "<code>—</code>";
  const screenLine = clientGeo?.device?.screen ? `${clientGeo.device.screen.width}×${clientGeo.device.screen.height} @${clientGeo.device.screen.dpr}x` : "";

  const headline = status === "success"
    ? `🟢  <b>SIGN-IN SUCCESS</b>`
    : `🔴  <b>SIGN-IN BLOCKED</b>`;
  const roleChip = role === "admin" ? "👑 Admin" : "👤 Member";
  const trustLabel = isGps
    ? `🟢 Trusted <i>· GPS ±${esc(String(clientGeo?.accuracy || "?"))}m</i>`
    : (isAnon ? `🔴 Masked <i>· ${anonBadge}</i>` : `🟡 Network only`);
  const sourceLabel = isGps ? "🎯 GPS Lock" : "📡 IP Approx";
  const ispRaw = (ipLoc.isp || ipLoc.org || loc.isp || loc.org || "Unknown ISP").slice(0, 60);
  const asnRaw = ((ipLoc.asn || loc.asn) || "").toString().split(" ")[0] || "";
  const tzRaw = loc.timezone || clientGeo?.device?.timezone || "";
  const coordsRaw = (typeof mapLat === "number" && typeof mapLng === "number")
    ? `${mapLat.toFixed(6)}, ${mapLng.toFixed(6)}` : "";
  const div = `<i>────────────────────</i>`;
  const bar = "▎";

  // Copy-friendly one-liner in a <pre> block (Telegram shows a copy icon on <pre>).
  const summaryOneLiner =
    `${displayName} @${user?.username || ""}\n` +
    `IP  : ${ip || "n/a"}\n` +
    `ISP : ${ispRaw}${asnRaw ? "  (" + asnRaw + ")" : ""}\n` +
    `Geo : ${cityLine}${coordsRaw ? "  [" + coordsRaw + "]" : ""}\n` +
    `Dev : ${deviceStr} [${identity.confidence}]\n` +
    `UA  : ${browserStr} · ${osStr}\n` +
    `Time: ${time}`;

  // Optional expandable raw details (UA + trace) for power users.
  const rawDetails =
    `User-Agent:\n${forwardedUa || "n/a"}\n\n` +
    `IP trace source: ${ipTrace?.source || "n/a"}\n` +
    `Candidates checked: ${ipTrace?.candidates?.length || 0}\n` +
    (ipTrace?.cfCountry ? `CF country: ${ipTrace.cfCountry}\n` : "") +
    (ipTrace?.cfRay ? `CF ray: ${ipTrace.cfRay}\n` : "") +
    `GPS status: ${clientGeo?.status || "not sent"}` +
    (clientGeo?.permissionState ? ` (permission ${clientGeo.permissionState})` : "");

  const text = [
    headline,
    ``,
    `${roleChip}  <b>${esc(displayName)}</b>  <i>@${esc(user?.username || "")}</i>`,
    `🕐 <i>${esc(time)}</i>`,
    ``,
    ``,
    `${bar} 📍 <b>LOCATION</b>   <i>· ${sourceLabel}</i>`,
    ``,
    `${flag}  <b>${esc(cityLine)}</b>${loc.postal ? ` <i>· ${esc(loc.postal)}</i>` : ""}`,
    coordsRaw ? `` : null,
    coordsRaw ? `🧭  <code>${esc(coordsRaw)}</code>` : null,
    mapLink ? `` : null,
    mapLink ? `🗺  <a href="${mapLink}"><b>Open in Google Maps →</b></a>` : null,
    ``,
    ``,
    `${bar} 🌐 <b>NETWORK</b>   <i>· ${trustLabel}</i>`,
    ``,
    isInvalidEdgeIp
      ? `IP     <i>unavailable (edge hop${ip && ip !== "unknown" ? ": " + esc(ip) : ""})</i>`
      : `IP     <code>${esc(ip)}</code>`,
    ``,
    `ISP    ${esc(ispRaw)}`,
    asnRaw || tzRaw ? `` : null,
    asnRaw ? `ASN    <code>${esc(asnRaw)}</code>${tzRaw ? `   <i>· ${esc(tzRaw)}</i>` : ""}` : (tzRaw ? `TZ     <i>${esc(tzRaw)}</i>` : null),
    ``,
    ``,
    `${bar} 📱 <b>DEVICE</b>`,
    ``,
    `<b>${esc(deviceStr)}</b>`,
    `<i>${deviceConfidenceLine}</i>`,
    ``,
    `🌐 ${esc(browserStr)}    💻 ${esc(osStr)}`,
    screenLine ? `` : null,
    screenLine ? `🖥 <i>${screenLine}</i>` : null,
    anonNote ? `` : null,
    anonNote ? `⚠️ <b>Anonymizer detected</b> — ${anonBadge}${anonymizer?.provider ? ` <i>· ${esc(anonymizer.provider)}</i>` : ""}` : null,
    anonNote ? `<i>No device GPS available — IP may be a VPN/proxy exit-node.</i>` : null,
    ``,
    ``,
    `${bar} 📋 <b>QUICK COPY</b>  <i>· tap the block below to copy</i>`,
    ``,
    `<pre>${esc(summaryOneLiner)}</pre>`,
    ``,
    `<blockquote expandable><b>🔎 Raw technical details</b>\n${esc(rawDetails)}</blockquote>`,
  ].filter((l) => l !== null).join("\n");


  try {
    const tgRes = await postTelegram(tg, { text });
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
    await postTelegram(tg, { text });
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
    const headerIpTrace = getClientIpTrace(req);
    const clientGeo = sanitizeClientGeo(rawClientGeo);
    const ipTrace = clientGeo?.publicIp
      ? {
          ...headerIpTrace,
          ip: clientGeo.publicIp,
          source: clientGeo.publicIpSource || "browser-ipwho.is",
          candidates: [{ label: clientGeo.publicIpSource || "browser-ipwho.is", ip: clientGeo.publicIp }, ...headerIpTrace.candidates],
        }
      : headerIpTrace;
    const ip = ipTrace.ip;

    // Check admin toggle FIRST so ipwho.is is fully skipped when disabled.
    let ipwhoEnabled = false;
    try {
      const { data } = await supabase.from("app_settings").select("value").eq("key", "ipwho_alert").single();
      ipwhoEnabled = data?.value?.enabled === true;
    } catch {}

    // ---- Explicit debug block (per spec) ----
    const hdr = (n: string) => req.headers.get(n) || "";
    console.log(
      "\n=== [login-notify] IP TRACE ===\n" +
      "Detected Headers:\n" +
      `  CF-Connecting-IP: ${hdr("cf-connecting-ip")}\n` +
      `  True-Client-IP:   ${hdr("true-client-ip")}\n` +
      `  X-Forwarded-For:  ${hdr("x-forwarded-for")}\n` +
      `  X-Real-IP:        ${hdr("x-real-ip")}\n` +
      `  X-Client-IP:      ${hdr("x-client-ip")} (from Cloudflare Worker)\n` +
      `Selected Client IP: ${ip}   (source: ${ipTrace.source})\n` +
      `Browser Public IP: ${clientGeo?.publicIp || "not sent"}   (source: ${clientGeo?.publicIpSource || "none"})\n` +
      `CF Country: ${ipTrace.cfCountry}   CF Ray: ${ipTrace.cfRay}\n` +
      `Worker Trace: ${JSON.stringify(ipTrace.workerTrace || {})}\n` +
      `ipwho.is enabled by admin: ${ipwhoEnabled}\n` +
      `Client GPS: ${clientGeo?.status || "none"}${clientGeo?.status === "granted" ? ` (${clientGeo.latitude},${clientGeo.longitude})` : ""}\n` +
      "==============================="
    );


    const [locRes, gpsLoc] = await Promise.all([
      resolveLocation(ip, { allowIpwho: ipwhoEnabled || !!clientGeo?.publicIp }),
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

    // ----- Persist rich login event -----
    try {
      await persistLoginEvent(supabase, req, user, status, ip, ipTrace, clientGeo, merged, gpsLoc, anonymizer);
    } catch (e) {
      console.error("[login_events] insert failed:", e);
    }
  } catch (err) {
    console.error("[notification] login notify failed:", err);
  }
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function persistLoginEvent(
  supabase: any, req: Request, user: any, status: "success" | "failed",
  ip: string, ipTrace: any, clientGeo: ClientGeoPayload | null,
  merged: LocResult, gpsLoc: LocResult | null,
  anonymizer: { proxy: boolean; vpn: boolean; tor: boolean; hosting: boolean; type?: string; provider?: string } | null,
) {
  const dev = clientGeo?.device || {};
  const forwardedUa = dev.userAgent || req.headers.get("x-client-user-agent") || req.headers.get("user-agent") || "";
  const parsedUa = parseUserAgent(forwardedUa);
  const identity = normalizeDeviceIdentity(forwardedUa, dev);
  const browser = dev.browserName || parsedUa.browser;
  const browserVersion = dev.browserVersion || parsedUa.browserVersion;
  const os = dev.osName || parsedUa.os;
  const osVersion = dev.osVersion || parsedUa.osVersion;
  const fpHash = dev.fingerprintHash || null;

  // is_new_device: fingerprint (or user_agent) not seen for this user in past 90d
  let isNewDevice = true;
  try {
    if (user?.id && fpHash) {
      const { data: prev } = await supabase.from("login_events")
        .select("id").eq("user_id", user.id).eq("fingerprint_hash", fpHash).limit(1);
      isNewDevice = !prev || prev.length === 0;
    }
  } catch {}

  // impossible_travel: compare against last successful login within 12h
  let impossibleTravel = false;
  try {
    if (user?.id && clientGeo?.status === "granted" && typeof clientGeo.latitude === "number") {
      const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
      const { data: last } = await supabase.from("login_events")
        .select("gps_lat, gps_lon, ip_lat, ip_lon, created_at")
        .eq("user_id", user.id).eq("event", "login_success")
        .gte("created_at", since).order("created_at", { ascending: false }).limit(1);
      const prev = last?.[0];
      if (prev) {
        const lat = prev.gps_lat ?? prev.ip_lat, lon = prev.gps_lon ?? prev.ip_lon;
        if (typeof lat === "number" && typeof lon === "number") {
          const km = haversineKm({ lat, lng: lon }, { lat: clientGeo.latitude!, lng: clientGeo.longitude! });
          const hours = (Date.now() - new Date(prev.created_at).getTime()) / 3600000;
          if (hours > 0 && km / hours > 900) impossibleTravel = true;
        }
      }
    }
  } catch {}

  const isGps = clientGeo?.status === "granted";
  const reasons: string[] = [];
  if (anonymizer?.vpn || merged.vpn) reasons.push("vpn");
  if (anonymizer?.proxy || merged.proxy) reasons.push("proxy");
  if (anonymizer?.tor || merged.tor) reasons.push("tor");
  if (anonymizer?.hosting || merged.hosting) reasons.push("hosting");
  if (dev.webdriver) reasons.push("webdriver");
  if (isNewDevice) reasons.push("new_device");
  if (impossibleTravel) reasons.push("impossible_travel");
  if (status === "failed") reasons.push("auth_failed");

  let risk: "safe" | "medium" | "high" | "critical" = "safe";
  if (impossibleTravel || reasons.includes("tor")) risk = "critical";
  else if (reasons.includes("vpn") || reasons.includes("proxy") || reasons.includes("webdriver")) risk = "high";
  else if (reasons.includes("hosting") || (isNewDevice && !isGps)) risk = "medium";

  const row: Record<string, any> = {
    user_id: user.id, username: user.username, role: user.role,
    event: status === "success" ? "login_success" : "login_failed",
    ip: ip || null, ip_source: ipTrace?.source || null,
    isp: merged.isp || null, asn: merged.asn || null, org: merged.org || null,
    country: merged.country || null, country_code: merged.countryCode || null,
    region: merged.region || null, city: merged.city || null, zip: merged.postal || null,
    ip_lat: typeof merged.lat === "number" ? merged.lat : null,
    ip_lon: typeof merged.lng === "number" ? merged.lng : null,
    timezone: merged.timezone || dev.timezone || null,
    utc_offset: typeof dev.utcOffsetMinutes === "number" ? String(dev.utcOffsetMinutes) : null,
    is_proxy: !!(merged.proxy || anonymizer?.proxy), is_vpn: !!(merged.vpn || anonymizer?.vpn),
    is_tor: !!(merged.tor || anonymizer?.tor), is_hosting: !!(merged.hosting || anonymizer?.hosting),
    gps_lat: isGps ? clientGeo!.latitude : null, gps_lon: isGps ? clientGeo!.longitude : null,
    gps_accuracy: isGps ? clientGeo!.accuracy : null,
    gps_altitude: isGps ? (clientGeo!.altitude ?? null) : null,
    gps_heading: isGps ? (clientGeo!.heading ?? null) : null,
    gps_speed: isGps ? (clientGeo!.speed ?? null) : null,
    gps_captured_at: isGps && clientGeo!.timestamp ? new Date(clientGeo!.timestamp).toISOString() : null,
    device_type: identity.type || null, device_brand: identity.vendor || null, device_model: identity.model || null,
    os_name: os || null, os_version: osVersion ? normalizedVersion(osVersion) : null,
    browser_name: browser || null, browser_version: browserVersion ? normalizedVersion(browserVersion) : null,
    user_agent: forwardedUa || null, platform: dev.platform || null,
    languages: Array.isArray(dev.languages) ? dev.languages : null,
    hardware_concurrency: typeof dev.hardwareConcurrency === "number" ? dev.hardwareConcurrency : null,
    device_memory: typeof dev.deviceMemory === "number" ? dev.deviceMemory : null,
    screen_w: dev.screen?.width ?? null, screen_h: dev.screen?.height ?? null,
    viewport_w: dev.viewport?.width ?? null, viewport_h: dev.viewport?.height ?? null,
    color_depth: dev.screen?.colorDepth ?? null,
    pixel_ratio: dev.screen?.dpr ?? null,
    orientation: dev.orientation || null,
    network_type: dev.network?.effectiveType || dev.network?.type || null,
    downlink: dev.network?.downlink ?? null, rtt: dev.network?.rtt ?? null,
    save_data: dev.network?.saveData ?? null,
    battery_level: dev.battery?.level ?? null, battery_charging: dev.battery?.charging ?? null,
    fingerprint_hash: fpHash, is_new_device: isNewDevice, impossible_travel: impossibleTravel,
    risk_score: risk, risk_reasons: reasons.length ? reasons : null,
    raw: { clientGeo, ipTrace, merged, anonymizer, dev },
  };
  const { error } = await supabase.from("login_events").insert(row);
  if (error) console.error("[login_events] insert error:", error.message);

  // If new device and login success, notify admin via notifications table
  if (status === "success" && isNewDevice) {
    try {
      const body = `${devVendor || ""} ${devModel || devType || "device"} · ${browser || "browser"} on ${os || "OS"} · ${merged.city || ""} ${merged.country || ""} · IP ${ip || "?"}`.trim();
      await supabase.from("notifications").insert({
        title: `🆕 New device login: ${user.username}`,
        body,
        audience: "admins",
        target_user_id: null,
        created_by: user.id,
      });
    } catch (e) { console.warn("[login_events] new-device notify failed:", e); }
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

async function reencryptForWorker(value: any, sourceSecret: string, workerSecret: string) {
  if (!value || typeof value !== "string") return value || "";
  const plain = value.startsWith("enc:") ? await decryptValue(value, sourceSecret) : value;
  return await encryptValue(plain, workerSecret);
}

async function buildInboxWorkerConfig(supabase: any, workerSecret: string, sourceSecret: string) {
  const keys = ["config", "email_accounts", "email_filters", "email_visibility", "primary_cloudflare_urls"];
  const { data } = await supabase.from("app_settings").select("key,value").in("key", keys);
  const settings = new Map<string, any>();
  for (const row of data || []) settings.set(row.key, row.value);
  const rawConfig = settings.get("config") || {};
  const config = { ...rawConfig };
  if (config.IMAP_PASSWORD) config.IMAP_PASSWORD = await reencryptForWorker(config.IMAP_PASSWORD, sourceSecret, workerSecret);
  const rawAccounts = Array.isArray(settings.get("email_accounts")) ? settings.get("email_accounts") : [];
  const emailAccounts = await Promise.all(rawAccounts.map(async (acc: any) => ({
    ...acc,
    password: acc?.password ? await reencryptForWorker(acc.password, sourceSecret, workerSecret) : acc?.password,
  })));
  return {
    config,
    email_accounts: emailAccounts,
    email_filters: settings.get("email_filters") || {},
    email_visibility: settings.get("email_visibility") || {},
    primary_cloudflare_urls: Array.isArray(settings.get("primary_cloudflare_urls")) ? settings.get("primary_cloudflare_urls") : [],
  };
}

async function pushInboxConfigToWorkers(supabase: any, signingSecret: string, encryptionSecret: string) {
  if (!signingSecret) return;
  const workerUrls = await loadWorkerUrls(supabase);
  const config = await buildInboxWorkerConfig(supabase, signingSecret, encryptionSecret);
  const urls = Array.from(new Set(workerUrls.map((u) => String(u || "").trim().replace(/\/+$/, "")).filter(Boolean)));
  if (urls.length === 0) return;
  await Promise.allSettled(urls.map(async (base) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      await fetch(`${base}/api/config/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Worker-Config-Secret": signingSecret },
        body: JSON.stringify(config),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }));
}

Deno.serve(async (originalReq) => {
  if (originalReq.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ---- transport encryption boundary ----
  let __ctx: EncryptedRequestContext | null = null;
  let __parsedBody: any = null;
  try {
    const __r = await readRequest(originalReq);
    __parsedBody = __r.body ?? {};
    __ctx = __r.encrypted ? __r.ctx : null;
  } catch (e) {
    if (e instanceof PlaintextRejectedError) return plaintextRejectedResponse();
    if (e instanceof TransportError) return transportErrorResponse(e);
    return new Response(JSON.stringify({ success: false, error: "bad request" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const req = new Request(originalReq.url, {
    method: originalReq.method,
    headers: originalReq.headers,
    body: JSON.stringify(__parsedBody ?? {}),
  });



  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // F5: split signing key (session tokens) from encryption key (IMAP passwords).
  // ENCRYPTION_SECRET must remain SUPABASE_SERVICE_ROLE_KEY so existing AES-GCM
  // ciphertexts in app_settings.email_accounts can still be decrypted.
  const ENCRYPTION_SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SIGNING_SECRET = Deno.env.get("SESSION_SIGNING_SECRET") || ENCRYPTION_SECRET;
  const LEGACY_SIGNING = ENCRYPTION_SECRET;

  const ip = getClientIp(req);

  // C.3 device binding: sha256(ua + accept-language + ip/24). /24 (not /32) so
  // mobile carrier NAT doesn't invalidate legitimate sessions.
  async function computeBindingHash(r: Request): Promise<string> {
    const ua = (r.headers.get("user-agent") || "").trim();
    const al = (r.headers.get("accept-language") || "").split(",")[0]?.trim() || "";
    const rawIp = getClientIp(r) || "";
    let ipPrefix = rawIp;
    const v4 = rawIp.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
    if (v4) ipPrefix = `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
    // IPv6: keep first 4 groups (/64) as coarse binding
    else if (rawIp.includes(":")) ipPrefix = rawIp.split(":").slice(0, 4).join(":") + "::/64";
    return await sha256Hex(`${ua}|${al}|${ipPrefix}`);
  }

  // --- Persist a session row in DB (source of truth for logged-in status) ---
  async function persistSession(userId: string, role: string, token: string, expiresAtMs: number) {
    const tokenHash = await sha256Hex(token);
    const ua = req.headers.get("user-agent") || null;
    const bindingHash = await computeBindingHash(req);
    await supabase.from("app_sessions").insert({
      user_id: userId,
      role,
      token_hash: tokenHash,
      expires_at: new Date(expiresAtMs).toISOString(),
      ip,
      user_agent: ua,
      binding_hash: bindingHash,
    });
    // Best-effort cleanup of expired rows for this user
    supabase.from("app_sessions").delete().lt("expires_at", new Date().toISOString()).eq("user_id", userId).then(() => {});
  }

  // Realtime Broadcast — instant remote logout. Sends one WebSocket-delivered
  // message (~50 bytes) to `session-family-<uuid>` channels so old devices log
  // out within ~1s. No polling, no DB egress spike.
  async function broadcastSessionRevoked(familyIds: string[], reason: string): Promise<void> {
    if (!familyIds.length) return;
    const url = `${Deno.env.get("SUPABASE_URL")}/realtime/v1/api/broadcast`;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const messages = familyIds.map((fid) => ({
      topic: `session-family-${fid}`,
      event: "revoked",
      payload: { reason, at: Date.now() },
      private: false,
    }));
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
        body: JSON.stringify({ messages }),
      });
    } catch (e) {
      console.warn("[broadcast] failed:", (e as any)?.message || e);
    }
  }


  // C.2 refresh-token rotation: mint access+refresh pair inside one session
  // family. Access TTL 15 min, refresh TTL 12 h. Refresh rotates on every use;
  // reuse of a rotated refresh token revokes the whole family (see refresh_session action).
  function b64url(bytes: Uint8Array): string {
    let s = ""; for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function mintSessionPair(
    userId: string,
    role: string,
    accessPayload: Record<string, any>,
    opts?: { familyId?: string; parentSessionId?: string | null },
  ): Promise<{ accessToken: string; accessExpMs: number; refreshToken: string; refreshExpMs: number; familyId: string; sessionRowId: string }> {
    const ACCESS_TTL_MS = 15 * 60 * 1000;
    const REFRESH_TTL_MS = 12 * 60 * 60 * 1000;
    const now = Date.now();
    const accessExpMs = now + ACCESS_TTL_MS;
    const refreshExpMs = now + REFRESH_TTL_MS;
    const familyId = opts?.familyId || crypto.randomUUID();
    const refreshToken = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const accessToken = await createSessionToken({ ...accessPayload, exp: accessExpMs }, SIGNING_SECRET);
    const [accessHash, refreshHash, bindingHash] = await Promise.all([
      sha256Hex(accessToken),
      sha256Hex(refreshToken),
      computeBindingHash(req),
    ]);
    const { data: row, error } = await supabase.from("app_sessions").insert({
      user_id: userId,
      role,
      token_hash: accessHash,
      expires_at: new Date(accessExpMs).toISOString(),
      refresh_token_hash: refreshHash,
      refresh_expires_at: new Date(refreshExpMs).toISOString(),
      family_id: familyId,
      parent_session_id: opts?.parentSessionId ?? null,
      ip,
      user_agent: req.headers.get("user-agent") || null,
      binding_hash: bindingHash,
    }).select("id").single();
    if (error || !row) throw new Error(`Failed to persist session: ${error?.message || "insert failed"}`);
    // Best-effort cleanup of expired rows for this user
    supabase.from("app_sessions").delete().lt("expires_at", new Date().toISOString()).eq("user_id", userId).then(() => {});
    return { accessToken, accessExpMs, refreshToken, refreshExpMs, familyId, sessionRowId: row.id };
  }

  // Helper to verify session from header AND ensure a live DB row exists
  async function requireSession(req: Request): Promise<Record<string, any>> {
    const token = req.headers.get("x-session-token");
    if (!token) throw new Error("Authentication required");
    const session = await verifySessionTokenDual(token, SIGNING_SECRET, LEGACY_SIGNING);
    if (!session) throw new Error("Session expired or invalid");
    const tokenHash = await sha256Hex(token);
    const { data: row } = await supabase
      .from("app_sessions")
      .select("id, expires_at, binding_hash, user_id, revoked_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (!row) throw new Error("Session revoked. Please sign in again.");
    if (row.revoked_at) throw new Error("Session revoked. Please sign in again.");
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await supabase.from("app_sessions").delete().eq("id", row.id);
      throw new Error("Session expired. Please sign in again.");
    }
    // C.3 device-binding check. Only enforce when a binding is stored (soft
    // rollout: legacy sessions with null binding_hash pass through).
    if (row.binding_hash) {
      const current = await computeBindingHash(req);
      if (current !== row.binding_hash) {
        await supabase.from("app_sessions").delete().eq("id", row.id);
        supabase.from("security_events").insert({
          type: "session_binding_mismatch",
          severity: "high",
          uid: row.user_id,
          ip,
          ua: req.headers.get("user-agent") || null,
          meta: { session_id: row.id },
        }).then(() => {});
        throw new Error("Session bound to another device. Please sign in again.");
      }
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
    const pending = await verifySessionTokenDual(token, SIGNING_SECRET, LEGACY_SIGNING);
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

  const __run = async (): Promise<Response> => {
  try {
    const { action, ...params } = await req.json();

    // --- Public actions (no session needed) ---

    // Bootstrap: returns profiles, recaptcha config, and worker URLs for fresh browsers
    if (action === "bootstrap_public") {
      // Warm-instance cache: 5000 concurrent users all hitting this on load
      // otherwise re-runs the SELECTs and repays the egress. 10s TTL keeps
      // profile picker feeling live while removing 99% of DB reads.
      const now = Date.now();
      if (__bootstrapCache && (now - __bootstrapCache.at) < BOOTSTRAP_TTL_MS) {
        return new Response(JSON.stringify(__bootstrapCache.payload), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Public profile picker — only non-admin users, minimal fields.
      // Order: pinned first, then admin-defined sort_order, then creation time.
      const usersP = supabase
        .from("app_users")
        .select("id, username, name, role, profile_prefs, is_free, pinned, sort_order")
        .neq("role", "admin")
        .order("pinned", { ascending: false })
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true });

      const settingsP = supabase
        .from("app_settings")
        .select("key,value")
        .in("key", ["recaptcha", "primary_cloudflare_urls", "email_filters", "maintenance", "r2_storage"]);

      const [{ data: users, error: usersErr }, { data: settingRows }] = await Promise.all([usersP, settingsP]);
      if (usersErr) throw usersErr;

      const settings = new Map((settingRows || []).map((row: any) => [row.key, row.value]));

      let recaptcha = null;
      const rcData: any = settings.get("recaptcha");
      if (rcData?.enabled === true && rcData?.siteKey) {
        recaptcha = { enabled: true, siteKey: rcData.siteKey };
      }

      const pcf: any = settings.get("primary_cloudflare_urls");
      const workerUrls: string[] = Array.isArray(pcf)
        ? pcf.filter((u: any) => typeof u === "string" && u.length > 0)
        : [];

      const efData: any = settings.get("email_filters");
      const emailFilters: any = efData && typeof efData === "object" ? efData : {};

      let maintenance: any = { enabled: false };
      try {
        const mData: any = settings.get("maintenance");
        if (mData && typeof mData === "object") {
          const v: any = mData;
          const startsAt = typeof v.startsAt === "string" ? v.startsAt : null;
          const endsAt = typeof v.endsAt === "string" ? v.endsAt : null;
          // Auto-expire: if endsAt is in the past, treat as disabled.
          const expired = !!(endsAt && Date.parse(endsAt) > 0 && Date.parse(endsAt) <= Date.now());
          // Not-yet-started: if startsAt is in the future, suppress activation.
          const notYet = !!(startsAt && Date.parse(startsAt) > Date.now());
          // Auto-activate: if both startsAt and endsAt are set and NOW is inside that window,
          // treat the site as in maintenance even if the admin never toggled the switch.
          const withinWindow = !!(
            startsAt && endsAt &&
            Date.parse(startsAt) <= Date.now() &&
            Date.parse(endsAt) > Date.now()
          );
          maintenance = {
            enabled: (!!v.enabled || withinWindow) && !expired && !notYet,
            title: typeof v.title === "string" ? v.title : "",
            message: typeof v.message === "string" ? v.message : "",
            eta: typeof v.eta === "string" ? v.eta : "",
            startsAt,
            endsAt,
            versionFrom: typeof v.versionFrom === "string" ? v.versionFrom : "",
            versionTo: typeof v.versionTo === "string" ? v.versionTo : "",
            updated_at: v.updated_at || null,
          };
          // If we auto-expired, persist the disable so admins see it too.
          if (expired && v.enabled) {
            try {
              await supabase.from("app_settings").upsert(
                { key: "maintenance", value: { ...v, enabled: false, updated_at: new Date().toISOString() } },
                { onConflict: "key" }
              );
            } catch {}
          }
        }
      } catch {}

      let avatarBaseUrl = "";
      try {
        const r2 = normalizeR2Config(settings.get("r2_storage") || {}).config;
        avatarBaseUrl = r2.publicBaseUrl || "";
      } catch {}

      const mappedUsers = (users || []).map((u: any) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        role: u.role,
        profileAvatar: u.profile_prefs?.avatarId || null,
      }));
      const payload = { success: true, users: mappedUsers, recaptcha, workerUrls, emailFilters, maintenance, avatarBaseUrl };
      __bootstrapCache = { at: now, payload };
      return new Response(JSON.stringify(payload), {
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
      const { username, password, clientGeo, captchaToken } = params;
      if (!username || !password) throw new Error("Username and password required");

      const { data: recaptchaSetting } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "recaptcha")
        .maybeSingle();
      const recaptchaCfg: any = recaptchaSetting?.value || null;
      if (recaptchaCfg?.enabled === true) {
        if (!recaptchaCfg?.secretKey) throw new Error("CAPTCHA is misconfigured. Contact admin.");
        if (!captchaToken || typeof captchaToken !== "string") throw new Error("CAPTCHA required. Refresh and try again.");
        const captchaOk = await verifyRecaptchaToken(recaptchaCfg.secretKey, captchaToken, ip);
        if (!captchaOk) throw new Error("CAPTCHA verification failed. Refresh and try again.");
      }

      const verifiedClientGeo = sanitizeClientGeo(clientGeo);
      console.log("[login] incoming clientGeo:", JSON.stringify(clientGeo));
      console.log("[login] verified clientGeo:", JSON.stringify(verifiedClientGeo));
      if (verifiedClientGeo?.status !== "granted" || typeof verifiedClientGeo.latitude !== "number" || typeof verifiedClientGeo.longitude !== "number") {
        const status = verifiedClientGeo?.status || "missing";
        const errDetail = verifiedClientGeo?.error ? ` (${verifiedClientGeo.error})` : "";
        if (status === "denied") throw new Error("GPS permission denied. Allow location for this site, then try again.");
        if (status === "timeout") throw new Error("GPS timed out on device. Enable Precise Location and try again." + errDetail);
        if (status === "unsupported") throw new Error("This browser/device does not support GPS location.");
        if (status === "unavailable") throw new Error("Device GPS unavailable." + errDetail);
        throw new Error(`[server] GPS coordinates missing from login request (status=${status})${errDetail}. Please retry.`);
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
        const pendingPayload = { userId: user.id, username: user.username, role: "admin", pending: true, exp: Date.now() + 15 * 60 * 1000 };
        const pendingToken = await createSessionToken(pendingPayload, SIGNING_SECRET);
        const tokenHash = await sha256Hex(pendingToken);
        await supabase.from("app_admin_2fa_state").delete().eq("user_id", user.id);
        const { error: stateErr } = await supabase.from("app_admin_2fa_state").insert({
          token_hash: tokenHash,
          user_id: user.id,
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
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

      // Enforce admin-configured concurrent session cap per user.
      // Default: unlimited (0). When set, revoke oldest families so only
      // (maxPerUser - 1) remain active — the new login becomes the Nth session.
      try {
        const { data: limitRow } = await supabase.from("app_settings").select("value").eq("key", "session_limits").maybeSingle();
        const globalLimit = Math.max(0, Math.floor(Number((limitRow?.value as any)?.maxPerUser) || 0));
        // Per-user override wins when set (non-null). 0 = unlimited for this user even if a global cap exists.
        const perUser = (user as any).session_limit;
        const maxPerUser = (perUser === null || perUser === undefined) ? globalLimit : Math.max(0, Math.floor(Number(perUser) || 0));
        if (maxPerUser > 0) {
          const nowIso = new Date().toISOString();
          const { data: activeRows } = await supabase
            .from("app_sessions")
            .select("id, family_id, created_at")
            .eq("user_id", user.id)
            .is("revoked_at", null)
            .or(`refresh_expires_at.gt.${nowIso},expires_at.gt.${nowIso}`)
            .order("created_at", { ascending: false });
          const seenFamily = new Set<string>();
          const families: { family_id: string; created_at: string }[] = [];
          for (const r of activeRows || []) {
            const fid = r.family_id || r.id;
            if (seenFamily.has(fid)) continue;
            seenFamily.add(fid);
            families.push({ family_id: fid, created_at: r.created_at });
          }
          // Keep newest (maxPerUser - 1) families; revoke the rest so the
          // brand-new session slots in as the Nth.
          const keep = Math.max(0, maxPerUser - 1);
          const toRevoke = families.slice(keep).map((f) => f.family_id);
          if (toRevoke.length) {
            await supabase.from("app_sessions")
              .update({ revoked_at: nowIso })
              .in("family_id", toRevoke)
              .is("revoked_at", null);
            await auditLog(supabase, "session_limit_enforced", user.id, null, { revokedFamilies: toRevoke.length, maxPerUser }, ip);
            // Instant kick — push a Realtime Broadcast to each revoked family so
            // the old device logs out within ~1s over its persistent WebSocket
            // (no polling, ~50 bytes egress per revoke).
            const runBroadcast = broadcastSessionRevoked(toRevoke, "new_login");
            (globalThis as any).EdgeRuntime?.waitUntil?.(runBroadcast) ?? runBroadcast.catch(() => {});
          }

        }
      } catch (e) {
        console.warn("[login] session-limit enforcement skipped:", (e as any)?.message || e);
      }

      // C.2: mint access (15 min) + refresh (12 h) rotating pair
      const pair = await mintSessionPair(user.id, user.role, {
        userId: user.id,
        username: user.username,
        role: user.role,
        assignedAccounts: user.assigned_accounts || null,
      });

      const workerUrls = await loadWorkerUrls(supabase);

      return new Response(JSON.stringify({
        success: true,
        sessionToken: pair.accessToken,
        expiresAt: pair.accessExpMs,
        refreshToken: pair.refreshToken,
        refreshExpiresAt: pair.refreshExpMs,
        sessionFamilyId: pair.familyId,
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
      invalidateBootstrapCache();

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
      invalidateBootstrapCache();
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

      let isAdminReset = false;
      if (current_password) {
        // Normal self-change: verify current password
        const match = await verifyPassword(current_password, user.password);
        if (!match) throw new Error("Current password is incorrect");
      } else {
        // Either admin reset OR forced first-time password set
        const token = req.headers.get("x-session-token");
        if (!token) throw new Error("Authentication required to change password");
        const session = await verifySessionTokenDual(token, SIGNING_SECRET, LEGACY_SIGNING);
        if (!session) throw new Error("Session expired or invalid");

        if (session.role === "admin" && session.userId !== id) {
          // Admin resetting another user's password — force them to change on next login
          isAdminReset = true;
        } else if (session.role === "admin") {
          // Admin changing own password — allowed
        } else if (session.userId === id && user.must_change_password) {
          // First-time forced password set — allowed
        } else {
          throw new Error("Provide your current password or contact an admin");
        }
      }

      const hashed = await hashPassword(new_password);
      const { error } = await supabase.from("app_users").update({ password: hashed, must_change_password: isAdminReset }).eq("id", id);
      if (error) throw error;
      await auditLog(supabase, "password_changed", id, id, {}, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_profile_prefs") {
      const session = await requireSession(req);
      const { profile_prefs } = params;
      invalidateBootstrapCache();
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

      // Kick off DB write (delete+insert) and Telegram-config lookup in parallel
      // so we spend one round-trip on both, not two sequentially.
      const dbWrite = (async () => {
        await supabase.from("app_otps").delete().eq("user_id", user_id);
        const { error } = await supabase.from("app_otps").insert({ user_id, otp: otpCode });
        if (error) throw error;
      })();
      const cfgLookup = getTelegramConfig(supabase);

      const [tgConfig] = await Promise.all([cfgLookup, dbWrite]);
      if (!tgConfig) {
        throw new Error("Telegram not configured. Set bot token and chat ID in admin settings.");
      }

      // Send OTP via Telegram with a hard 6s timeout so a slow Telegram edge
      // can't stall the whole response for 20-30s.
      let telegramRes: Response;
      try {
        telegramRes = await postTelegram(tgConfig, {
          text: `🛡 Admin 3FA OTP: <code>${otpCode}</code>\nValid for 5 minutes.`,
        }, 6000);
      } catch (e) {
        console.error("Telegram send timeout/error:", e);
        throw new Error("Telegram is slow to respond. Try again in a moment.");
      }

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
      if (!otpAt || now - otpAt > 15 * 60_000) throw new Error("Telegram OTP proof expired");
      if (!totpAt || now - totpAt > 15 * 60_000) throw new Error("Authenticator proof expired");

      const { data: user, error } = await supabase.from("app_users").select("*").eq("id", pending.userId).single();
      if (error || !user || user.role !== "admin") throw new Error("Admin not found");
      const pair = await mintSessionPair(user.id, "admin", {
        userId: user.id,
        username: user.username,
        role: "admin",
        assignedAccounts: user.assigned_accounts || null,
      });
      const workerUrls = await loadWorkerUrls(supabase);
      await supabase.from("app_admin_2fa_state").delete().eq("token_hash", tokenHash);
      await auditLog(supabase, "admin_2fa_finalized", user.id, user.id, {}, ip);
      return new Response(JSON.stringify({
        success: true,
        sessionToken: pair.accessToken,
        expiresAt: pair.accessExpMs,
        refreshToken: pair.refreshToken,
        refreshExpiresAt: pair.refreshExpMs,
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
      const authenticatedKeys = ["primary_cloudflare_urls", "email_accounts", "recaptcha", "email_filters", "session_config", "admin_session_config", "session_limits", "ipwho_alert"];
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

      if (["primary_cloudflare_urls", "email_accounts"].includes(key)) {
        await pushInboxConfigToWorkers(supabase, SIGNING_SECRET, ENCRYPTION_SECRET).catch((e) => console.warn("[worker-config] push skipped:", e?.message || e));
      }

      return new Response(JSON.stringify({ success: true, value }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_reveal_session_signing_secret") {
      const session = await requireAdmin(req);
      const explicitValue = Deno.env.get("SESSION_SIGNING_SECRET") || "";
      const value = explicitValue || SIGNING_SECRET;
      const source = explicitValue ? "SESSION_SIGNING_SECRET" : "legacy_fallback";
      await auditLog(supabase, "session_signing_secret_inspected", session.userId, null, { length: value.length, source }, ip);
      // SECURITY: never return the raw signing key. Return metadata only.
      // A leaked signing key allows permanent session-token forgery.
      return new Response(JSON.stringify({
        success: true,
        name: "SESSION_SIGNING_SECRET",
        present: !!value,
        length: value.length,
        source,
        // Non-reversible fingerprint so admins can confirm rotation without
        // ever exposing the secret itself.
        fingerprint: value ? (await sha256Hex(value)).slice(0, 12) : "",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "set_settings") {
      const session = await requireAdmin(req);
      const { key, value } = params;
      // Any change to keys that feed bootstrap_public must drop the cache so
      // profile picker/maintenance banner update within a second, not 10s.
      invalidateBootstrapCache();

      let processedValue = value;

      if (key === "ipwho_alert") {
        processedValue = { enabled: value?.enabled === true };
      }

      // Maintenance: enforce upgrade-only version bumps + valid time window.
      if (key === "maintenance" && value && typeof value === "object") {
        const v: any = value;
        // Validate schedule window: startsAt must be strictly before endsAt.
        const sAt = typeof v.startsAt === "string" && v.startsAt ? Date.parse(v.startsAt) : NaN;
        const eAt = typeof v.endsAt === "string" && v.endsAt ? Date.parse(v.endsAt) : NaN;
        if (Number.isFinite(sAt) && Number.isFinite(eAt)) {
          if (sAt >= eAt) {
            throw new Error("Maintenance window is invalid: end time must be after start time.");
          }
          if (eAt - sAt < 60 * 1000) {
            throw new Error("Maintenance window is too short: keep at least 1 minute between start and end.");
          }
        }
        const cmpVer = (a: string, b: string): number => {
          const pa = String(a || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10));
          const pb = String(b || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10));
          const len = Math.max(pa.length, pb.length);
          for (let i = 0; i < len; i++) {
            const x = Number.isFinite(pa[i]) ? pa[i] : 0;
            const y = Number.isFinite(pb[i]) ? pb[i] : 0;
            if (x !== y) return x - y;
          }
          return 0;
        };
        try {
          const { data: prev } = await supabase.from("app_settings").select("value").eq("key", "maintenance").single();
          const prevTo = prev?.value?.versionTo || "";
          const nextTo = v.versionTo || "";
          if (prevTo && nextTo && cmpVer(nextTo, prevTo) < 0) {
            throw new Error(`Version downgrade blocked: current is ${prevTo}, cannot set to ${nextTo}.`);
          }
        } catch (e) {
          if (e instanceof Error && (e.message.startsWith("Version downgrade") || e.message.startsWith("Maintenance window"))) throw e;
        }
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
            password = await encryptValue(password, ENCRYPTION_SECRET); // Encrypt new password
          }
          return { ...acc, password };
        }));
      }

      const { error } = await supabase
        .from("app_settings")
        .upsert({ key, value: processedValue }, { onConflict: "key" });
      if (error) throw error;
      if (["config", "email_accounts", "primary_cloudflare_urls", "email_filters", "email_visibility"].includes(key)) {
        await pushInboxConfigToWorkers(supabase, SIGNING_SECRET, ENCRYPTION_SECRET).catch((e) => console.warn("[worker-config] push failed:", e?.message || e));
      }
      await auditLog(supabase, "settings_changed", session.userId, null, { key }, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_user") {
      const session = await requireAdmin(req);
      const { id, assigned_accounts, session_limit } = params;
      if (!id) throw new Error("User ID required");
      const patch: Record<string, any> = {};
      if (assigned_accounts !== undefined) patch.assigned_accounts = assigned_accounts;
      if (session_limit !== undefined) {
        // null | "" -> clear (fall back to global). Otherwise clamp to a sane non-negative int.
        if (session_limit === null || session_limit === "") {
          patch.session_limit = null;
        } else {
          const n = Math.max(0, Math.min(50, Math.floor(Number(session_limit) || 0)));
          patch.session_limit = n;
        }
      }
      if (Object.keys(patch).length === 0) throw new Error("No fields to update");
      const { error } = await supabase.from("app_users").update(patch).eq("id", id);
      if (error) throw error;
      await auditLog(supabase, "user_updated", session.userId, id, patch, ip);
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

      const pair = await mintSessionPair(targetUser.id, "user", {
        userId: targetUser.id,
        username: targetUser.username,
        role: "user",
        assignedAccounts: targetUser.assigned_accounts || null,
        impersonated: true,
        adminId: session.userId,
      });

      await auditLog(supabase, "impersonate", session.userId, targetUser.id, { targetUsername: targetUser.username }, ip);

      return new Response(JSON.stringify({
        success: true,
        sessionToken: pair.accessToken,
        expiresAt: pair.accessExpMs,
        refreshToken: pair.refreshToken,
        refreshExpiresAt: pair.refreshExpMs,
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

    // C.2: refresh access token — rotates refresh token, detects reuse.
    // Body: { refreshToken: string }
    if (action === "refresh_session") {
      const { refreshToken } = params;
      if (!refreshToken || typeof refreshToken !== "string") throw new Error("refreshToken required");
      const refreshHash = await sha256Hex(refreshToken);
      const { data: row } = await supabase
        .from("app_sessions")
        .select("id, user_id, role, family_id, refresh_expires_at, revoked_at, revoked_reason, binding_hash")
        .eq("refresh_token_hash", refreshHash)
        .maybeSingle();
      if (!row) throw new Error("Invalid refresh token");

      // REUSE DETECTION: presenting an already-rotated refresh token means
      // either the legitimate user's browser is racing (rare) or an attacker
      // stole a refresh token and is trying to use it after we rotated it.
      // Kill the entire session family and alert.
      if (row.revoked_at) {
        await supabase.from("app_sessions").update({
          revoked_at: new Date().toISOString(),
          revoked_reason: "refresh_reuse_family_kill",
        }).eq("family_id", row.family_id).is("revoked_at", null);
        await supabase.from("app_sessions").delete().eq("family_id", row.family_id);

        supabase.from("security_events").insert({
          type: "refresh_token_reuse",
          severity: "critical",
          uid: row.user_id,
          ip,
          ua: req.headers.get("user-agent") || null,
          meta: { family_id: row.family_id, original_reason: row.revoked_reason },
        }).then(() => {});

        // Telegram alert — fire-and-forget so we don't block the response
        // that's about to throw "Session family revoked".
        try {
          const tg = await getTelegramConfig(supabase);
          if (tg) {
            const text = [
              `🚨 <b>Refresh-token reuse detected</b>`,
              `<b>User ID:</b> <code>${row.user_id}</code>`,
              `<b>IP:</b> <code>${ip}</code>`,
              `<b>Family:</b> <code>${row.family_id}</code>`,
              `<i>All sessions in this family have been revoked.</i>`,
            ].join("\n");
            postTelegramBg(tg, { text });
          }
        } catch {}

        throw new Error("Session family revoked. Please sign in again.");
      }

      if (!row.refresh_expires_at || new Date(row.refresh_expires_at).getTime() < Date.now()) {
        await supabase.from("app_sessions").delete().eq("id", row.id);
        throw new Error("Refresh token expired. Please sign in again.");
      }

      // Device binding still enforced on refresh
      if (row.binding_hash) {
        const current = await computeBindingHash(req);
        if (current !== row.binding_hash) {
          await supabase.from("app_sessions").update({
            revoked_at: new Date().toISOString(),
            revoked_reason: "binding_mismatch_on_refresh",
          }).eq("family_id", row.family_id).is("revoked_at", null);
          supabase.from("security_events").insert({
            type: "refresh_binding_mismatch",
            severity: "high",
            uid: row.user_id,
            ip,
            ua: req.headers.get("user-agent") || null,
            meta: { family_id: row.family_id },
          }).then(() => {});
          throw new Error("Session bound to another device. Please sign in again.");
        }
      }

      // Load current user data so JWT stays fresh (role changes propagate on refresh)
      const { data: user, error: uerr } = await supabase.from("app_users").select("*").eq("id", row.user_id).single();
      if (uerr || !user) throw new Error("User not found");

      // Mint new pair inside the same family, linked to parent row
      const pair = await mintSessionPair(user.id, row.role, {
        userId: user.id,
        username: user.username,
        role: row.role,
        assignedAccounts: user.assigned_accounts || null,
      }, { familyId: row.family_id, parentSessionId: row.id });

      // Mark old row revoked (kept in DB briefly for reuse detection; expires_at cleanup will remove it)
      await supabase.from("app_sessions").update({
        revoked_at: new Date().toISOString(),
        revoked_reason: "rotated",
      }).eq("id", row.id);

      return new Response(JSON.stringify({
        success: true,
        sessionToken: pair.accessToken,
        expiresAt: pair.accessExpMs,
        refreshToken: pair.refreshToken,
        refreshExpiresAt: pair.refreshExpMs,
        sessionFamilyId: pair.familyId,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

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
        password: acc.password ? await decryptValue(acc.password, ENCRYPTION_SECRET) : "",
      })));

      return new Response(JSON.stringify({ success: true, accounts: decrypted }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify_session") {
      const token = params.token || req.headers.get("x-session-token");
      if (!token) throw new Error("No token provided");
      const session = await verifySessionTokenDual(token, SIGNING_SECRET, LEGACY_SIGNING);
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

    // ---------- Instant Inbox: delta sync (list-only, no HTML) ----------
    if (action === "list_delta") {
      const session = await requireSession(req);
      const { since, limit } = (params || {}) as { since?: number; limit?: number };
      const cursor = Math.max(0, Number(since) || 0);
      const cap = Math.min(Math.max(Number(limit) || 500, 1), 1000);

      const { data: u, error: uErr } = await supabase
        .from("app_users")
        .select("assigned_accounts, role")
        .eq("id", session.userId)
        .single();
      if (uErr || !u) throw new Error("User not found");

      const isAdmin = u.role === "admin";
      const labels: string[] | null = Array.isArray(u.assigned_accounts) && u.assigned_accounts.length > 0
        ? Array.from(new Set(u.assigned_accounts.map((s: any) => String(s).trim()).filter(Boolean)))
        : (isAdmin ? null : []);

      if (labels && labels.length === 0) {
        return new Response(JSON.stringify({ success: true, rows: [], removedIds: [], newCursor: cursor, hasMore: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let dateCutoff: string | null = null;
      if (!isAdmin) {
        const { data: visRow } = await supabase.from("app_settings").select("value").eq("key", "email_visibility").maybeSingle();
        const vis = (visRow?.value || {}) as { enabled?: boolean; days?: number };
        if (vis?.enabled && Number(vis.days) > 0) {
          const cut = new Date();
          cut.setDate(cut.getDate() - Number(vis.days));
          dateCutoff = cut.toISOString();
        }
      }

      let q = supabase
        .from("cached_emails")
        .select("id, subject, from_address, to_address, date, otp, preview, account_label, modseq, destroyed")
        .gt("modseq", cursor)
        .order("modseq", { ascending: true })
        .limit(cap);
      if (labels && labels.length > 0) q = q.in("account_label", labels);
      if (dateCutoff) q = q.gte("date", dateCutoff);

      const { data, error } = await q;
      if (error) throw error;

      const rows: any[] = [];
      const removedIds: string[] = [];
      let maxModseq = cursor;
      for (const r of (data || [])) {
        if (Number(r.modseq) > maxModseq) maxModseq = Number(r.modseq);
        if (r.destroyed) {
          removedIds.push(r.id);
        } else {
          rows.push({
            id: r.id,
            subject: r.subject,
            from: r.from_address,
            to: r.to_address,
            date: r.date,
            otp: r.otp,
            preview: r.preview,
            account_label: r.account_label,
            modseq: Number(r.modseq),
          });
        }
      }

      return new Response(JSON.stringify({
        success: true,
        rows,
        removedIds,
        newCursor: maxModseq,
        hasMore: (data?.length || 0) >= cap,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ---------- Instant Inbox: lazy full-HTML fetch ----------
    if (action === "get_email_html") {
      const session = await requireSession(req);
      const { id } = (params || {}) as { id?: string };
      if (!id || typeof id !== "string") throw new Error("id required");

      const { data: u } = await supabase
        .from("app_users").select("assigned_accounts, role").eq("id", session.userId).single();
      const isAdmin = u?.role === "admin";
      const labels: string[] | null = Array.isArray(u?.assigned_accounts) && u.assigned_accounts.length > 0
        ? u.assigned_accounts.map((s: any) => String(s).trim()).filter(Boolean)
        : (isAdmin ? null : []);

      const { data: row, error } = await supabase
        .from("cached_emails")
        .select("id, html, account_label, destroyed")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!row || row.destroyed) throw new Error("Email not found");
      if (labels && labels.length > 0 && !labels.includes(row.account_label || "")) {
        throw new Error("Not authorized");
      }
      if (labels && labels.length === 0 && !isAdmin) throw new Error("Not authorized");

      // Include account_label so the Cloudflare worker cache can enforce
      // per-user authz on cache hits without a round-trip.
      return new Response(JSON.stringify({ success: true, id: row.id, html: row.html || "", account_label: row.account_label || "" }), {
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
      const clientEtag = typeof (params as any)?.if_etag === "string" ? (params as any).if_etag : null;

      // ---- Etag pre-check (~2 tiny aggregate queries, no row payload) ----
      // If the aggregate signature matches the client-sent etag, we return
      // `{success:true, unchanged:true, etag}` — response body ~80 bytes vs
      // ~6 KB for the full list. This is the primary egress lever.
      const [aggN, aggR] = await Promise.all([
        supabase
          .from("notifications")
          .select("id, created_at, expires_at, publish_at", { count: "exact", head: false })
          .or(`audience.eq.all,target_user_id.eq.${session.userId}`),
        supabase
          .from("notification_reads")
          .select("read_at, seen_at, deleted_at, snoozed_until, dismissed_at, archived_at")
          .eq("user_id", session.userId),
      ]);
      let etagStr: string | null = null;
      if (!aggN.error && !aggR.error) {
        let cn = 0;
        let mxN = 0;
        for (const n of aggN.data || []) {
          if (n.expires_at && n.expires_at <= nowIso) continue;
          if (n.publish_at && n.publish_at > nowIso) continue;
          cn++;
          const t = n.created_at ? new Date(n.created_at).getTime() : 0;
          if (t > mxN) mxN = t;
        }
        let mxR = 0;
        for (const r of aggR.data || []) {
          for (const k of ["read_at", "seen_at", "deleted_at", "snoozed_until", "dismissed_at", "archived_at"]) {
            const v = (r as any)[k];
            const t = v ? new Date(v).getTime() : 0;
            if (t > mxR) mxR = t;
          }
        }
        etagStr = `${cn}:${mxN}:${mxR}`;
        if (clientEtag && clientEtag === etagStr) {
          return new Response(JSON.stringify({ success: true, unchanged: true, etag: etagStr }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      const { data: notes, error: nErr } = await supabase
        .from("notifications")
        .select("id, title, body, description, body_markdown, image_url, category, priority, icon, platform_icon, kind, sub_kind, locked, show_frequency, mode, action_url, action_label, action2_url, action2_label, audience, target_user_id, created_at, expires_at, publish_at, group_key")
        .or(`audience.eq.all,target_user_id.eq.${session.userId}`)
        .order("created_at", { ascending: false })
        .limit(100);
      if (nErr) throw nErr;
      const active = (notes || []).filter((n: any) => {
        if (n.expires_at && n.expires_at <= nowIso) return false;
        if (n.publish_at && n.publish_at > nowIso) return false;
        return true;
      });
      const ids = active.map((n: any) => n.id);
      const readSet = new Set<string>();
      const seenSet = new Set<string>();
      const deletedSet = new Set<string>();
      const snoozeMap = new Map<string, string>();
      if (ids.length) {
        const { data: reads } = await supabase
          .from("notification_reads")
          .select("notification_id, read_at, seen_at, deleted_at, snoozed_until")
          .in("notification_id", ids)
          .eq("user_id", session.userId);
        for (const r of reads || []) {
          if (r.read_at) readSet.add(r.notification_id);
          if (r.seen_at) seenSet.add(r.notification_id);
          if (r.deleted_at) deletedSet.add(r.notification_id);
          if (r.snoozed_until) snoozeMap.set(r.notification_id, r.snoozed_until);
        }
      }
      const payload = active
        .filter((n: any) => !deletedSet.has(n.id))
        .map((n: any) => ({
          id: n.id, title: n.title, body: n.body,
          description: n.description, body_markdown: n.body_markdown, image_url: n.image_url,
          category: n.category, priority: n.priority, icon: n.icon,
          platform_icon: n.platform_icon, kind: n.kind, sub_kind: n.sub_kind,
          locked: !!n.locked, show_frequency: n.show_frequency, mode: n.mode,
          action_url: n.action_url, action_label: n.action_label,
          action2_url: n.action2_url, action2_label: n.action2_label,
          audience: n.audience,
          created_at: n.created_at, expires_at: n.expires_at, publish_at: n.publish_at,
          read: readSet.has(n.id),
          seen: seenSet.has(n.id),
          snoozed_until: snoozeMap.get(n.id) || null,
        }));
      return new Response(JSON.stringify({ success: true, notifications: payload, etag: etagStr }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }



    if (action === "mark_notification_read") {
      const session = await requireSession(req);
      const { notification_id } = params as { notification_id?: string };
      if (!notification_id) throw new Error("notification_id required");
      const nowIso = new Date().toISOString();
      const { error } = await supabase.from("notification_reads").upsert(
        { notification_id, user_id: session.userId, read_at: nowIso, seen_at: nowIso },
        { onConflict: "notification_id,user_id" },
      );
      if (error) throw error;
      await supabase.from("notification_events").insert({
        notification_id, user_id: session.userId, event: "read",
      });
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "mark_notifications_seen") {
      const session = await requireSession(req);
      const { ids } = params as { ids?: string[] };
      if (!Array.isArray(ids) || !ids.length) {
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const nowIso = new Date().toISOString();
      const rows = ids.slice(0, 200).map((id: string) => ({ notification_id: id, user_id: session.userId, seen_at: nowIso }));
      const { error } = await supabase.from("notification_reads").upsert(rows, { onConflict: "notification_id,user_id" });
      if (error) throw error;
      const eventRows = ids.slice(0, 200).map((id: string) => ({ notification_id: id, user_id: session.userId, event: "seen" }));
      await supabase.from("notification_events").insert(eventRows);
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
        const rows = ids.map((id: string) => ({ notification_id: id, user_id: session.userId, read_at: nowIso, seen_at: nowIso }));
        const { error } = await supabase.from("notification_reads").upsert(rows, { onConflict: "notification_id,user_id" });
        if (error) throw error;
      }
      return new Response(JSON.stringify({ success: true, count: ids.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    // snooze_notification removed — Snooze is no longer a supported user action.


    if (action === "user_delete_notification") {
      const session = await requireSession(req);
      const { notification_id } = params as { notification_id?: string };
      if (!notification_id) throw new Error("notification_id required");
      const nowIso = new Date().toISOString();
      const { error } = await supabase.from("notification_reads").upsert(
        { notification_id, user_id: session.userId, deleted_at: nowIso, seen_at: nowIso },
        { onConflict: "notification_id,user_id" },
      );
      if (error) throw error;
      await supabase.from("notification_events").insert({ notification_id, user_id: session.userId, event: "dismissed", meta: { deleted: true } });
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }


    if (action === "log_notification_event") {
      const session = await requireSession(req);
      const { notification_id, event, meta } = params as { notification_id?: string; event?: string; meta?: any };
      if (!notification_id || !event) throw new Error("notification_id and event required");
      const allowed = ["delivered", "seen", "read", "clicked", "dismissed"];
      if (!allowed.includes(event)) throw new Error("invalid event");
      await supabase.from("notification_events").insert({ notification_id, user_id: session.userId, event, meta: meta || null });
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ---------- Notifications: admin side ----------
    if (action === "admin_create_notification") {
      const session = await requireAdmin(req);
      const p = params as any;
      if (!p?.title || !p?.body) throw new Error("Title and body required");
      const audience = p.audience || "all";
      if (!["all", "user"].includes(audience)) throw new Error("Invalid audience");
      if (audience === "user" && !p.target_user_id) throw new Error("target_user_id required for user audience");
      const category = ["announcement","update","security","maintenance","promo","billing"].includes(p.category) ? p.category : "announcement";
      const priority = ["low","normal","high","critical"].includes(p.priority) ? p.priority : "normal";
      const kind = "flash";
      const mode = ["popup","silent","banner"].includes(p.mode) ? p.mode : "popup";
      const show_frequency = ["once","always","session","daily"].includes(p.show_frequency) ? p.show_frequency : "once";
      const platform_icon = p.platform_icon ? String(p.platform_icon).slice(0, 40) : null;
      const expires_at = p.expiresInDays && Number(p.expiresInDays) > 0
        ? new Date(Date.now() + Number(p.expiresInDays) * 86400_000).toISOString()
        : null;
      const publish_at = p.publish_at ? new Date(p.publish_at).toISOString() : null;
      const row: Record<string, any> = {
        title: String(p.title).slice(0, 200),
        body: String(p.body).slice(0, 4000),
        description: p.description ? String(p.description).slice(0, 8000) : null,
        body_markdown: null,
        image_url: p.image_url ? String(p.image_url).slice(0, 2048) : null,
        category, priority, kind, mode, show_frequency, platform_icon,
        sub_kind: p.sub_kind ? String(p.sub_kind).slice(0, 40) : null,
        locked: !!p.locked,
        icon: p.icon ? String(p.icon).slice(0, 64) : null,
        action_url: p.action_url ? String(p.action_url).slice(0, 2048) : null,
        action_label: p.action_label ? String(p.action_label).slice(0, 80) : null,
        action2_url: p.action2_url ? String(p.action2_url).slice(0, 2048) : null,
        action2_label: p.action2_label ? String(p.action2_label).slice(0, 80) : null,
        
        audience,
        target_user_id: audience === "user" ? p.target_user_id : null,
        created_by: session.userId,
        expires_at,
        publish_at,
        dedupe_key: p.dedupe_key ? String(p.dedupe_key).slice(0, 200) : null,
        group_key: p.group_key ? String(p.group_key).slice(0, 200) : null,
      };

      const { data, error } = await supabase.from("notifications").insert(row).select("id").single();
      if (error) throw error;
      await auditLog(supabase, "notification_created", session.userId, data?.id || null, { audience, target_user_id: p.target_user_id, category, priority }, ip);
      return new Response(JSON.stringify({ success: true, id: data?.id }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_list_notifications") {
      await requireAdmin(req);
      const { data: notes, error } = await supabase
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      const ids = (notes || []).map((n: any) => n.id);
      const readCounts = new Map<string, number>();
      const seenCounts = new Map<string, number>();
      const clickCounts = new Map<string, number>();
      const deletedCounts = new Map<string, number>();
      if (ids.length) {
        const { data: reads } = await supabase
          .from("notification_reads")
          .select("notification_id, read_at, seen_at, deleted_at")
          .in("notification_id", ids);
        for (const r of reads || []) {
          if (r.seen_at) seenCounts.set(r.notification_id, (seenCounts.get(r.notification_id) || 0) + 1);
          if (r.read_at) readCounts.set(r.notification_id, (readCounts.get(r.notification_id) || 0) + 1);
          if (r.deleted_at) deletedCounts.set(r.notification_id, (deletedCounts.get(r.notification_id) || 0) + 1);
        }
        const { data: evs } = await supabase
          .from("notification_events")
          .select("notification_id, event")
          .in("notification_id", ids)
          .eq("event", "clicked");
        for (const e of evs || []) clickCounts.set(e.notification_id, (clickCounts.get(e.notification_id) || 0) + 1);
      }
      const { count: totalUsers } = await supabase.from("app_users").select("id", { count: "exact", head: true }).neq("role", "admin");
      const payload = (notes || []).map((n: any) => ({
        ...n,
        readCount: readCounts.get(n.id) || 0,
        seenCount: seenCounts.get(n.id) || 0,
        clickCount: clickCounts.get(n.id) || 0,
        deletedCount: deletedCounts.get(n.id) || 0,
        totalRecipients: n.audience === "all" ? (totalUsers || 0) : 1,
      }));
      return new Response(JSON.stringify({ success: true, notifications: payload }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_notification_recipients") {
      await requireAdmin(req);
      const { notification_id } = params as { notification_id?: string };
      if (!notification_id) throw new Error("notification_id required");
      const { data: note, error: nErr } = await supabase
        .from("notifications")
        .select("id, audience, target_user_id")
        .eq("id", notification_id)
        .maybeSingle();
      if (nErr) throw nErr;
      if (!note) throw new Error("Notification not found");

      let usersQ = supabase.from("app_users").select("id, username, name, role, profile_prefs").neq("role", "admin");
      if (note.audience === "user" && note.target_user_id) {
        usersQ = supabase.from("app_users").select("id, username, name, role, profile_prefs").eq("id", note.target_user_id);
      }
      const { data: recipients, error: uErr } = await usersQ;
      if (uErr) throw uErr;

      const userIds = (recipients || []).map((u: any) => u.id);
      const readsMap = new Map<string, any>();
      const clickedMap = new Map<string, string>();
      if (userIds.length) {
        const { data: reads } = await supabase
          .from("notification_reads")
          .select("user_id, read_at, seen_at, deleted_at")
          .eq("notification_id", notification_id)
          .in("user_id", userIds);
        for (const r of reads || []) readsMap.set(r.user_id, r);
        const { data: evs } = await supabase
          .from("notification_events")
          .select("user_id, event, created_at")
          .eq("notification_id", notification_id)
          .eq("event", "clicked")
          .in("user_id", userIds)
          .order("created_at", { ascending: false });
        for (const e of evs || []) {
          if (!clickedMap.has(e.user_id)) clickedMap.set(e.user_id, e.created_at);
        }
      }

      const rows = (recipients || []).map((u: any) => {
        const r = readsMap.get(u.id) || {};
        const prefs = u.profile_prefs || {};
        return {
          user_id: u.id,
          username: u.username,
          name: u.name,
          profileAvatar: prefs.avatarId || null,
          seen_at: r.seen_at || null,
          read_at: r.read_at || null,
          deleted_at: r.deleted_at || null,
          clicked_at: clickedMap.get(u.id) || null,
        };
      });
      return new Response(JSON.stringify({ success: true, recipients: rows }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_delete_notification_for_user") {
      const session = await requireAdmin(req);
      const { notification_id, user_id } = params as { notification_id?: string; user_id?: string };
      if (!notification_id || !user_id) throw new Error("notification_id and user_id required");
      const nowIso = new Date().toISOString();
      const { error } = await supabase.from("notification_reads").upsert(
        { notification_id, user_id, deleted_at: nowIso, seen_at: nowIso },
        { onConflict: "notification_id,user_id" },
      );
      if (error) throw error;
      await supabase.from("notification_events").insert({
        notification_id, user_id, event: "dismissed", meta: { deleted: true, by_admin: session.userId },
      });
      await auditLog(supabase, "notification_deleted_for_user", session.userId, notification_id, { user_id }, ip);
      return new Response(JSON.stringify({ success: true }), {
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

    if (action === "admin_update_notification") {
      const session = await requireAdmin(req);
      const p = params as any;
      if (!p?.id) throw new Error("id required");
      const patch: Record<string, any> = {};
      if (typeof p.title === "string") patch.title = p.title.slice(0, 200);
      if (typeof p.body === "string") patch.body = p.body.slice(0, 4000);
      if ("description" in p) patch.description = p.description ? String(p.description).slice(0, 8000) : null;
      if ("image_url" in p) patch.image_url = p.image_url ? String(p.image_url).slice(0, 2048) : null;
      if ("action_url" in p) patch.action_url = p.action_url ? String(p.action_url).slice(0, 2048) : null;
      if ("action_label" in p) patch.action_label = p.action_label ? String(p.action_label).slice(0, 80) : null;
      if ("platform_icon" in p) patch.platform_icon = p.platform_icon ? String(p.platform_icon).slice(0, 40) : null;
      if ("locked" in p) patch.locked = !!p.locked;
      if (p.category && ["announcement","update","security","maintenance","promo","billing"].includes(p.category)) patch.category = p.category;
      if (p.priority && ["low","normal","high","critical"].includes(p.priority)) patch.priority = p.priority;
      if (p.show_frequency && ["once","always","session","daily"].includes(p.show_frequency)) patch.show_frequency = p.show_frequency;
      if (p.mode && ["popup","silent","banner"].includes(p.mode)) patch.mode = p.mode;
      if (p.audience && ["all","user"].includes(p.audience)) patch.audience = p.audience;
      if ("target_user_id" in p) patch.target_user_id = p.target_user_id || null;
      if ("expiresInDays" in p) {
        patch.expires_at = p.expiresInDays && Number(p.expiresInDays) > 0
          ? new Date(Date.now() + Number(p.expiresInDays) * 86400_000).toISOString()
          : null;
      }
      if (Object.keys(patch).length === 0) throw new Error("Nothing to update");
      const { error } = await supabase.from("notifications").update(patch).eq("id", p.id);
      if (error) throw error;
      await auditLog(supabase, "notification_updated", session.userId, p.id, { fields: Object.keys(patch) }, ip);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    if (action === "list_login_events") {
      await requireAdmin(req);
      const { limit, user_id, risk, since, search } = params || {};
      let q = supabase.from("login_events").select("*").order("created_at", { ascending: false });
      if (user_id) q = q.eq("user_id", user_id);
      if (risk) q = q.eq("risk_score", risk);
      if (since) q = q.gte("created_at", since);
      if (search && typeof search === "string" && search.trim()) {
        const s = search.trim();
        q = q.or(`username.ilike.%${s}%,ip.ilike.%${s}%,city.ilike.%${s}%,country.ilike.%${s}%,isp.ilike.%${s}%`);
      }
      q = q.limit(Math.min(Number(limit) || 200, 1000));
      const { data, error } = await q;
      if (error) throw error;
      return new Response(JSON.stringify({ success: true, events: data || [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_list_emails") {
      const session = await requireAdmin(req);
      const { limit, offset, search, accountLabel } = (params || {}) as any;
      const buildFilters = (q: any) => {
        if (accountLabel) q = q.eq("account_label", accountLabel);
        if (search && typeof search === "string" && search.trim()) {
          const s = search.trim().replace(/[%,]/g, "");
          q = q.or(`subject.ilike.%${s}%,from_address.ilike.%${s}%,to_address.ilike.%${s}%,preview.ilike.%${s}%,otp.ilike.%${s}%`);
        }
        return q;
      };
      const lim = Math.min(Number(limit) || 100, 500);
      const off = Math.max(Number(offset) || 0, 0);
      // Rows page
      let dataQ = supabase
        .from("cached_emails")
        .select("id, subject, from_address, to_address, date, otp, preview, account_label, cached_at")
        .order("date", { ascending: false });
      dataQ = buildFilters(dataQ).range(off, off + lim - 1);
      // Separate exact head count — reliable even when combined with or()/range().
      let countQ = supabase.from("cached_emails").select("id", { count: "exact", head: true });
      countQ = buildFilters(countQ);
      const [{ data, error }, { count, error: countErr }] = await Promise.all([dataQ, countQ]);
      if (error) throw error;
      if (countErr) throw countErr;
      await auditLog(supabase, "admin_list_emails", session.userId, null, { count: data?.length || 0, total: count || 0, search: search || null, accountLabel: accountLabel || null }, ip);
      return new Response(JSON.stringify({ success: true, emails: data || [], total: count || 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_get_email") {
      await requireAdmin(req);
      const { id } = (params || {}) as any;
      if (!id) throw new Error("id required");
      const { data, error } = await supabase.from("cached_emails").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return new Response(JSON.stringify({ success: true, email: data || null }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin_delete_emails") {
      const session = await requireAdmin(req);
      const { ids } = (params || {}) as any;
      if (!Array.isArray(ids) || ids.length === 0) throw new Error("ids required");
      const clean = ids.filter((x: any) => typeof x === "string").slice(0, 500);
      const { error, count } = await supabase.from("cached_emails").delete({ count: "exact" }).in("id", clean);
      if (error) throw error;
      await auditLog(supabase, "admin_delete_emails", session.userId, null, { ids: clean, deleted: count || 0 }, ip);
      return new Response(JSON.stringify({ success: true, deleted: count || 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---------- Email visibility window (users) ----------
    if (action === "email_visibility_set") {
      const session = await requireAdmin(req);
      const { enabled, days } = (params || {}) as any;
      const clean = {
        enabled: enabled === true,
        days: Math.max(1, Math.min(365, Number(days) || 30)),
      };
      const { error } = await supabase.from("app_settings").upsert({ key: "email_visibility", value: clean }, { onConflict: "key" });
      if (error) throw error;
      await auditLog(supabase, "email_visibility_set", session.userId, null, clean, ip);
      return new Response(JSON.stringify({ success: true, value: clean }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ---------- Email auto-delete cron ----------
    if (action === "email_cleanup_apply") {
      const session = await requireAdmin(req);
      const { enabled, days, hour } = (params || {}) as any;
      const clean = {
        enabled: enabled === true,
        days: Math.max(1, Math.min(365, Number(days) || 30)),
        hour: Math.max(0, Math.min(23, Number(hour) || 3)),
      };
      try {
        if (clean.enabled) {
          const { error } = await supabase.rpc("schedule_email_cleanup", { days: clean.days, hour: clean.hour });
          if (error) throw error;
        } else {
          const { error } = await supabase.rpc("unschedule_email_cleanup");
          if (error) throw error;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ success: false, error: msg }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      await supabase.from("app_settings").upsert({ key: "email_auto_delete", value: clean }, { onConflict: "key" });
      await auditLog(supabase, "email_cleanup_apply", session.userId, null, clean, ip);
      return new Response(JSON.stringify({ success: true, value: clean }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "email_cleanup_status") {
      await requireAdmin(req);
      const { data, error } = await supabase.rpc("get_email_cleanup_status");
      if (error) throw error;
      return new Response(JSON.stringify({ success: true, status: data }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ---------- D.2: signed short-lived maintenance-bypass token ----------
    // Replaces client-controlled sessionStorage flag with an HMAC-signed JWS.
    // 10 min TTL, bound to admin userId. Client cannot extend or forge it.
    if (action === "admin_issue_maint_bypass") {
      const session = await requireAdmin(req);
      const now = Date.now();
      const exp = now + 10 * 60 * 1000;
      const token = await createSessionToken(
        { kind: "maint_bypass", uid: session.userId, iat: now, exp, jti: crypto.randomUUID() },
        SIGNING_SECRET,
      );
      await auditLog(supabase, "maint_bypass_issued", session.userId, null, { exp }, ip);
      return new Response(JSON.stringify({ success: true, token, exp }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ---------- Admin dashboard: ONE composite call (replaces 12 client calls) ----------
    // Bulk: full mount payload. `refresh` variant skips rarely-changing settings.

    if (action === "admin_dashboard_bootstrap" || action === "admin_dashboard_refresh") {
      const session = await requireAdmin(req);
      const includeSettings = action === "admin_dashboard_bootstrap";

      // Kick everything off in PARALLEL server-side. Edge → Postgres latency is
      // ~1-5ms each, so 12 parallel queries return in ~50-150ms total.
      const usersP = supabase.from("app_users")
        .select("id, username, name, role, assigned_accounts, profile_prefs, session_limit")
        .order("created_at", { ascending: true });

      const emailsCountP = supabase.from("cached_emails").select("id", { count: "exact", head: true });

      const notesP = supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(200);
      const totalUsersP = supabase.from("app_users").select("id", { count: "exact", head: true }).neq("role", "admin");

      const settingsKeys = includeSettings
        ? ["recaptcha", "config", "primary_cloudflare_urls", "email_filters", "email_accounts", "session_config", "admin_session_config", "session_limits", "ipwho_alert", "maintenance", "r2_storage", "email_visibility", "email_auto_delete", "cron_config", "netflix_promo"]
        : [];

      const settingsP = settingsKeys.length
        ? supabase.from("app_settings").select("key,value").in("key", settingsKeys)
        : Promise.resolve({ data: [] as any[] });

      const [usersRes, emailsCountRes, notesRes, totalUsersRes, settingsRes] = await Promise.all([usersP, emailsCountP, notesP, totalUsersP, settingsP]);

      // Users mapping
      const users = (usersRes.data || []).map((u: any) => ({
        ...u,
        assignedAccounts: u.assigned_accounts || null,
        profileAvatar: u.profile_prefs?.avatarId || null,
      }));

      // Notification stats — 2 more queries but only if there are notes
      const noteIds = (notesRes.data || []).map((n: any) => n.id);
      const readCounts = new Map<string, number>();
      const seenCounts = new Map<string, number>();
      const clickCounts = new Map<string, number>();
      const deletedCounts = new Map<string, number>();
      if (noteIds.length) {
        const [readsRes, evsRes] = await Promise.all([
          supabase.from("notification_reads").select("notification_id, read_at, seen_at, deleted_at").in("notification_id", noteIds),
          supabase.from("notification_events").select("notification_id, event").in("notification_id", noteIds).eq("event", "clicked"),
        ]);
        for (const r of readsRes.data || []) {
          if (r.seen_at) seenCounts.set(r.notification_id, (seenCounts.get(r.notification_id) || 0) + 1);
          if (r.read_at) readCounts.set(r.notification_id, (readCounts.get(r.notification_id) || 0) + 1);
          if (r.deleted_at) deletedCounts.set(r.notification_id, (deletedCounts.get(r.notification_id) || 0) + 1);
        }
        for (const e of evsRes.data || []) clickCounts.set(e.notification_id, (clickCounts.get(e.notification_id) || 0) + 1);
      }
      const totalUsers = totalUsersRes.count || 0;
      const notifications = (notesRes.data || []).map((n: any) => ({
        ...n,
        readCount: readCounts.get(n.id) || 0,
        seenCount: seenCounts.get(n.id) || 0,
        clickCount: clickCounts.get(n.id) || 0,
        deletedCount: deletedCounts.get(n.id) || 0,
        totalRecipients: n.audience === "all" ? totalUsers : 1,
      }));

      // Settings map + R2 normalization
      const settings: Record<string, any> = {};
      let r2: any = null;
      for (const row of (settingsRes as any).data || []) {
        if (row.key === "r2_storage") {
          const normalized = normalizeR2Config(row.value || {});
          const hasSecret = typeof normalized.config.secretAccessKey === "string" && normalized.config.secretAccessKey.length > 0;
          r2 = {
            accountId: normalized.config.accountId,
            accessKeyId: normalized.config.accessKeyId,
            secretAccessKey: normalized.config.secretAccessKey,
            bucket: normalized.config.bucket,
            publicBaseUrl: normalized.config.publicBaseUrl,
            pathPrefix: normalized.config.pathPrefix,
            enabled: normalized.config.enabled,
            secretAccessKeySet: hasSecret,
          };
        } else {
          settings[row.key] = row.value;
        }
      }

      return new Response(JSON.stringify({
        success: true,
        users,
        emailsTotal: emailsCountRes.count || 0,
        notifications,
        settings: includeSettings ? settings : undefined,
        r2: includeSettings ? r2 : undefined,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ---------- R2 storage: admin-only ----------

    if (action === "admin_get_r2_config") {
      await requireAdmin(req);
      const { data } = await supabase.from("app_settings").select("value").eq("key", "r2_storage").maybeSingle();
      const v: any = data?.value || {};
      const normalized = normalizeR2Config(v);
      const hasSecret = typeof normalized.config.secretAccessKey === "string" && normalized.config.secretAccessKey.length > 0;
      return new Response(JSON.stringify({
        success: true,
        config: {
          accountId: normalized.config.accountId,
          accessKeyId: normalized.config.accessKeyId,
          secretAccessKey: normalized.config.secretAccessKey,
          bucket: normalized.config.bucket,
          publicBaseUrl: normalized.config.publicBaseUrl,
          pathPrefix: normalized.config.pathPrefix,
          enabled: normalized.config.enabled,
          secretAccessKeySet: hasSecret,
        },
        warnings: normalized.warnings,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_save_r2_config") {
      const session = await requireAdmin(req);
      const p = (params || {}) as any;
      const { data: existing } = await supabase.from("app_settings").select("value").eq("key", "r2_storage").maybeSingle();
      const prev: any = existing?.value || {};
      const normalized = normalizeR2Config(p, prev.secretAccessKey || "");
      if (normalized.errors.length) throw new Error(normalized.errors.join(" "));
      const value = normalized.config;
      const { error } = await supabase.from("app_settings").upsert({ key: "r2_storage", value }, { onConflict: "key" });
      if (error) throw error;
      await auditLog(supabase, "r2_config_updated", session.userId, null, { bucket: value.bucket, enabled: value.enabled }, ip);
      return new Response(JSON.stringify({ success: true, warnings: normalized.warnings, config: value }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_r2_test") {
      await requireAdmin(req);
      const { data } = await supabase.from("app_settings").select("value").eq("key", "r2_storage").maybeSingle();
      const saved: any = data?.value || {};
      const draft: any = params || {};
      const hasDraftConfig = draft.useSaved !== true && ["accountId", "accessKeyId", "secretAccessKey", "bucket", "publicBaseUrl", "pathPrefix", "enabled"].some((k) => k in draft);
      const source = hasDraftConfig ? { ...saved, ...draft } : saved;
      const normalized = normalizeR2Config(source, saved.secretAccessKey || "");
      const v = normalized.config;
      const missing: string[] = [];
      if (!v.accountId) missing.push("Account ID");
      if (!v.accessKeyId) missing.push("Access Key ID");
      if (!v.secretAccessKey) missing.push("Secret Access Key");
      if (!v.bucket) missing.push("Bucket");
      if (normalized.errors.length) missing.push(...normalized.errors);
      if (missing.length) {
        return new Response(JSON.stringify({ success: false, message: `Enter R2 config first — missing: ${missing.join(", ")}` }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const { r2Put, r2Delete } = await import("../_shared/r2Sign.ts");
      const creds = { accountId: v.accountId, accessKeyId: v.accessKeyId, secretAccessKey: v.secretAccessKey, bucket: v.bucket };
      const key = `${v.pathPrefix || "notifications/"}_healthcheck-${Date.now()}.txt`;
      const t0 = Date.now();
      let putOk = false, putErr = "", publicUrlWorks = false, publicUrl = "";
      try {
        const res = await r2Put(creds, key, new TextEncoder().encode("ok"), "text/plain");
        putOk = res.ok;
        if (!res.ok) putErr = r2FailureMessage(res.status, await res.text(), normalized.warnings);
      } catch (e) {
        putErr = e instanceof Error ? e.message : String(e);
      }
      if (putOk && v.publicBaseUrl) {
        publicUrl = `${v.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
        try {
          const h = await fetch(publicUrl, { method: "GET" });
          publicUrlWorks = h.ok;
        } catch {}
      }
      // Clean up the test object.
      try { await r2Delete(creds, key); } catch {}
      return new Response(JSON.stringify({
        success: putOk,
        latencyMs: Date.now() - t0,
        publicUrlWorks,
        publicUrl,
        warnings: normalized.warnings,
        message: putOk ? "R2 upload OK" : putErr || "R2 test failed",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "admin_upload_notification_image") {
      await requireAdmin(req);
      const p = (params || {}) as any;
      if (!p?.dataBase64 || !p?.filename) throw new Error("dataBase64 and filename required");
      const { data } = await supabase.from("app_settings").select("value").eq("key", "r2_storage").maybeSingle();
      const v: any = data?.value || {};
      if (!v.enabled) throw new Error("R2 is not enabled — configure it in Settings → Storage");
      const normalized = normalizeR2Config(v);
      if (normalized.errors.length) throw new Error(normalized.errors.join(" "));
      const cfg = normalized.config;
      if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket || !cfg.publicBaseUrl) {
        throw new Error("R2 credentials incomplete");
      }
      const contentType = String(p.contentType || "").slice(0, 100) || "application/octet-stream";
      if (!/^image\//.test(contentType)) throw new Error("Only image uploads are allowed");
      // Decode base64
      const b64 = String(p.dataBase64).replace(/^data:[^;]+;base64,/, "");
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (bytes.length > 8 * 1024 * 1024) throw new Error("Image too large (max 8 MB)");
      const { r2Put, slugifyFilename } = await import("../_shared/r2Sign.ts");
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
      const rand = crypto.randomUUID().slice(0, 8);
      const key = `${cfg.pathPrefix || "notifications/"}${yyyy}/${mm}/${rand}-${slugifyFilename(p.filename)}`;
      const creds = { accountId: cfg.accountId, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, bucket: cfg.bucket };
      const res = await r2Put(creds, key, bytes, contentType);
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`R2 upload failed: ${r2FailureMessage(res.status, t, normalized.warnings)}`);
      }
      const url = `${cfg.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
      return new Response(JSON.stringify({ success: true, url, key }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    throw new Error("Unknown action: " + action);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  };
  const __res = await __run();
  return await maybeEncryptResponse(__res, __ctx);
});
