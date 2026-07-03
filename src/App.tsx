import React, { useState, useEffect, createContext, useContext, useCallback, useRef, useMemo, Suspense, lazy } from "react";
import { createPortal } from "react-dom";
import { Mail, RefreshCw, ShieldCheck, Shield, Clock, AlertCircle, Copy, Check, ArrowLeft, Lock, Key, LogOut, Settings, Plus, Users, Trash2, CheckCircle2, X, Eye, EyeOff, KeyRound, Filter, Server, BarChart3, Globe, Edit, Database, Wifi, Info, UserCircle, Search, ChevronLeft, ChevronRight, Bell, Send, MessageSquare, Image as ImageIcon, ExternalLink, AlertTriangle, Sparkles, Megaphone, Wrench, CreditCard, Tag, ChevronDown, HardDrive, Upload, Zap, BookOpen, GraduationCap, Film, PlayCircle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import NetflixHouseholdVerificationGuide from "./pages/NetflixHouseholdVerificationGuide";
import { Toaster, toast } from "sonner";
import { premiumToast } from "./components/premium-toast";
import { supabase } from "./integrations/supabase/client";
import { AVATAR_CATEGORIES, resolveAvatar, buildAvatarId, prettyName, getAvatarCategoryUrls } from "./lib/avatars";
import { bootstrapFromSupabase, clearSessionData, markSessionStart, readBootstrapCache, refreshBootstrap, patchBootstrapCacheUser, getEmailFilters, setEmailFilters as setEmailFiltersCache, listNotifications, markNotificationRead, markAllNotificationsRead, markNotificationSeen, deleteNotificationForMe, logNotificationEvent, getPoppedIds, markPopped, adminListRecipients, adminDeleteNotificationForUser, type EmailFilters, type AppNotification, type MaintenanceInfo, type NotificationRecipient } from "./lib/bootstrap";
import MaintenanceScreen from "./components/MaintenanceScreen";
import DateTimePicker from "./components/DateTimePicker";
import { sessionGet, sessionSet, sessionRemove, sessionClearAll } from "./lib/session";


// Lazy-loaded heavy auth-only libs — kept out of the public first-load chunk.
const ReCAPTCHA = lazy(() => import("react-google-recaptcha"));
const QRCodeSVG = lazy(() => import("qrcode.react").then((m) => ({ default: m.QRCodeSVG })));

// Preload Google reCAPTCHA API script as soon as siteKey is known so the
// widget mounts instantly when the modal opens (avoids 5–10s cold load).
let __recaptchaPreloaded = false;
function preloadRecaptchaScript() {
  if (__recaptchaPreloaded || typeof document === "undefined") return;
  __recaptchaPreloaded = true;
  try {
    // Warm up react-google-recaptcha JS chunk (no-op if already bundled).
    import("react-google-recaptcha").catch(() => {});
    if (document.querySelector('script[data-recaptcha-preload]')) return;
    const s = document.createElement("script");
    s.src = "https://www.google.com/recaptcha/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.setAttribute("data-recaptcha-preload", "1");
    document.head.appendChild(s);
  } catch {}
}

// --- Admin composer: platform logo options ---
type PlatformOption = { id: string; label: string; logoFile: string; aliases?: string[] };
const PLATFORM_LOGO_BASE = "/platform-logos/";
const DEFAULT_PLATFORM_LOGO = `${PLATFORM_LOGO_BASE}default-logo.svg`;

const normalizePlatformKey = (value: string | null | undefined) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const PLATFORM_OPTIONS: PlatformOption[] = [
  { id: "telegram",      label: "Telegram",         logoFile: "telegram.svg" },
  { id: "whatsapp",      label: "WhatsApp",         logoFile: "whatsapp.svg" },
  { id: "youtube",       label: "YouTube",          logoFile: "youtube.svg" },
  { id: "instagram",     label: "Instagram",        logoFile: "instagram.svg" },
  { id: "discord",       label: "Discord",          logoFile: "discord.svg" },
  { id: "twitter",       label: "Twitter / X",      logoFile: "twitter.svg", aliases: ["x", "twitterx"] },
  { id: "facebook",      label: "Facebook",         logoFile: "facebook.svg" },
  { id: "linkedin",      label: "LinkedIn",         logoFile: "linkedin.svg" },
  { id: "netflix",       label: "Netflix",          logoFile: "netflix.svg" },
  { id: "prime",         label: "Prime Video",      logoFile: "primevideo.svg", aliases: ["amazonprimevideo", "primevideo", "amazonprime"] },
  { id: "hotstar",       label: "Disney+ Hotstar",  logoFile: "disney-hotstar.svg", aliases: ["disneyhotstar", "disneyplushotstar", "hotstar"] },
  { id: "jiohotstar",    label: "JioHotstar",       logoFile: "jiohotstar.svg", aliases: ["jiohotstar", "jiohotstarapp"] },
  { id: "sonyliv",       label: "Sony LIV",         logoFile: "sonyliv.png", aliases: ["sonyliv", "sony live", "sony liv"] },
  { id: "zee5",          label: "ZEE5",             logoFile: "zee5.svg", aliases: ["zee 5", "z5"] },
  { id: "jiocinema",     label: "JioCinema",        logoFile: "jiocinema.svg", aliases: ["jio cinema", "jio-cinema", "jio.cinema"] },
  { id: "mxplayer",      label: "MX Player",        logoFile: "mxplayer.png", aliases: ["mx", "mx player"] },
  { id: "minitv",        label: "Amazon miniTV",    logoFile: "minitv.png", aliases: ["amazonminitv", "mini tv", "minitv"] },
  { id: "appletv",       label: "Apple TV+",        logoFile: "appletv.svg", aliases: ["apple tv", "apple tv plus", "appletvplus"] },
  { id: "lionsgate",     label: "Lionsgate Play",   logoFile: "lionsgateplay.png", aliases: ["lionsgate", "lionsgateplay", "lions play", "lionsplay"] },
  { id: "discoveryplus", label: "Discovery+",       logoFile: "discoveryplus.svg", aliases: ["discovery", "discoveryplus", "discovery plus"] },
  { id: "sunnxt",        label: "Sun NXT",          logoFile: "sunnxt.png", aliases: ["sun nxt", "sunnext"] },
  { id: "aha",           label: "Aha",              logoFile: "aha.png", aliases: ["aha video", "ahavideo"] },
  { id: "chaupal",       label: "Chaupal",          logoFile: "chaupal.svg" },
  { id: "hoichoi",       label: "Hoichoi",          logoFile: "hoichoi.png" },
  { id: "manoramamax",   label: "ManoramaMAX",      logoFile: "manoramamax.png", aliases: ["manorama max"] },
  { id: "erosnow",       label: "Eros Now",         logoFile: "erosnow.svg", aliases: ["eros"] },
  { id: "mubi",          label: "MUBI",             logoFile: "mubi.png" },
  { id: "shemaroome",    label: "ShemarooMe",       logoFile: "shemaroome.png", aliases: ["shemaroo", "shemaroo me"] },
  { id: "docubay",       label: "DocuBay",          logoFile: "docubay.png" },
  { id: "epicon",        label: "EPIC ON",          logoFile: "epicon.png", aliases: ["epic on", "epic"] },
  { id: "planetmarathi", label: "Planet Marathi",   logoFile: "planetmarathi.png", aliases: ["planet marathi ott", "planet marathi"] },
  { id: "stage",         label: "Stage",            logoFile: "stage.png", aliases: ["stage ott"] },
  { id: "nammaflix",     label: "NammaFlix",        logoFile: "nammaflix.png", aliases: ["namma flix"] },
  { id: "klikk",         label: "Klikk",            logoFile: "klikk.png", aliases: ["klikk ott"] },
  { id: "simplysouth",   label: "Simply South",     logoFile: "simplysouth.png", aliases: ["simply south"] },
  { id: "tentkotta",     label: "Tentkotta",        logoFile: "tentkotta.jpg", aliases: ["tent kotta"] },
  { id: "ytpremium",     label: "YouTube Premium",  logoFile: "ytpremium.svg", aliases: ["youtube premium", "yt premium"] },
  { id: "",              label: "Custom / Bell",    logoFile: "default-logo.svg", aliases: ["custom", "bell", "notification"] },
];

const PLATFORM_ALIAS_TO_ID = PLATFORM_OPTIONS.reduce<Record<string, string>>((acc, platform) => {
  [platform.id, platform.label, platform.logoFile.replace(/\.[^.]+$/, ""), ...(platform.aliases || [])].forEach((value) => {
    const key = normalizePlatformKey(value);
    if (key) acc[key] = platform.id;
  });
  return acc;
}, {});

const getPlatformLogoUrl = (platform: PlatformOption) => `${PLATFORM_LOGO_BASE}${platform.logoFile}`;

const resolvePlatformOption = (value: string | null | undefined) => {
  const raw = String(value || "");
  const exact = PLATFORM_OPTIONS.find((platform) => platform.id === raw);
  if (exact) return exact;
  const id = PLATFORM_ALIAS_TO_ID[normalizePlatformKey(raw)];
  return PLATFORM_OPTIONS.find((platform) => platform.id === id) || PLATFORM_OPTIONS.find((platform) => platform.id === "")!;
};

const platformMatchesSearch = (platform: PlatformOption, search: string) => {
  const query = normalizePlatformKey(search);
  if (!query) return true;
  return [platform.id, platform.label, platform.logoFile, ...(platform.aliases || [])]
    .some((value) => normalizePlatformKey(value).includes(query));
};

const logPlatformLogoFailure = ({ platform, url, status, reason }: { platform: string; url: string; status?: number | string; reason: string }) => {
  console.error("[platform-logo] failed", {
    platform,
    expectedUrl: url,
    httpStatus: status ?? "unknown",
    reason,
  });
};

type LogoAuditResult = { ok: boolean; status?: number | string; reason?: string; contentType?: string };

const verifyPlatformLogo = async (platform: PlatformOption): Promise<LogoAuditResult> => {
  const url = getPlatformLogoUrl(platform);
  try {
    const response = await fetch(url, { method: "GET", cache: "no-store" });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      return { ok: false, status: response.status, contentType, reason: `HTTP ${response.status}` };
    }
    if (!contentType.startsWith("image/")) {
      return { ok: false, status: response.status, contentType, reason: `Invalid MIME type: ${contentType || "missing"}` };
    }

    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Browser image decode/load failed"));
      image.src = url;
    });

    return { ok: true, status: response.status, contentType };
  } catch (error) {
    return { ok: false, status: "network/decode", reason: error instanceof Error ? error.message : String(error) };
  }
};

const usePlatformLogoAudit = (enabled = false) => {
  const [ready, setReady] = React.useState(!enabled);
  const [results, setResults] = React.useState<Record<string, LogoAuditResult>>({});

  React.useEffect(() => {
    if (!enabled) {
      setReady(true);
      return;
    }
    let alive = true;

    (async () => {
      const entries = await Promise.all(
        PLATFORM_OPTIONS.map(async (platform) => {
          const result = await verifyPlatformLogo(platform);
          if (!result.ok) {
            logPlatformLogoFailure({
              platform: platform.label,
              url: getPlatformLogoUrl(platform),
              status: result.status,
              reason: result.reason || "Image request failed",
            });
          }
          return [platform.id || "__custom", result] as const;
        }),
      );

      if (!alive) return;
      setResults(Object.fromEntries(entries));
      setReady(true);
    })();

    return () => { alive = false; };
  }, [enabled]);

  return { ready, results };
};

// --- Notification templates (guided types) ---
type TemplateOption = { id: string; label: string; color: string; hint: string };
const TEMPLATE_OPTIONS: TemplateOption[] = [
  { id: "tutorial",     label: "Tutorial",       color: "#3B82F6", hint: "Step-by-step teaching" },
  { id: "howto",        label: "How to use",     color: "#8B5CF6", hint: "Quick usage guide" },
  { id: "new_movie",    label: "New Movie",      color: "#E50914", hint: "New title on Netflix/Prime" },
  { id: "new_episode",  label: "New Episode",    color: "#EC4899", hint: "Fresh episode drop" },
  { id: "update",       label: "Update",         color: "#10B981", hint: "App/feature update" },
  { id: "announcement", label: "Announcement",   color: "#F59E0B", hint: "General announcement" },
  { id: "promo",        label: "Promo / Offer",  color: "#F97316", hint: "Discount or deal" },
  { id: "alert",        label: "Alert",          color: "#EF4444", hint: "Important warning" },
  { id: "event",        label: "Live Event",     color: "#06B6D4", hint: "Match/premiere/live" },
];

const PlatformChipVisual: React.FC<{ id?: string | null; size?: number; audit?: LogoAuditResult }> = ({ id, size = 32, audit }) => {
  const p = resolvePlatformOption(id);
  const logoUrl = getPlatformLogoUrl(p);
  const [src, setSrc] = React.useState(logoUrl);

  React.useEffect(() => {
    setSrc(logoUrl);
  }, [logoUrl]);

  const fallbackToDefaultLogo = () => {
    logPlatformLogoFailure({
      platform: p.label,
      url: logoUrl,
      status: audit?.status,
      reason: audit?.reason || "<img> onError fired while rendering logo",
    });
    if (src !== DEFAULT_PLATFORM_LOGO) setSrc(DEFAULT_PLATFORM_LOGO);
  };

  return (
    <div
      className="rounded-full flex items-center justify-center bg-white shadow-md leading-none shrink-0 overflow-hidden ring-1 ring-black/5"
      style={{ width: size, height: size }}
    >
      <img
        src={src}
        alt={`${p.label} logo`}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={fallbackToDefaultLogo}
        style={{ width: Math.round(size * 0.92), height: Math.round(size * 0.92), objectFit: "contain" }}
      />
    </div>
  );
};

// Template icon (lucide)
const TemplateIcon: React.FC<{ id: string; className?: string }> = ({ id, className = "w-4 h-4" }) => {
  switch (id) {
    case "tutorial":     return <BookOpen className={className} />;
    case "howto":        return <GraduationCap className={className} />;
    case "new_movie":    return <Film className={className} />;
    case "new_episode":  return <PlayCircle className={className} />;
    case "update":       return <Sparkles className={className} />;
    case "announcement": return <Megaphone className={className} />;
    case "promo":        return <Tag className={className} />;
    case "alert":        return <AlertTriangle className={className} />;
    case "event":        return <Zap className={className} />;
    default:             return <Bell className={className} />;
  }
};



const SESSION_CONFIG_KEY_FOR = (role: "admin" | "user") =>
  role === "admin" ? "admin_session_config" : "session_config";

// --- Worker URL Types & Helpers ---
type WorkerUrlMap = {
  primary: string[];
  byAccount: Record<string, string[]>;
};

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function getStoredWorkerUrls(): string[] {
  // Refresh/inbox routing must not depend on browser-persistent storage.
  // Worker URLs are loaded from server settings after login.
  return [];
}

function storeWorkerUrls(urls: string[]) {
  void urls;
}

function isEncryptedTransportError(value: unknown): boolean {
  const msg = value instanceof Error ? value.message : String(value || "");
  return /encrypted transport required|plaintext rejected|transport required/i.test(msg);
}

function getSessionToken(): string | null {
  try {
    return sessionGet("session_token" as any);
  } catch { return null; }
}

type DeviceFingerprint = {
  userAgent?: string;
  platform?: string;
  vendor?: string;
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
  colorScheme?: "dark" | "light" | "no-preference";
  reducedMotion?: boolean;
  hdr?: boolean;
  webglVendor?: string;
  webglRenderer?: string;
  canvasHash?: string;
  webdriver?: boolean;
  fingerprintHash?: string;
};

type LoginLocationPayload = {
  status: "granted" | "denied" | "timeout" | "unavailable" | "unsupported" | "error";
  permissionState?: PermissionState | "unknown";
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  altitude?: number | null;
  heading?: number | null;
  speed?: number | null;
  timestamp?: number;
  error?: string;
  publicIp?: string;
  publicIpSource?: "ipwho.is";
  device?: DeviceFingerprint;
};

async function sha256Hex(s: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch { return ""; }
}

function collectWebGL(): { vendor?: string; renderer?: string } {
  try {
    const canvas = document.createElement("canvas");
    const gl: any = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return {};
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  } catch { return {}; }
}

function collectCanvasHash(): string {
  try {
    const c = document.createElement("canvas");
    c.width = 200; c.height = 50;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    ctx.textBaseline = "top";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 200, 50);
    ctx.fillStyle = "#069";
    ctx.fillText("🔐 lovable-fp", 2, 15);
    return c.toDataURL().slice(-64);
  } catch { return ""; }
}

async function collectDeviceFingerprint(): Promise<DeviceFingerprint> {
  const fp: DeviceFingerprint = {};
  try {
    if (typeof navigator !== "undefined") {
      fp.userAgent = navigator.userAgent;
      fp.platform = (navigator as any).platform;
      fp.vendor = (navigator as any).vendor;
      fp.language = navigator.language;
      fp.languages = Array.isArray(navigator.languages) ? navigator.languages.slice(0, 6) : undefined;
      fp.touchPoints = (navigator as any).maxTouchPoints;
      fp.deviceMemory = (navigator as any).deviceMemory;
      fp.hardwareConcurrency = navigator.hardwareConcurrency;
      fp.cookieEnabled = navigator.cookieEnabled;
      fp.onLine = navigator.onLine;
      fp.pdfViewerEnabled = (navigator as any).pdfViewerEnabled;
      fp.webdriver = !!(navigator as any).webdriver;
    }
    if (typeof window !== "undefined" && window.screen) {
      fp.screen = {
        width: window.screen.width, height: window.screen.height, dpr: window.devicePixelRatio || 1,
        availWidth: window.screen.availWidth, availHeight: window.screen.availHeight,
        colorDepth: window.screen.colorDepth, pixelDepth: window.screen.pixelDepth,
      };
      fp.viewport = { width: window.innerWidth, height: window.innerHeight };
      try { fp.orientation = (window.screen.orientation?.type) || (window.innerHeight > window.innerWidth ? "portrait" : "landscape"); } catch {}
    }
    try {
      fp.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      fp.utcOffsetMinutes = -new Date().getTimezoneOffset();
    } catch {}
    try {
      if (window.matchMedia) {
        fp.colorScheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark"
          : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "no-preference";
        fp.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        fp.hdr = window.matchMedia("(dynamic-range: high)").matches;
      }
    } catch {}
    try {
      const conn: any = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
      if (conn) fp.network = { type: conn.type, effectiveType: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt, saveData: !!conn.saveData };
    } catch {}
    try {
      const bat: any = await (navigator as any).getBattery?.();
      if (bat) fp.battery = { level: bat.level, charging: bat.charging, chargingTime: bat.chargingTime, dischargingTime: bat.dischargingTime };
    } catch {}
    const gl = collectWebGL();
    if (gl.vendor) fp.webglVendor = gl.vendor;
    if (gl.renderer) fp.webglRenderer = gl.renderer;
    fp.canvasHash = collectCanvasHash();
    const uaData: any = (navigator as any).userAgentData;
    if (uaData) {
      fp.mobile = !!uaData.mobile;
      fp.uaPlatform = uaData.platform;
      fp.uaBrands = Array.isArray(uaData.brands) ? uaData.brands.map((b: any) => ({ brand: b.brand, version: b.version })) : undefined;
      if (typeof uaData.getHighEntropyValues === "function") {
        try {
          const hi = await uaData.getHighEntropyValues([
            "platform", "platformVersion", "model", "architecture", "bitness", "uaFullVersion",
          ]);
          fp.uaPlatform = hi.platform || fp.uaPlatform;
          fp.uaPlatformVersion = hi.platformVersion;
          fp.uaModel = hi.model;
          fp.uaArchitecture = hi.architecture;
          fp.uaBitness = hi.bitness;
          fp.uaFullVersion = hi.uaFullVersion;
        } catch (e) { console.warn("[Device] high-entropy UA-CH failed:", e); }
      }
    }
    // Stable fingerprint hash
    const parts = [
      fp.userAgent, fp.platform, fp.language, (fp.languages || []).join(","), fp.timezone,
      fp.screen ? `${fp.screen.width}x${fp.screen.height}x${fp.screen.colorDepth || ""}@${fp.screen.dpr}` : "",
      fp.hardwareConcurrency, fp.deviceMemory, fp.touchPoints,
      fp.webglVendor, fp.webglRenderer, fp.canvasHash,
      fp.uaModel, fp.uaPlatformVersion,
    ].filter(v => v !== undefined && v !== null).join("|");
    fp.fingerprintHash = await sha256Hex(parts);
  } catch (e) {
    console.warn("[Device] fingerprint failed:", e);
  }
  return fp;
}


const LOGIN_GEO_TIMEOUT_MS = 20_000;

async function fetchBrowserPublicIp(): Promise<Pick<LoginLocationPayload, "publicIp" | "publicIpSource">> {
  // Encrypted-only mode: disable third-party browser IP lookups.
  return {};
}

function buildLocationSignInMessage(location: LoginLocationPayload): string {
  if (location.status === "denied" || location.permissionState === "denied") {
    return "GPS permission denied. Allow location for this site in browser settings, then try again.";
  }
  if (location.status === "unsupported") {
    return "This browser/device does not support GPS location. Use Chrome/Firefox with location services enabled.";
  }
  if (location.status === "timeout") {
    return "GPS request timed out. Enable device Location/Precise Location and try again.";
  }
  if (location.status === "unavailable") {
    return `Device GPS is unavailable right now (${location.error || "position unavailable"}). Turn on device Location and try again.`;
  }
  if (location.status === "error") {
    return `GPS error: ${location.error || "unknown error"}.`;
  }
  return `Could not read device GPS coordinates (${location.error || "unknown"}).`;
}

async function collectLoginLocation(): Promise<LoginLocationPayload> {
  console.log("[GPS] === collectLoginLocation called ===");
  console.log("[GPS] Secure context (HTTPS):", typeof window !== "undefined" ? window.isSecureContext : "n/a");
  console.log("[GPS] Origin:", typeof window !== "undefined" ? window.location.origin : "n/a");

  if (typeof window === "undefined" || typeof navigator === "undefined" || !navigator.geolocation) {
    console.error("[GPS] navigator.geolocation NOT AVAILABLE");
    return { status: "unsupported", permissionState: "unknown", error: "Geolocation is not supported on this device." };
  }
  if (!window.isSecureContext) {
    console.error("[GPS] Not a secure context — geolocation blocked.");
    return { status: "error", permissionState: "unknown", error: "HTTPS is required for GPS." };
  }

  let permissionState: LoginLocationPayload["permissionState"] = "unknown";
  try {
    if (navigator.permissions?.query) {
      const permission = await navigator.permissions.query({ name: "geolocation" as PermissionName });
      permissionState = permission.state;
      console.log("[GPS] Permission state:", permission.state);
      if (permission.state === "denied") {
        return { status: "denied", permissionState, error: "Location permission is blocked in the browser." };
      }
    } else {
      console.log("[GPS] navigator.permissions.query not available — proceeding anyway.");
    }
  } catch (e) {
    console.warn("[GPS] permissions.query threw:", e);
  }

  console.log("[GPS] GPS request started (enableHighAccuracy=true, timeout=20000, maximumAge=0)");
  const startedAt = Date.now();

  return await new Promise<LoginLocationPayload>((resolve) => {
    let settled = false;
    const finish = (payload: LoginLocationPayload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsed = Date.now() - startedAt;
      console.log(`[GPS] finish (${elapsed}ms):`, payload);
      resolve({ permissionState, ...payload });
    };
    const onSuccess = (pos: GeolocationPosition) => {
      console.log("[GPS] GPS success");
      console.log("[GPS] Latitude:", pos.coords.latitude);
      console.log("[GPS] Longitude:", pos.coords.longitude);
      console.log("[GPS] Accuracy (m):", pos.coords.accuracy);
      console.log("[GPS] Timestamp:", pos.timestamp, new Date(pos.timestamp).toISOString());
      finish({
        status: "granted",
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        altitude: pos.coords.altitude,
        heading: pos.coords.heading,
        speed: pos.coords.speed,
        timestamp: pos.timestamp,
      });
    };
    const onError = (err: GeolocationPositionError) => {
      console.error("[GPS] GPS error code:", err.code, "message:", err.message);
      let status: LoginLocationPayload["status"] = "error";
      if (err.code === err.PERMISSION_DENIED) status = "denied";
      else if (err.code === err.POSITION_UNAVAILABLE) status = "unavailable";
      else if (err.code === err.TIMEOUT) status = "timeout";
      finish({ status, error: err.message || `code ${err.code}` });
    };
    const timer = window.setTimeout(() => {
      console.warn("[GPS] Wall-clock timeout hit (20s)");
      finish({ status: "timeout", error: "GPS fix timed out." });
    }, LOGIN_GEO_TIMEOUT_MS);

    try {
      navigator.geolocation.getCurrentPosition(onSuccess, onError, {
        enableHighAccuracy: true,
        timeout: LOGIN_GEO_TIMEOUT_MS,
        maximumAge: 0,
      });
    } catch (err: any) {
      console.error("[GPS] getCurrentPosition threw:", err);
      finish({ status: "error", error: err?.message || "Could not start location request." });
    }
  });
}

async function requireLoginLocation(): Promise<LoginLocationPayload> {
  const location = await collectLoginLocation();
  console.log("[GPS] Outgoing clientGeo payload:", {
    status: location.status,
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracy,
    timestamp: location.timestamp,
    permissionState: location.permissionState,
    error: location.error,
  });
  if (location.status !== "granted" || typeof location.latitude !== "number" || typeof location.longitude !== "number") {
    throw new Error(buildLocationSignInMessage(location));
  }
  const [publicIp, device] = await Promise.all([fetchBrowserPublicIp(), collectDeviceFingerprint()]);
  return { ...location, ...publicIp, device };
}

// --- API Helper (encrypted-only Supabase edge transport) ---

async function apiCall(functionName: string, body: any) {
  const token = getSessionToken();
  const pendingToken = (() => { try { return sessionGet("pending_admin_token" as any); } catch { return null; } })();
  const pendingActions = new Set(["request_admin_otp", "verify_otp", "verify_totp", "update_totp", "finalize_admin_session"]);
  const extraHeaders: Record<string, string> = {};
  if (token) extraHeaders["X-Session-Token"] = token;
  if (pendingToken && functionName === "manage-app" && pendingActions.has(body?.action)) extraHeaders["X-Pending-Token"] = pendingToken;

  const { invokeEdge } = await import("./lib/secureTransport");
  const { storeSessionPair, refreshNow, ensureFreshAccess } = await import("./lib/sessionRefresh");

  // C.2: proactively refresh if access token is within 30s of expiry,
  // but never for the refresh endpoint itself (would recurse).
  if (functionName === "manage-app" && body?.action !== "refresh_session") {
    await ensureFreshAccess(30_000).catch(() => {});
    // Re-read possibly-rotated token
    const t2 = getSessionToken();
    if (t2) extraHeaders["X-Session-Token"] = t2;
  }

  let data: any;
  try {
    data = await invokeEdge(functionName, body, { headers: extraHeaders });
  } catch (err: any) {
    const msg = String(err?.message || err || "");
    const looksExpired = /session expired|session revoked|authentication required|session invalid/i.test(msg);
    // C.2: single retry after refresh on stale-session errors, except for the
    // refresh endpoint itself and unauthenticated calls.
    if (looksExpired && functionName === "manage-app" && body?.action !== "refresh_session" && getSessionToken()) {
      const ok = await refreshNow();
      if (!ok) throw err;
      const t3 = getSessionToken();
      if (t3) extraHeaders["X-Session-Token"] = t3;
      data = await invokeEdge(functionName, body, { headers: extraHeaders });
    } else {
      throw err;
    }
  }

  if (data?.sessionToken) {
    sessionSet("session_token" as any, data.sessionToken);
  }
  if (data?.refreshToken || data?.expiresAt) {
    storeSessionPair(data);
  }
  return data;
}


class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error("[render-crash]", error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-[100dvh] bg-slate-950 text-white flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-3xl border border-red-500/30 bg-slate-900 p-6 shadow-2xl">
          <div className="flex items-center gap-3 text-red-300 font-black text-lg mb-3"><AlertCircle className="w-5 h-5" /> App recovered from an error</div>
          <p className="text-sm text-slate-300 mb-4">No more white screen — reload once to restore the latest app state.</p>
          <pre className="max-h-32 overflow-auto rounded-xl bg-black/30 p-3 text-[11px] text-red-100 mb-4">{this.state.error.message}</pre>
          <button onClick={() => window.location.reload()} className="w-full rounded-xl bg-red-600 py-3 font-bold hover:bg-red-700">Reload app</button>
        </div>
      </div>
    );
  }
}

function ResponsiveToaster() {
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" ? window.matchMedia("(max-width: 640px)").matches : true);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return (
    <Toaster
      position={isMobile ? "bottom-center" : "bottom-right"}
      closeButton
      expand={false}
      visibleToasts={2}
      duration={2600}
      offset={isMobile ? "calc(env(safe-area-inset-bottom) + 5.5rem)" : "5rem"}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "lux-toast group",
          title: "lux-toast-title",
          description: "lux-toast-desc",
          icon: "lux-toast-icon",
          closeButton: "lux-toast-close",
          success: "lux-variant-success",
          error: "lux-variant-error",
          info: "lux-variant-info",
          warning: "lux-variant-warning",
          loading: "lux-variant-loading",
        },
      }}
    />
  );
}

// --- Rate Limiter ---
const loginAttempts: { [key: string]: number[] } = {};
function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const window = 60_000;
  const maxAttempts = 5;
  if (!loginAttempts[key]) loginAttempts[key] = [];
  loginAttempts[key] = loginAttempts[key].filter(t => now - t < window);
  if (loginAttempts[key].length >= maxAttempts) return false;
  loginAttempts[key].push(now);
  return true;
}

// --- Auth Context ---
const AuthContext = createContext<{ user: any; loading: boolean; checkAuth: () => void } | null>(null);

const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Read cached user immediately for fast paint, then re-hydrate from the DB.
  const readCached = () => {
    try {
      const stored = sessionGet("user" as any);
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  };

  const hydrateFromServer = async () => {
    const token = getSessionToken();
    if (!token) {
      try { sessionRemove("user" as any); } catch {}
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const res = await apiCall("manage-app", { action: "me" });
      if (res?.success && res.user) {
        const merged = { ...(readCached() || {}), ...res.user };
        try { sessionSet("user" as any, JSON.stringify(merged)); } catch {}
        setUser(merged);
      } else {
        throw new Error(res?.error || "Session invalid");
      }
    } catch {
      // Session revoked, expired, or account missing → force logout
      try {
        sessionRemove("session_token" as any);
        sessionRemove("user" as any);
        sessionRemove("admin_auth" as any);
        sessionRemove("pending_admin_token" as any);
      } catch {}
      try { const { clearRefreshState } = await import("./lib/sessionRefresh"); clearRefreshState(); } catch {}
      setUser(null);

    } finally {
      setLoading(false);
    }
  };

  const checkAuth = () => {
    // Fast path: reflect tab session synchronously (used after login/logout).
    setUser(readCached());
    setLoading(false);
  };

  useEffect(() => {
    // Initial paint from cache so UI is not blocked, then verify against DB.
    setUser(readCached());
    // C.2: arm auto-refresh from any stored refresh token in this tab.
    import("./lib/sessionRefresh").then(({ armAutoRefresh }) => armAutoRefresh()).catch(() => {});
    void hydrateFromServer();
  }, []);


  return <AuthContext.Provider value={{ user, loading, checkAuth }}>{children}</AuthContext.Provider>;
};

const useAuth = () => useContext(AuthContext)!;

// --- Session Timeout Guard ---
// Reads admin-configured absolute session timeout (minutes) from app_settings.
// When elapsed, forces full logout: user must click their profile and re-enter password.
function useSessionTimeoutGuard(role: "admin" | "user", enabled = true) {
  const navigate = useNavigate();
  const { checkAuth } = useAuth();
  useEffect(() => {
    if (!enabled) return;
    let timer: any;
    let poll: any;
    let cancelled = false;
    const doLogout = () => {
      clearSessionData();
      checkAuth();
      toast("🔒 Session timed out", {
        id: "session-timed-out",
        description: "Tap your profile and enter password again.",
        duration: 3000,
      });
      navigate(role === "admin" ? "/admin" : "/", { replace: true });
    };
    (async () => {
      let minutes = 0;
      try {
        const res = await apiCall("manage-app", { action: "get_settings", key: SESSION_CONFIG_KEY_FOR(role) });
        minutes = Number(res?.value?.timeoutMinutes) || 0;
      } catch {}
      if (cancelled || !minutes || minutes <= 0) return;

      const armFrom = (started: number) => {
        const remaining = started + minutes * 60_000 - Date.now();
        if (remaining <= 0) { doLogout(); return; }
        if (timer) clearTimeout(timer);
        timer = setTimeout(doLogout, remaining);
      };

      const started = Number(sessionGet("session_started_at" as any) || "0");
      if (started) {
        armFrom(started);
      } else if (role === "admin") {
        // Admin has no email load — start immediately.
        markSessionStart();
        armFrom(Date.now());
      } else {
        // User: wait for EmailViewer to call markSessionStart after first inbox load.
        poll = setInterval(() => {
          if (cancelled) return;
          const s = Number(sessionGet("session_started_at" as any) || "0");
          if (s) {
            clearInterval(poll);
            poll = null;
            armFrom(s);
          }
        }, 500);
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, enabled]);
}

// ==================== NETFLIX N LOGO (inline SVG, no external asset) ====================
function NetflixNLogo({ className = "w-7 h-7 sm:w-8 sm:h-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 111 30" xmlns="http://www.w3.org/2000/svg" className={className} aria-label="Netflix" role="img">
      <path fill="#E50914" d="M105.06 14.28L110.6 30c-1.63-.23-3.26-.53-4.92-.75l-3.13-8.14-3.24 7.47c-1.57-.27-3.11-.36-4.68-.56L100.24 15 95.16 1.65h4.62l2.87 7.35 3.06-7.35H110l-4.94 12.63zM90.72 1.65h-4.19V27.9c1.37.08 2.8.15 4.19.31V1.65zm-7.75 25.72c-3.82-.26-7.66-.5-11.56-.6V1.65h4.24V22.7c2.45.05 4.9.24 7.32.36v4.31zM64.63 11.61v4.29h-5.79v9.61h-4.19V1.65h11.87v4.29h-7.68v5.67h5.79zm-15.36-5.67v20.11c-1.42 0-2.87 0-4.24.03V5.94H40.66V1.65c4.79 0 9.59 0 14.38 0v4.29h-5.77zm-14.5 15.83c1.88.04 3.79.19 5.66.28v4.24c-3.03-.19-6.06-.38-9.15-.45V1.65h4.24v19.35c.11.12-.75.12-.75.77zM26.83 27.4c-1.31-.03-2.65-.03-3.99-.03V1.65h3.99V27.4zM6.29 14.35v14.5c-1.5.16-2.83.36-4.23.58V1.65h3.95l5.4 15.1V1.65h4.24v27.62c-1.5.27-3.03.42-4.61.7L6.29 14.35z"/>
    </svg>
  );
}

// ==================== NOTIFICATION BELL ====================
// Complete rewrite: mobile = bottom sheet portal; desktop = editorial glass panel.
// Polling pauses while open; SessionCountdown hides via window events.

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function useIsMobile() {
  const [is, setIs] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 639px)").matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setIs(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return is;
}

// ==============================================================
// Notification System — Premium unified popup + auto-popup
// ==============================================================

const CATEGORY_META: Record<string, { label: string; icon: any; color: string }> = {
  announcement: { label: "Announcement", icon: Megaphone,     color: "text-sky-300" },
  update:       { label: "Update",       icon: Sparkles,      color: "text-violet-300" },
  security:     { label: "Security",     icon: Shield,        color: "text-emerald-300" },
  maintenance:  { label: "Maintenance",  icon: Wrench,        color: "text-amber-300" },
  promo:        { label: "Offer",        icon: Tag,           color: "text-pink-300" },
  billing:      { label: "Billing",      icon: CreditCard,    color: "text-cyan-300" },
};
const PRIORITY_ACCENT: Record<string, string> = {
  low: "bg-zinc-500",
  normal: "bg-sky-500",
  high: "bg-amber-500",
  critical: "bg-rose-500",
};

function categoryMeta(cat?: string | null) {
  return CATEGORY_META[cat || "announcement"] || CATEGORY_META.announcement;
}

// ---- Shared refresh signal so bell + popup + list stay in sync ----
const NOTIF_REFRESH_EVENT = "notif:refresh";
function requestNotifRefresh() {
  window.dispatchEvent(new CustomEvent(NOTIF_REFRESH_EVENT));
}

// Global notifications store (shared across bell + popup)
function useNotifications() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (items.length === 0) setLoading(true);
    try {
      const list = await listNotifications();
      setItems(list);
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [items.length]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    const onEvt = () => refresh();
    window.addEventListener(NOTIF_REFRESH_EVENT, onEvt);
    return () => { clearInterval(id); window.removeEventListener(NOTIF_REFRESH_EVENT, onEvt); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { items, setItems, loading, refresh };
}

// ---------- Auto-popup: premium modal shown on first sight of a notification ----------
function AutoPopupNotification() {
  const [queue, setQueue] = useState<AppNotification[]>([]);
  const [dismissing, setDismissing] = useState(false);
  const seenRef = useRef<Set<string>>(getPoppedIds());

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      const list = await listNotifications();
      if (cancelled) return;
      const fresh = list.filter((n) =>
        !seenRef.current.has(n.id) &&
        !n.read &&
        !(n.locked) &&
        (!n.snoozed_until || new Date(n.snoozed_until) < new Date())
      );
      if (fresh.length) {
        // Priority order (kid-friendly rule):
        // 1) Security / password-reset notifications first (force to top).
        // 2) Then admin announcements in FIFO order (oldest unseen first) —
        //    so a brand-new user's first login shows the first admin message first.
        // 3) Everything else after, newest first.
        const rank = (n: AppNotification): number => {
          const cat = (n.category || "").toLowerCase();
          const sub = (n.sub_kind || "").toLowerCase();
          if (cat === "security" || sub.includes("password") || sub.includes("reset")) return 0;
          if (cat === "announcement" || cat === "update" || cat === "maintenance") return 1;
          return 2;
        };
        fresh.sort((a, b) => {
          const ra = rank(a), rb = rank(b);
          if (ra !== rb) return ra - rb;
          // critical priority beats non-critical within the same rank bucket
          const cra = a.priority === "critical" ? 1 : 0, crb = b.priority === "critical" ? 1 : 0;
          if (cra !== crb) return crb - cra;
          const ta = new Date(a.created_at).getTime(), tb = new Date(b.created_at).getTime();
          // Rank 1 (admin announcements) = oldest first (FIFO). Others = newest first.
          return ra === 1 ? ta - tb : tb - ta;
        });
        setQueue((prev) => (prev.length ? prev : fresh.slice(0, 3)));
      }
    }
    tick();
    const id = setInterval(tick, 30_000);
    const onEvt = () => tick();
    window.addEventListener(NOTIF_REFRESH_EVENT, onEvt);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener(NOTIF_REFRESH_EVENT, onEvt); };
  }, []);

  const current = queue[0];

  useEffect(() => {
    if (!current) return;
    // hide session countdown while modal is open
    window.dispatchEvent(new CustomEvent("notif:open"));
    logNotificationEvent(current.id, "delivered").catch(() => {});
    markNotificationSeen([current.id]).catch(() => {});
    return () => { window.dispatchEvent(new CustomEvent("notif:close")); };
  }, [current?.id]);

  const dismiss = async (opened = false) => {
    if (!current) return;
    setDismissing(true);
    markPopped(current.id);
    seenRef.current.add(current.id);
    if (!opened) await logNotificationEvent(current.id, "dismissed").catch(() => {});
    setTimeout(() => {
      setDismissing(false);
      setQueue((q) => q.slice(1));
    }, 180);
  };

  const openInBell = () => {
    dismiss(true);
    setTimeout(() => window.dispatchEvent(new CustomEvent("notif:openCenter", { detail: { id: current?.id } })), 220);
  };

  if (!current || typeof document === "undefined") return null;
  const cat = categoryMeta(current.category);
  const CatIcon = cat.icon;
  const accent = PRIORITY_ACCENT[current.priority || "normal"] || PRIORITY_ACCENT.normal;

  return createPortal(
    <AnimatePresence>
      {!dismissing && (
        <motion.div
          key={`popup-${current.id}`}
          className="fixed inset-0 z-[110] flex items-center justify-center p-3 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={() => dismiss(false)} />
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={{ scale: 0.94, y: 16, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.96, y: 8, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            className="relative w-full max-w-[440px] rounded-3xl overflow-hidden"
            style={{
              background: "rgba(14,14,17,0.92)",
              backdropFilter: "blur(28px) saturate(160%)",
              WebkitBackdropFilter: "blur(28px) saturate(160%)",
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: "0 40px 100px -20px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.06)",
            }}
          >
            {/* priority accent bar */}
            <div className={`absolute inset-x-0 top-0 h-[3px] ${accent}`} />

            {/* close */}
            <button
              onClick={() => dismiss(false)}
              className="absolute top-3 right-3 z-10 p-1.5 rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>

            {/* hero image */}
            {current.image_url ? (
              <div className="relative aspect-[16/9] w-full overflow-hidden bg-zinc-900">
                <img
                  src={current.image_url}
                  alt=""
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  className="absolute inset-0 w-full h-full object-cover"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
              </div>
            ) : (
              <div className="pt-10" />
            )}

            <div className="px-6 pb-6 pt-5">
              {/* icon medallion */}
              <div className="flex items-center gap-2.5 mb-3">
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-white/[0.06] border border-white/10">
                  <CatIcon className={`w-4 h-4 ${cat.color}`} />
                </span>
                <span className="text-[10.5px] uppercase tracking-[0.14em] text-zinc-400 font-medium">
                  {cat.label}
                </span>
              </div>

              <h2
                className="text-white text-[22px] leading-tight mb-2"
                style={{ fontFamily: "'Instrument Serif', 'Cormorant Garamond', ui-serif, Georgia, serif", letterSpacing: "-0.015em" }}
              >
                {current.title}
              </h2>
              <p className="text-zinc-300 text-[13.5px] leading-relaxed font-light whitespace-pre-wrap">
                {current.body}
              </p>
              {current.description && (
                <p className="mt-3 text-zinc-400 text-[12.5px] leading-relaxed font-light whitespace-pre-wrap line-clamp-6">
                  {current.description}
                </p>
              )}

              <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2.5">
                <button
                  onClick={() => dismiss(false)}
                  className="flex-1 py-2.5 rounded-xl text-[13px] font-medium text-zinc-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 transition-colors"
                >
                  Later
                </button>
                {current.action_url && current.action_label && !/snooze|archive|24h/i.test(current.action_label) ? (
                  <a
                    href={current.action_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => { logNotificationEvent(current.id, "clicked", { url: current.action_url }).catch(() => {}); markNotificationRead(current.id).catch(() => {}); dismiss(true); }}
                    className="flex-1 py-2.5 rounded-xl text-[13px] font-semibold text-white bg-white hover:bg-zinc-100 !text-black flex items-center justify-center gap-1.5 transition-colors"
                  >
                    {current.action_label} <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                ) : (
                  <button
                    onClick={openInBell}
                    className="flex-1 py-2.5 rounded-xl text-[13px] font-semibold text-black bg-white hover:bg-zinc-100 transition-colors"
                  >
                    Read more
                  </button>
                )}
              </div>

              <p className="mt-3 text-center text-[10.5px] text-zinc-500 tracking-wide">
                Dismiss — you can reopen this from the <Bell className="inline w-3 h-3 -mt-0.5" /> bell any time.
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ---------- Full Notification Center (unified popup: mobile sheet + desktop modal) ----------
type Tab = "all" | "unread";

function NotificationCenter({ open, onClose, initialId, items, loading, onChange }: {
  open: boolean;
  onClose: () => void;
  initialId?: string | null;
  items: AppNotification[];
  loading: boolean;
  onChange: () => void;
}) {
  const isMobile = useIsMobile();
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setSelected(null); return; }
    if (initialId) setSelected(initialId);
    window.dispatchEvent(new CustomEvent("notif:open"));
    // mark visible as seen
    const visibleIds = items.filter((n) => !n.seen).map((n) => n.id);
    if (visibleIds.length) markNotificationSeen(visibleIds).catch(() => {});
    if (isMobile) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
        window.dispatchEvent(new CustomEvent("notif:close"));
      };
    }
    return () => { window.dispatchEvent(new CustomEvent("notif:close")); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selected) setSelected(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, selected, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((n) => {
      if (tab === "unread" && n.read) return false;
      if (q && !(`${n.title} ${n.body} ${n.description || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [items, tab, query]);

  const detail = selected ? items.find((n) => n.id === selected) : null;

  const handleOpenDetail = async (n: AppNotification) => {
    setSelected(n.id);
    if (!n.read) {
      await markNotificationRead(n.id).catch(() => {});
      onChange();
    }
  };

  const handleDelete = async (id: string) => {
    await deleteNotificationForMe(id);
    onChange();
    if (selected === id) setSelected(null);
  };

  // Snooze removed — no user-facing action.


  const handleMarkAllRead = async () => {
    await markAllNotificationsRead();
    onChange();
    toast.success("All caught up");
  };

  // ---- grouped rendering ----
  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  const Header = (
    <div className="px-5 pt-5 pb-3 border-b border-white/[0.06]">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2.5">
          <h3
            className="text-white text-[22px] leading-none"
            style={{ fontFamily: "'Instrument Serif', 'Cormorant Garamond', ui-serif, Georgia, serif", letterSpacing: "-0.015em" }}
          >
            {detail ? "Notification" : "Notifications"}
          </h3>
          {!detail && items.filter((n) => !n.read).length > 0 && (
            <span className="text-[10.5px] font-medium text-rose-300/90 tracking-wider uppercase">
              {items.filter((n) => !n.read).length} new
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {detail ? (
            <button onClick={() => setSelected(null)} className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors" aria-label="Back">
              <ArrowLeft className="w-4 h-4" />
            </button>
          ) : (
            items.some((n) => !n.read) && (
              <button onClick={handleMarkAllRead} title="Mark all read" className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors">
                <CheckCircle2 className="w-4 h-4" />
              </button>
            )
          )}
          <button onClick={onClose} className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {!detail && (
        <>
          <div className="mt-4 flex items-center gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
            {(["all", "unread"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded-full text-[11.5px] font-medium tracking-wide capitalize transition-colors whitespace-nowrap ${
                  tab === t ? "bg-white text-black" : "text-zinc-400 hover:text-white bg-white/[0.04] hover:bg-white/[0.08]"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="mt-3 relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search notifications"
              aria-label="Search notifications"
              className="w-full pl-9 pr-3 py-2 rounded-xl text-[12.5px] bg-white/[0.04] border border-white/[0.06] text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/20"
            />
          </div>
        </>
      )}
    </div>
  );

  const List = (
    <div className="overflow-y-auto overscroll-contain flex-1">
      {loading && items.length === 0 && (
        <div className="py-16 text-center text-zinc-500 text-sm font-light tracking-wide">
          <div className="w-5 h-5 mx-auto mb-3 border border-zinc-600 border-t-rose-500 rounded-full animate-spin" />
          Loading
        </div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="py-20 px-6 text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-white/[0.04] border border-white/10 flex items-center justify-center">
            <Bell className="w-6 h-6 text-zinc-500 stroke-[1.25]" />
          </div>
          <p className="text-zinc-200 text-[14px] font-light tracking-wide">You're all caught up</p>
          <p className="text-zinc-500 text-[12px] mt-1 font-light">Nothing new here right now.</p>
        </div>
      )}
      {groups.map(({ label, rows }) => (
        <div key={label}>
          <div className="px-5 pt-4 pb-1 text-[10px] uppercase tracking-[0.14em] text-zinc-500 font-medium">{label}</div>
          <ul>
            {rows.map((n) => {
              const cat = categoryMeta(n.category);
              const CatIcon = cat.icon;
              const accent = PRIORITY_ACCENT[n.priority || "normal"] || PRIORITY_ACCENT.normal;
              return (
                <li key={n.id} className="group relative">
                  <button
                    onClick={() => handleOpenDetail(n)}
                    className={`w-full text-left px-5 py-3.5 flex gap-3 transition-colors ${!n.read ? "bg-white/[0.02] hover:bg-white/[0.05]" : "hover:bg-white/[0.03]"}`}
                  >
                    <div className="flex flex-col items-center flex-shrink-0">
                      <span className={`w-1 h-full rounded-full ${accent} opacity-70`} style={{ minHeight: 30 }} />
                    </div>
                    {n.image_url ? (
                      <img src={n.image_url} referrerPolicy="no-referrer" loading="lazy" alt=""
                        className="w-11 h-11 rounded-lg object-cover flex-shrink-0 bg-zinc-800" />
                    ) : (
                      <div className="w-11 h-11 rounded-lg bg-white/[0.04] border border-white/10 flex-shrink-0 flex items-center justify-center">
                        <CatIcon className={`w-4 h-4 ${cat.color}`} />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className={`text-[13px] leading-snug truncate ${!n.read ? "text-white font-medium" : "text-zinc-400 font-normal"}`}>
                          {n.title}
                        </p>
                        <span className="text-[10.5px] text-zinc-500 font-light tabular-nums flex-shrink-0 transition-opacity group-hover:opacity-0" title={new Date(n.created_at).toLocaleString()}>
                          {formatRelative(n.created_at)}
                        </span>
                      </div>
                      <p className="text-zinc-500 text-[12px] mt-1 leading-relaxed line-clamp-2 font-light">{n.body}</p>
                    </div>
                    {!n.read && (
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.7)] mt-1.5 flex-shrink-0 transition-opacity group-hover:opacity-0" />
                    )}
                  </button>
                  {!n.locked && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 pointer-events-none group-hover:pointer-events-auto">
                      <button onClick={(e) => { e.stopPropagation(); handleDelete(n.id); }} className="p-1.5 rounded-md bg-black/70 backdrop-blur border border-white/10 text-zinc-300 hover:text-rose-300 hover:bg-black/80 shadow-lg" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );

  const Detail = detail && (() => {
    const cat = categoryMeta(detail.category);
    const CatIcon = cat.icon;
    const accent = PRIORITY_ACCENT[detail.priority || "normal"] || PRIORITY_ACCENT.normal;
    return (
      <div className="overflow-y-auto overscroll-contain flex-1">
        {detail.image_url && (
          <div className="relative aspect-[16/9] w-full overflow-hidden bg-zinc-900">
            <img src={detail.image_url} alt="" referrerPolicy="no-referrer" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
          </div>
        )}
        <div className="px-6 py-5">
          <div className="flex items-center gap-2 mb-3">
            <span className={`w-1.5 h-1.5 rounded-full ${accent}`} />
            <span className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.14em] text-zinc-400 font-medium">
              <CatIcon className={`w-3.5 h-3.5 ${cat.color}`} /> {cat.label}
            </span>
            <span className="text-[10.5px] text-zinc-500 ml-auto">{new Date(detail.created_at).toLocaleString()}</span>
          </div>
          <h2 className="text-white text-[24px] leading-tight mb-3" style={{ fontFamily: "'Instrument Serif', ui-serif, Georgia, serif", letterSpacing: "-0.015em" }}>
            {detail.title}
          </h2>
          <p className="text-zinc-200 text-[14px] leading-relaxed font-light whitespace-pre-wrap">{detail.body}</p>
          {detail.description && (
            <p className="mt-4 text-zinc-400 text-[13px] leading-relaxed font-light whitespace-pre-wrap">{detail.description}</p>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            {detail.action_url && detail.action_label && !/snooze|archive|24h/i.test(detail.action_label) && (
              <a href={detail.action_url} target="_blank" rel="noopener noreferrer"
                onClick={() => logNotificationEvent(detail.id, "clicked", { url: detail.action_url }).catch(() => {})}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-semibold bg-white text-black hover:bg-zinc-100 transition-colors">
                {detail.action_label} <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            {detail.action2_url && detail.action2_label && !/snooze|archive|24h/i.test(detail.action2_label) && (
              <a href={detail.action2_url} target="_blank" rel="noopener noreferrer"
                onClick={() => logNotificationEvent(detail.id, "clicked", { url: detail.action2_url, secondary: true }).catch(() => {})}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium bg-white/[0.06] text-white hover:bg-white/[0.12] border border-white/10 transition-colors">
                {detail.action2_label}
              </a>
            )}
          </div>
          <div className="mt-6 pt-4 border-t border-white/[0.05] flex gap-2">
            {detail.locked ? (
              <div className="flex-1 py-2 rounded-lg text-[12px] text-zinc-500 bg-white/[0.02] border border-white/5 inline-flex items-center justify-center gap-1.5">
                <Lock className="w-3.5 h-3.5" /> Locked by admin
              </div>
            ) : (
              <button onClick={() => handleDelete(detail.id)} className="flex-1 py-2 rounded-lg text-[12px] text-rose-300 bg-rose-500/[0.06] hover:bg-rose-500/[0.12] border border-rose-500/20 transition-colors inline-flex items-center justify-center gap-1.5">
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            )}
          </div>
        </div>
      </div>
    );
  })();

  if (!open || typeof document === "undefined") return null;

  const surfaceStyle: React.CSSProperties = {
    background: "rgba(10,10,12,0.88)",
    backdropFilter: "blur(32px) saturate(160%)",
    WebkitBackdropFilter: "blur(32px) saturate(160%)",
    border: "1px solid rgba(255,255,255,0.06)",
    boxShadow: "0 30px 80px -20px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.05)",
  };

  const Panel = isMobile ? (
    <motion.div
      role="dialog"
      aria-modal="true"
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
      className="absolute left-0 right-0 bottom-0 flex flex-col rounded-t-3xl overflow-hidden"
      style={{ ...surfaceStyle, height: "min(78dvh, 720px)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        className="mx-auto mt-2.5 mb-1 w-10 h-1 rounded-full bg-white/25 hover:bg-white/40 transition-colors flex-shrink-0"
      />
      {Header}
      {detail ? Detail : List}
    </motion.div>
  ) : (
    <motion.div
      role="dialog"
      aria-modal="true"
      initial={{ scale: 0.96, y: 8, opacity: 0 }}
      animate={{ scale: 1, y: 0, opacity: 1 }}
      exit={{ scale: 0.98, opacity: 0 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="relative w-full max-w-[680px] flex flex-col rounded-3xl overflow-hidden"
      style={{ ...surfaceStyle, maxHeight: "min(84vh, 860px)" }}
    >
      {Header}
      {detail ? Detail : List}
    </motion.div>
  );

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="notif-center"
        className={`fixed inset-0 z-[100] ${isMobile ? "" : "flex items-center justify-center p-4"}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
      >
        <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} />
        {Panel}
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}

function groupByDate(list: AppNotification[]) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYest = startToday - 86400_000;
  const startWeek = startToday - 6 * 86400_000;
  const buckets: { label: string; rows: AppNotification[] }[] = [
    { label: "Today", rows: [] },
    { label: "Yesterday", rows: [] },
    { label: "This week", rows: [] },
    { label: "Earlier", rows: [] },
  ];
  for (const n of list) {
    const t = new Date(n.created_at).getTime();
    if (t >= startToday) buckets[0].rows.push(n);
    else if (t >= startYest) buckets[1].rows.push(n);
    else if (t >= startWeek) buckets[2].rows.push(n);
    else buckets[3].rows.push(n);
  }
  return buckets.filter((b) => b.rows.length);
}

function NotificationBell() {
  const { items, loading, refresh } = useNotifications();
  const [open, setOpen] = useState(false);
  const [initialId, setInitialId] = useState<string | null>(null);

  useEffect(() => {
    const onOpenCenter = (e: any) => {
      setInitialId(e?.detail?.id || null);
      setOpen(true);
    };
    window.addEventListener("notif:openCenter", onOpenCenter);
    return () => window.removeEventListener("notif:openCenter", onOpenCenter);
  }, []);

  const active = items;
  const unread = active.filter((n) => !n.read).length;
  const highestPriority = active.filter((n) => !n.read).reduce<string>((acc, n) => {
    const rank = (p?: string) => ({ low: 1, normal: 2, high: 3, critical: 4 } as any)[p || "normal"] || 2;
    return rank(n.priority) > rank(acc) ? (n.priority || "normal") : acc;
  }, "normal");
  const dotColor = highestPriority === "critical" ? "bg-rose-500"
    : highestPriority === "high" ? "bg-amber-500"
    : "bg-rose-500";

  return (
    <>
      <button
        onClick={() => { setInitialId(null); setOpen(true); }}
        className="relative flex items-center justify-center p-2.5 bg-slate-900 text-white rounded-full hover:bg-slate-800 transition-all active:scale-95"
        title="Notifications"
        aria-label={`Notifications (${unread} unread)`}
      >
        <Bell className={`w-4 h-4 sm:w-5 sm:h-5 ${unread > 0 ? "animate-pulse" : ""}`} />
        {unread > 0 && (
          <>
            <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full animate-ping ${dotColor}`} />
            <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white ${dotColor}`} />
          </>
        )}
      </button>
      <NotificationCenter
        open={open}
        onClose={() => { setOpen(false); refresh(); }}
        initialId={initialId}
        items={items}
        loading={loading}
        onChange={refresh}
      />
      <AutoPopupNotification />
    </>
  );
}





function SessionCountdown({ role }: { role: "admin" | "user" }) {
  const [minutes, setMinutes] = useState<number>(0);
  const [remainingMs, setRemainingMs] = useState<number>(0);
  const warnedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiCall("manage-app", { action: "get_settings", key: SESSION_CONFIG_KEY_FOR(role) });
        const m = Number(res?.value?.timeoutMinutes) || 0;
        if (!cancelled) setMinutes(m);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [role]);

  useEffect(() => {
    if (!minutes || minutes <= 0) return;
    warnedRef.current = false;
    const tick = () => {
      const started = Number(sessionGet("session_started_at" as any) || "0");
      if (!started) { setRemainingMs(0); return; }
      const rem = started + minutes * 60_000 - Date.now();
      setRemainingMs(Math.max(0, rem));
      if (rem > 0 && rem <= 60_000 && !warnedRef.current) {
        warnedRef.current = true;
        toast("⏰ Session ending in 1 minute", {
          id: "session-1min-warning",
          description: "Finish what you're doing — you'll need to sign in again soon.",
          duration: 5000,
        });
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [minutes]);

  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const onOpen = () => setHidden(true);
    const onClose = () => setHidden(false);
    window.addEventListener("notif:open", onOpen);
    window.addEventListener("notif:close", onClose);
    return () => {
      window.removeEventListener("notif:open", onOpen);
      window.removeEventListener("notif:close", onClose);
    };
  }, []);
  if (hidden) return null;
  if (!minutes || minutes <= 0 || remainingMs <= 0) return null;

  const totalSec = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  const urgent = remainingMs <= 60_000;
  const warn = !urgent && remainingMs <= 120_000;
  const cls = urgent
    ? "bg-red-500 text-white animate-pulse ring-2 ring-red-300"
    : warn
    ? "bg-amber-500 text-white"
    : "bg-slate-900/90 text-white";

  // Bottom-right on both mobile and desktop, above the browser nav bar.
  return (
    <div
      className={`fixed z-40 right-3 sm:right-4 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:bottom-4 h-6 sm:h-7 px-2.5 sm:px-3 rounded-full text-[10px] sm:text-xs font-semibold shadow-lg backdrop-blur ${cls} flex items-center gap-1 sm:gap-1.5 pointer-events-none select-none`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
      {role === "admin" ? "Admin" : "Session"}: {pad(mm)}:{pad(ss)}
    </div>
  );
}

// --- Types ---
interface Email {
  id: string; subject: string; from: string; to?: string; date: string; otp: string | null; preview: string; html: string; account_label?: string | null; cached_at?: string | null;
}
interface UserData {
  id: string; username: string; name: string; role: "admin" | "user"; totpSecret?: string; mustChangePassword?: boolean; assignedAccounts?: string[] | null; profileAvatar?: string | null; profilePrefs?: UserProfilePrefs;
}

function getUserRefreshAccountLabels(user: Partial<UserData>): string[] | null {
  if (Array.isArray(user.assignedAccounts)) {
    return Array.from(new Set(user.assignedAccounts.map(String).map((s) => s.trim()).filter(Boolean)));
  }
  return user.role === "admin" ? null : [];
}

function buildWorkerRequestGroups(labels: string[] | null, map: WorkerUrlMap, primaryUrls: string[]) {
  const norm = (u: string) => u.trim().replace(/\/+$/, "");
  const primary = Array.from(new Set([...(map.primary || []), ...primaryUrls].map(norm).filter(Boolean)));

  // Admin / unrestricted: hit exactly one worker (any primary).
  if (labels === null) {
    const pool = primary.length > 0 ? primary : Array.from(new Set(Object.values(map.byAccount || {}).flat().map(norm).filter(Boolean)));
    const url = pool.length > 0 ? pool[0] : "";
    return url ? [{ url, labels: null as string[] | null }] : [];
  }

  if (labels.length === 0) return [];

  // Build per-label URL pool (dedicated overrides primary).
  const pools: { label: string; pool: string[] }[] = labels.map((label) => {
    const dedicated = Array.from(new Set((map.byAccount?.[label] || []).map(norm).filter(Boolean)));
    return { label, pool: dedicated.length > 0 ? dedicated : primary };
  }).filter((x) => x.pool.length > 0);

  if (pools.length === 0) return [];

  // Fast path: if a single URL exists in EVERY label's pool, use one grouped request.
  const shared = pools.reduce<string[]>((acc, { pool }, i) => {
    if (i === 0) return [...pool];
    return acc.filter((u) => pool.includes(u));
  }, []);
  if (shared.length > 0) {
    return [{ url: shared[0], labels: pools.map((p) => p.label) }];
  }

  // Otherwise: deterministic grouping — each label goes to the first URL in its pool.
  // Labels that resolve to the same URL are merged into one request; distinct URLs run in parallel.
  const grouped = new Map<string, string[]>();
  for (const { label, pool } of pools) {
    const url = pool[0];
    grouped.set(url, [...(grouped.get(url) || []), label]);
  }
  return Array.from(grouped.entries()).map(([url, groupLabels]) => ({ url, labels: groupLabels }));
}

function appendAccountLabelParams(params: URLSearchParams, labels: string[] | null) {
  if (!labels) return;
  for (const label of labels) params.append("accountLabel", label);
}

function mergeEmailsById(lists: Email[][]): Email[] {
  const byId = new Map<string, Email>();
  for (const list of lists) {
    for (const email of list) {
      if (email?.id) byId.set(email.id, email);
    }
  }
  return Array.from(byId.values()).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

type UserProfilePrefs = {
  avatarId?: string | null;
  hiddenBefore?: string | null;
  hiddenEmailIds?: string[];
};

// --- Password Toggle Helper ---
function PasswordInput({ value, onChange, placeholder, className, autoFocus, required }: {
  value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string; className?: string; autoFocus?: boolean; required?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? "text" : "password"} value={value} onChange={onChange}
        placeholder={placeholder}
        aria-label={placeholder || "Password"}
        className={(className || "") + " text-slate-900 placeholder:text-slate-400"}
        autoFocus={autoFocus} required={required} />
      <button type="button" onClick={() => setShow(!show)}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors p-1">
        {show ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

// --- Profile Colors ---
const PROFILE_COLORS = [
  "bg-red-500", "bg-blue-500", "bg-green-500", "bg-purple-500",
  "bg-orange-500", "bg-pink-500", "bg-teal-500", "bg-indigo-500",
];

function getAvatarUri(avatarId?: string | null): string | null {
  return resolveAvatar(avatarId);
}

const DEFAULT_PROFILE_AVATAR_IDS = AVATAR_CATEGORIES.flatMap((category) =>
  category.files.map((file) => buildAvatarId(category.key, file))
);

function getStableProfileAvatar(profile?: Pick<UserData, "id" | "username" | "name" | "profileAvatar"> | null): string | null {
  if (!profile) return null;
  if (profile.profileAvatar && getAvatarUri(profile.profileAvatar)) return profile.profileAvatar;
  if (DEFAULT_PROFILE_AVATAR_IDS.length === 0) return null;
  const seed = `${profile.id || profile.username || "profile"}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return DEFAULT_PROFILE_AVATAR_IDS[hash % DEFAULT_PROFILE_AVATAR_IDS.length];
}

function ProfileAvatar({ avatarId, name, className = "w-16 h-16", fallbackColor = "bg-red-500", eager = false }: { avatarId?: string | null; name?: string; className?: string; fallbackColor?: string; eager?: boolean }) {
  const uri = getAvatarUri(avatarId);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [uri]);
  if (!uri || failed) {
    return (
      <div className={`${className} rounded-xl sm:rounded-2xl ${fallbackColor} shadow-lg shadow-black/30 ring-1 ring-white/10 overflow-hidden`} aria-label={name || undefined} />
    );
  }
  return (
    <div className={`${className} relative rounded-xl sm:rounded-2xl bg-slate-900 overflow-hidden shadow-lg shadow-black/30 ring-1 ring-white/10`}>
      <img
        src={uri}
        loading={eager ? "eager" : "lazy"}
        decoding={eager ? "sync" : "async"}
        fetchPriority={eager ? "high" : "auto"}
        alt=""
        onError={() => setFailed(true)}
        className="w-full h-full object-cover"
      />
    </div>
  );
}

const warmedAvatarUrls = new Set<string>();
const loadedAvatarUrls = new Set<string>();
const avatarLoadPromises = new Map<string, Promise<void>>();

function warmAvatarUrls(urls: string[], priority: "high" | "low" = "low") {
  if (typeof window === "undefined") return;
  urls.forEach((url) => {
    if (warmedAvatarUrls.has(`${priority}:${url}`)) return;
    warmedAvatarUrls.add(`${priority}:${url}`);
    const link = document.createElement("link");
    link.rel = priority === "high" ? "preload" : "prefetch";
    link.as = "image";
    link.href = url;
    if (priority === "high") link.setAttribute("fetchpriority", "high");
    document.head.appendChild(link);

    const img = new Image();
    img.decoding = priority === "high" ? "sync" : "async";
    img.src = url;
  });
}

function loadAvatarUrl(url: string): Promise<void> {
  if (loadedAvatarUrls.has(url)) return Promise.resolve();
  const existing = avatarLoadPromises.get(url);
  if (existing) return existing;

  const promise = new Promise<void>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    const done = () => {
      loadedAvatarUrls.add(url);
      resolve();
    };
    img.onload = done;
    img.onerror = done;
    img.src = url;
    if (img.complete) done();
  });
  avatarLoadPromises.set(url, promise);
  return promise;
}

function preloadAvatarUrls(urls: string[], maxWaitMs = 6000, priority: "high" | "low" = "high"): Promise<void> {
  if (urls.length === 0) return Promise.resolve();
  warmAvatarUrls(urls, priority);
  return Promise.race([
    Promise.allSettled(urls.map(loadAvatarUrl)).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, maxWaitMs)),
  ]);
}

function getCategoryKeyFromAvatarId(avatarId?: string | null): string | null {
  if (!avatarId?.startsWith("netflix:")) return null;
  const [, key] = avatarId.split(":");
  return AVATAR_CATEGORIES.some((category) => category.key === key) ? key : null;
}

function warmAvatarCategory(categoryKey: string, priority: "high" | "low" = "low") {
  warmAvatarUrls(getAvatarCategoryUrls(categoryKey), priority);
}

function preloadAvatarCategory(categoryKey: string, maxWaitMs?: number, priority: "high" | "low" = "high") {
  return preloadAvatarUrls(getAvatarCategoryUrls(categoryKey), maxWaitMs, priority);
}



function emailIdentity(email: Pick<Email, "id" | "account_label">) {
  return `${email.account_label || "Primary"}:${email.id}`;
}

type EmailCategory = "signin" | "password_reset" | "account_update" | "other";
const RE_SIGNIN = /(sign[\s-]?in code|new sign[\s-]?in|new device|temporary access code|is using your account|access your account|otp)/i;
const RE_PASSWORD_RESET = /(password (was |has been )?(changed|reset|updated)|reset your password|new password)/i;
const RE_ACCOUNT_UPDATE = /(account (information|info|details) (was |has been )?(changed|updated)|changes to your account|change to your account|email (address )?(was |has been )?(changed|updated)|new email address|membership (was |has been )?(cancell?ed|updated|paused)|account (was |has been )?(cancell?ed|deleted|closed|paused|on hold)|we[’']re sorry to see you go|payment method (was |has been )?(updated|changed|declined)|update your account|make (a |any )?(change|changes) to your account|confirm your account change|request to make a change)/i;

function classifyEmail(e: Email): EmailCategory {
  const subject = (e.subject || "").toLowerCase();
  const preview = (e.preview || "").toLowerCase();
  const combined = `${subject} ${preview}`;
  if (RE_ACCOUNT_UPDATE.test(combined)) return "account_update";
  if (RE_PASSWORD_RESET.test(combined)) return "password_reset";
  if (e.otp || RE_SIGNIN.test(combined) || /verification code/i.test(subject)) return "signin";
  return "other";
}

function filterVisibleEmails(list: Email[], prefs?: UserProfilePrefs | null) {
  const hiddenIds = new Set(prefs?.hiddenEmailIds || []);
  const hiddenBeforeTime = prefs?.hiddenBefore ? new Date(prefs.hiddenBefore).getTime() : 0;
  const filters = getEmailFilters();
  const hideSignin = filters.showSignInCodes === false;
  const hideReset = filters.showPasswordResets === false;
  const hideAccountUpdate = filters.showAccountUpdates === false;
  return list.filter((email) => {
    if (hiddenIds.has(email.id) || hiddenIds.has(emailIdentity(email))) return false;
    if (hiddenBeforeTime) {
      const emailTime = new Date(email.date || 0).getTime();
      if (!Number.isNaN(emailTime) && emailTime <= hiddenBeforeTime) return false;
    }
    if (hideSignin || hideReset || hideAccountUpdate) {
      const cat = classifyEmail(email);
      if (hideSignin && cat === "signin") return false;
      if (hideReset && cat === "password_reset") return false;
      if (hideAccountUpdate && cat === "account_update") return false;
    }
    return true;
  });
}

// ==================== CAPTCHA MODAL (shared) ====================
function CaptchaModal({ siteKey, onVerify, onCancel }: { siteKey: string; onVerify: (token: string) => void; onCancel: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const submit = useCallback(() => {
    if (token) onVerify(token);
  }, [token, onVerify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && token) { e.preventDefault(); onVerify(token); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [token, onVerify, onCancel]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
        className="bg-white w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden">
        <div className="p-6 pb-4">
          <div className="flex items-center gap-3 mb-1">
            <div className="bg-blue-600 p-2 rounded-xl">
              <ShieldCheck className="text-white w-5 h-5" />
            </div>
            <div>
              <h3 className="font-black text-slate-900 text-lg">Security Check</h3>
              <p className="text-slate-500 text-xs">Verify you're human, then press Login</p>
            </div>
          </div>
        </div>
        <div className="flex justify-center px-6 pb-4 min-h-[78px]">
          <Suspense fallback={<div className="h-[78px] w-[304px] rounded-lg bg-slate-100 animate-pulse" />}>
            <ReCAPTCHA
              sitekey={siteKey}
              onChange={(t) => { setLoadError(false); setToken(t); }}
              onExpired={() => setToken(null)}
              onErrored={() => { setToken(null); setLoadError(true); }}
            />
          </Suspense>
        </div>
        {loadError && (
          <p className="px-6 pb-4 text-xs font-bold text-red-600 text-center">
            CAPTCHA domain/key is not allowed for this site. Add this domain in Google reCAPTCHA settings, then refresh.
          </p>
        )}

        <div className="flex border-t border-slate-100">
          <button onClick={onCancel}
            className="flex-1 py-4 text-sm font-bold text-slate-500 hover:bg-slate-50 transition-colors">
            Cancel
          </button>
          <div className="w-px bg-slate-100" />
          <button
            onClick={submit}
            disabled={!token}
            className="flex-1 py-4 text-sm font-bold text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent">
            Login
          </button>
        </div>

      </motion.div>
    </motion.div>
  );
}

// ==================== NETFLIX-STYLE PROFILE LOGIN ====================
function ProfileSelectPage() {
  const cachedBootstrap = useMemo(() => readBootstrapCache(), []);
  const cachedUsers = useMemo<UserData[]>(
    () => (cachedBootstrap?.users || []).filter((u: UserData) => u.role === "user"),
    [cachedBootstrap]
  );
  const [profiles, setProfiles] = useState<UserData[]>(cachedUsers);
  const [selectedProfile, setSelectedProfile] = useState<UserData | null>(null);
  const [password, setPassword] = useState("");
  // Only show a skeleton on cold visits (no cache at all).
  const [loading, setLoading] = useState(cachedUsers.length === 0);
  const [fromCache, setFromCache] = useState(cachedUsers.length > 0);
  const [loginLoading, setLoginLoading] = useState(false);
  const [error, setError] = useState("");
  const [siteKey, setSiteKey] = useState<string | null>(() => {
    const k = cachedBootstrap?.recaptcha?.enabled === true && cachedBootstrap?.recaptcha?.siteKey
      ? cachedBootstrap.recaptcha.siteKey
      : null;
    if (k) preloadRecaptchaScript();
    return k;
  });
  const [captchaReady, setCaptchaReady] = useState(false);
  const [captchaConfigError, setCaptchaConfigError] = useState(false);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const navigate = useNavigate();
  const { checkAuth } = useAuth();

  useEffect(() => {
    let cancelled = false;
    // Always fetch fresh on mount so after logout / avatar change the profile
    // grid reflects the latest data instead of the stale module singleton.
    bootstrapFromSupabase({ force: true })
      .then((bootstrap) => {
        if (cancelled) return;
        setProfiles((bootstrap.users || []).filter((u: UserData) => u.role === "user"));
        if (bootstrap.recaptcha?.enabled === true && bootstrap.recaptcha?.siteKey) {
          setSiteKey(bootstrap.recaptcha.siteKey);
          preloadRecaptchaScript();
        } else {
          setSiteKey(null);
        }
        setError("");
        setFromCache(false);
        setCaptchaReady(true);
        setCaptchaConfigError(false);
      })
      .catch((err) => {
        console.error("Failed to load profiles:", err);
        if (!cancelled) {
          setCaptchaConfigError(true);
          setCaptchaReady(false);
          if (profiles.length === 0) {
            setError("Failed to load profiles. Please try again.");
          } else {
            setError("Security check failed to load. Please refresh and try again.");
          }
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [profileSearch, setProfileSearch] = useState("");
  const displayProfiles = useMemo(() => {
    const list = profiles.map((profile) => ({ ...profile, profileAvatar: getStableProfileAvatar(profile) }));
    const q = profileSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) => (p.name || "").toLowerCase().includes(q) || (p.username || "").toLowerCase().includes(q));
  }, [profiles, profileSearch]);


  // Preload profile avatars into browser cache the instant profiles arrive.
  useEffect(() => {
    displayProfiles.forEach((p) => {
      const uri = getAvatarUri(p.profileAvatar);
      if (uri) { const img = new Image(); img.decoding = "sync"; img.src = uri; }
    });
  }, [displayProfiles]);



  const initiateLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!captchaReady) {
      setError(captchaConfigError ? "Security check failed to load. Please refresh and try again." : "Security check is loading. Please wait.");
      return;
    }
    if (siteKey) {
      setShowCaptcha(true);
    } else {
      void executeLogin();
    }
  };

  const executeLogin = async (captchaToken?: string) => {
    if (!selectedProfile) return;
    setLoginLoading(true);
    setError("");

    try {
      if (!checkRateLimit(`user_${selectedProfile.username}`)) {
        throw new Error("Too many attempts. Wait 1 minute.");
      }

      const clientGeo = await requireLoginLocation();
      const data: any = await apiCall("manage-app", {
        action: "login",
        username: selectedProfile.username,
        password,
        clientGeo,
        captchaToken,
      });

      if (data.workerUrls && Array.isArray(data.workerUrls) && data.workerUrls.length > 0) {
        storeWorkerUrls(data.workerUrls);
      }

      sessionSet("user" as any, JSON.stringify(data.user));
      // Session timer intentionally NOT started here — EmailViewer starts it
      // after the first cached-email load finishes so users always see their
      // inbox before the countdown begins.
      try { sessionRemove("session_started_at" as any); } catch {}
      checkAuth();

      navigate("/viewer");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoginLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#141414] flex flex-col items-center px-4 pt-10 sm:pt-14 pb-12 relative overflow-hidden">
      {/* Official Netflix wordmark + premium OTP badge (baseline-aligned) */}
      <div className="w-full max-w-6xl mx-auto flex items-center justify-start px-2 sm:px-6 absolute top-4 sm:top-6 left-1/2 -translate-x-1/2 z-20">
        <div className="relative inline-flex items-end gap-2 sm:gap-2.5 select-none">
          <svg
            viewBox="0 0 111 30"
            aria-label="Netflix"
            className="h-7 sm:h-9 w-auto block"
            style={{ filter: "drop-shadow(0 2px 10px rgba(229,9,20,0.45))" }}
          >
            <path
              fill="#E50914"
              d="M105.06233,14.2806261 L110.999156,30 C109.249227,29.7497422 107.500234,29.4366857 105.718437,29.1554972 L102.374168,20.4686475 L98.9371075,28.4375293 C97.2499766,28.1563408 95.5928391,28.061674 93.9057081,27.8432843 L99.9372012,14.0931671 L94.4680851,0 L99.5313525,0 L102.593495,7.87513723 L105.874965,0 L110.999156,0 L105.06233,14.2806261 Z M90.4686475,0 L85.8749649,0 L85.8749649,27.2499766 C87.3746368,27.3437061 88.9371075,27.4055675 90.4686475,27.5930265 L90.4686475,0 Z M81.9055207,26.93692 C77.7186241,26.6557316 73.5307901,26.4064111 69.250164,26.3117443 L69.250164,0 L73.9366389,0 L73.9366389,21.8745899 C76.6248008,21.9373887 79.3120255,22.1557784 81.9055207,22.2804387 L81.9055207,26.93692 Z M64.2496954,10.6561065 L64.2496954,15.3435186 L57.8442216,15.3435186 L57.8442216,25.9996251 L53.2186709,25.9996251 L53.2186709,0 L66.3436123,0 L66.3436123,4.68741213 L57.8442216,4.68741213 L57.8442216,10.6561065 L64.2496954,10.6561065 Z M45.3435186,4.68741213 L45.3435186,26.2498828 C43.7810479,26.2498828 42.1876465,26.2498828 40.6561065,26.3117443 L40.6561065,4.68741213 L35.8123454,4.68741213 L35.8123454,0 L50.2183897,0 L50.2183897,4.68741213 L45.3435186,4.68741213 Z M30.749836,15.5928391 C28.687787,15.5928391 26.2498828,15.5928391 24.4999531,15.6875059 L24.4999531,22.6562939 C27.2499766,22.4678976 30,22.2495079 32.7809542,22.1557784 L32.7809542,26.6557316 L19.812541,27.6876933 L19.812541,0 L32.7809542,0 L32.7809542,4.68741213 L24.4999531,4.68741213 L24.4999531,10.9991564 C26.3126816,10.9991564 29.0936358,10.9054269 30.749836,10.9054269 L30.749836,15.5928391 Z M4.78114163,12.9684132 L4.78114163,29.3429562 C3.09401084,29.5313525 1.59340144,29.7497422 0,30 L0,0 L4.4690224,0 L10.5623124,17.0315868 L10.5623124,0 L15.2497246,0 L15.2497246,28.061674 C13.5935889,28.3437998 11.906458,28.4375293 10.1246602,28.6868498 L4.78114163,12.9684132 Z"
            />
          </svg>
          {/* Premium OTP pill — baseline-aligned with the logo */}
          <span
            aria-label="OTP"
            className="relative inline-flex items-center gap-1.5 rounded-full pl-2 pr-2.5 sm:pl-2.5 sm:pr-3 py-[3px] sm:py-[4px] text-[10px] sm:text-[11px] font-bold tracking-[0.32em] uppercase whitespace-nowrap mb-[3px] sm:mb-[4px]"
            style={{
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 60%), #0b0b0b",
              border: "1px solid rgba(229,9,20,0.55)",
              color: "#ffe6e8",
              boxShadow:
                "0 0 0 1px rgba(0,0,0,0.6), 0 6px 18px -8px rgba(229,9,20,0.75), inset 0 0 12px rgba(229,9,20,0.18)",
              textShadow: "0 0 8px rgba(229,9,20,0.5)",
            }}
          >
            <span
              className="w-[5px] h-[5px] rounded-full bg-[#e50914] animate-pulse"
              style={{ boxShadow: "0 0 6px #e50914, 0 0 12px rgba(229,9,20,0.85)" }}
            />
            OTP
          </span>
        </div>
      </div>


      <AnimatePresence mode="wait">
        {!selectedProfile ? (
          <motion.div
            key="profiles"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="relative z-10 w-full max-w-6xl flex flex-col items-center mt-14 sm:mt-20"
          >
            <motion.h1
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="text-white text-center font-normal tracking-tight text-[32px] sm:text-[56px] leading-[1.1] mb-8 sm:mb-12"
              style={{ fontFamily: '"Netflix Sans","Helvetica Neue",Arial,sans-serif', fontWeight: 400 }}
            >
              Who's watching?
            </motion.h1>

            {profiles.length > 6 && (
              <div className="relative mb-6 sm:mb-8 w-full max-w-md px-2">
                <Search className="absolute left-6 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500 pointer-events-none" />
                <input
                  type="text"
                  value={profileSearch}
                  onChange={(e) => setProfileSearch(e.target.value)}
                  placeholder="Search profiles"
                  aria-label="Search profiles"
                  className="w-full bg-[#1f1f1f] border border-neutral-800 text-white text-sm rounded-md pl-10 pr-10 py-2.5 outline-none focus:border-neutral-500 placeholder:text-neutral-500"
                />
                {profileSearch && (
                  <button
                    onClick={() => setProfileSearch("")}
                    aria-label="Clear profile search"
                    className="absolute right-5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white p-1"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            )}

            {displayProfiles.length === 0 ? (
              loading ? (
                <div className="w-full max-w-5xl mx-auto rounded-2xl border border-white/[0.06] bg-white/[0.015] p-3 sm:p-5">
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-x-4 gap-y-7 sm:gap-x-6 sm:gap-y-9 mx-auto pb-4">
                    {Array.from({ length: 10 }).map((_, i) => (
                      <div key={i} className="flex flex-col items-center gap-2 sm:gap-3 min-w-0" style={{ animationDelay: `${i * 60}ms` }}>
                        <div className="relative rounded-md overflow-hidden aspect-square w-full max-w-[140px] bg-white/[0.04] profile-skeleton" />
                        <div className="h-3 w-16 rounded bg-white/[0.05] profile-skeleton" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center py-16">
                  <p className="text-neutral-500 text-sm">
                    {profileSearch ? `No profiles match "${profileSearch}"` : "No profiles yet. Ask admin to create users."}
                  </p>
                </div>
              )
            ) : (
              <div className="w-full max-w-5xl mx-auto rounded-2xl border border-white/[0.06] bg-white/[0.015] p-3 sm:p-5 profile-grid-enter">
                <div
                  className="w-full overflow-y-scroll overscroll-contain pr-2 sm:pr-3 py-2 sm:py-3 max-h-[58vh] sm:max-h-[62vh] scroll-smooth [scrollbar-width:thin] [scrollbar-color:#e50914_rgba(255,255,255,0.04)] [&::-webkit-scrollbar]:w-[10px] [&::-webkit-scrollbar-track]:bg-white/[0.03] [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gradient-to-b [&::-webkit-scrollbar-thumb]:from-[#e50914] [&::-webkit-scrollbar-thumb]:to-[#7a0006] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb:hover]:from-[#ff1a25] [&::-webkit-scrollbar-thumb:hover]:to-[#a30009]"
                >
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-x-4 gap-y-7 sm:gap-x-6 sm:gap-y-9 mx-auto pb-4">
                    {displayProfiles.map((profile, i) => {
                      const d = `${Math.min(i, 30) * 75}ms`;
                      return (
                      <button
                        key={profile.id}
                        type="button"
                        onClick={() => setSelectedProfile(profile)}
                        className="flex flex-col items-center gap-2 sm:gap-3 group focus:outline-none min-w-0 profile-item-in"
                        style={{ animationDelay: d, ["--tile-delay" as any]: d }}
                      >
                        <div className="relative rounded-md overflow-hidden ring-0 group-hover:ring-2 group-hover:ring-white aspect-square w-full max-w-[140px] transform-gpu transition-transform duration-150 ease-out group-hover:scale-105 group-active:scale-95 will-change-transform">
                          <ProfileAvatar
                            avatarId={profile.profileAvatar}
                            name={profile.name}
                            className="w-full h-full"
                            fallbackColor={PROFILE_COLORS[i % PROFILE_COLORS.length]}
                            eager
                          />
                        </div>
                        <span className="text-neutral-400 group-hover:text-white text-[12px] sm:text-[14px] font-normal transition-colors duration-150 truncate max-w-full text-center">
                          {profile.name}
                        </span>
                      </button>
                      );
                    })}
                  </div>
                </div>
              </div>

            )}

          </motion.div>
        ) : (
          <motion.div key="password" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
            className="relative z-10 w-full max-w-sm px-2 mt-16 sm:mt-24">
            <button onClick={() => { setSelectedProfile(null); setPassword(""); setError(""); }}
              className="text-neutral-400 hover:text-white text-sm font-normal mb-8 flex items-center gap-1.5 transition-colors group">
              <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" /> Back
            </button>

            <div className="flex flex-col items-center mb-8">
              <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 220 }}
                className="mb-5 rounded-md overflow-hidden ring-1 ring-white/10">
                <ProfileAvatar avatarId={getStableProfileAvatar(selectedProfile)} name={selectedProfile.name} className="w-24 h-24 sm:w-28 sm:h-28" fallbackColor={PROFILE_COLORS[Math.max(0, profiles.findIndex((p) => p.id === selectedProfile.id)) % PROFILE_COLORS.length]} eager />
              </motion.div>
              <h2 className="text-2xl sm:text-3xl font-normal text-white tracking-tight" style={{ fontFamily: '"Netflix Sans","Helvetica Neue",Arial,sans-serif' }}>{selectedProfile.name}</h2>
              <p className="text-neutral-500 text-xs sm:text-sm mt-1">@{selectedProfile.username}</p>
            </div>

            <form onSubmit={initiateLogin} className="space-y-4">
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-500 w-4 h-4 z-10" />
                <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-[#1f1f1f] border border-neutral-800 text-white rounded-md py-3.5 pl-11 pr-12 focus:border-neutral-500 transition-all outline-none placeholder:text-neutral-500 text-sm"
                  placeholder="Password" autoFocus required />
              </div>

              {error && (
                <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }}
                  className="bg-[#e50914]/10 border border-[#e50914]/30 text-[#f5c9cc] text-xs p-3 rounded-md flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
                </motion.div>
              )}

              <button type="submit" disabled={loginLoading}
                className="w-full bg-[#e50914] hover:bg-[#f6121d] text-white font-semibold py-3 rounded-md transition-all active:scale-[0.98] disabled:opacity-50 text-[15px]">
                {loginLoading ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Verifying...
                  </span>
                ) : "Sign In"}
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showCaptcha && siteKey && (
          <CaptchaModal siteKey={siteKey} onVerify={(token) => { setShowCaptcha(false); executeLogin(token); }} onCancel={() => setShowCaptcha(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}

// ==================== ADMIN LOGIN ====================
function AdminLoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const cachedBootstrap = useMemo(() => readBootstrapCache(), []);
  const [siteKey, setSiteKey] = useState<string | null>(() => {
    const k = cachedBootstrap?.recaptcha?.enabled === true && cachedBootstrap?.recaptcha?.siteKey
      ? cachedBootstrap.recaptcha.siteKey
      : null;
    if (k) preloadRecaptchaScript();
    return k;
  });
  const [captchaReady, setCaptchaReady] = useState(false);
  const [captchaConfigError, setCaptchaConfigError] = useState(false);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const navigate = useNavigate();
  const { checkAuth } = useAuth();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bootstrap = await bootstrapFromSupabase({ force: true });
        if (cancelled) return;
        if (bootstrap.recaptcha?.enabled === true && bootstrap.recaptcha?.siteKey) {
          setSiteKey(bootstrap.recaptcha.siteKey);
          preloadRecaptchaScript();
        } else {
          setSiteKey(null);
        }
        setCaptchaReady(true);
        setCaptchaConfigError(false);
      } catch {
        if (!cancelled) {
          setCaptchaReady(false);
          setCaptchaConfigError(true);
          setError("Security check failed to load. Please refresh and try again.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const initiateLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!captchaReady) {
      setError(captchaConfigError ? "Security check failed to load. Please refresh and try again." : "Security check is loading. Please wait.");
      return;
    }
    if (siteKey) {
      setShowCaptcha(true);
    } else {
      void executeLogin();
    }
  };

  const executeLogin = async (captchaToken?: string) => {
    setLoading(true);
    setError("");
    try {
      if (!checkRateLimit(`admin_${username}`)) throw new Error("Too many attempts. Wait 1 minute.");

      const clientGeo = await requireLoginLocation();
      const data: any = await apiCall("manage-app", { action: "login", username, password, clientGeo, captchaToken });

      if (data.user.role !== "admin") throw new Error("Access denied");
      if (data.pendingToken) {
        sessionSet("pending_admin_token" as any, data.pendingToken);
        sessionSet("pending_admin_token_at" as any, String(Date.now()));
      }

      if (data.workerUrls && Array.isArray(data.workerUrls) && data.workerUrls.length > 0) {
        storeWorkerUrls(data.workerUrls);
      }

      sessionSet("user" as any, JSON.stringify({ ...data.user, pending: true }));
      checkAuth();

      toast.success("Password verified. Complete 2FA to enter admin.");
      navigate("/admin-auth");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };


  return (
    <div className="min-h-[100dvh] bg-slate-900 flex items-center justify-center px-4 py-6 pt-[calc(env(safe-area-inset-top)+1rem)]">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        className="bg-white w-full max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-8 shadow-2xl border-t-4 sm:border-t-8 border-red-600 mx-2 sm:mx-0">
        <div className="flex justify-center mb-8">
          <div className="bg-slate-900 p-3 sm:p-4 rounded-2xl shadow-lg">
            <ShieldCheck className="text-white w-6 h-6 sm:w-8 sm:h-8" />
          </div>
        </div>
        <h2 className="text-xl sm:text-2xl font-black text-center text-slate-900 mb-1 sm:mb-2">Admin Access</h2>
        <p className="text-slate-500 text-center text-xs sm:text-sm mb-4 sm:mb-8">Secure administrator login</p>

        <form onSubmit={initiateLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Admin Username</label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-4 text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-red-500 transition-all outline-none"
                placeholder="admin" required autoComplete="username" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Admin Password</label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5 z-10" />
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-12 text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-red-500 transition-all outline-none"
                placeholder="••••••••" required />
            </div>
          </div>
          {error && (
            <div className="bg-red-50 text-red-600 text-xs p-3 rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />{error}
            </div>
          )}
          <button type="submit" disabled={loading || !captchaReady}
            className="w-full bg-red-600 text-white font-bold py-4 rounded-2xl hover:bg-red-700 transition-all active:scale-95 disabled:opacity-50">
            {loading ? "Authenticating..." : captchaReady ? "Admin Sign In" : "Loading Security..."}
          </button>
        </form>

        <div className="flex flex-col gap-2 mt-6">
          <button onClick={() => navigate("/")}
            className="text-slate-400 text-[10px] font-bold uppercase tracking-widest hover:text-slate-900 transition-colors mt-2">
            Back to User Login
          </button>
        </div>
      </motion.div>

      <AnimatePresence>
        {showCaptcha && siteKey && (
          <CaptchaModal siteKey={siteKey} onVerify={(token) => { setShowCaptcha(false); executeLogin(token); }} onCancel={() => setShowCaptcha(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}

// ==================== ADMIN 2FA ====================
function AdminAuthPage() {
  const [step, setStep] = useState(1);
  const [otp, setOtp] = useState("");
  const [totp, setTotp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const otpRequested = React.useRef(false);
  const { user } = useAuth();
  const PROOF_TTL_MS = 15 * 60 * 1000;
  const [remainingMs, setRemainingMs] = useState<number>(() => {
    const at = Number(sessionGet("pending_admin_token_at" as any) || 0);
    if (!at) return PROOF_TTL_MS;
    return Math.max(0, PROOF_TTL_MS - (Date.now() - at));
  });
  useEffect(() => {
    const t = setInterval(() => {
      const at = Number(sessionGet("pending_admin_token_at" as any) || 0);
      const left = at ? Math.max(0, PROOF_TTL_MS - (Date.now() - at)) : 0;
      setRemainingMs(left);
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const expired = remainingMs <= 0;
  const mm = String(Math.floor(remainingMs / 60000)).padStart(2, "0");
  const ss = String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, "0");
  const restartLogin = () => {
    try {
      sessionRemove("pending_admin_token" as any);
      sessionRemove("pending_admin_token_at" as any);
      sessionRemove("user" as any);
    } catch {}
    navigate("/admin", { replace: true });
  };

  useEffect(() => {
    const pending = (() => { try { return sessionGet("pending_admin_token" as any); } catch { return null; } })();
    if (!pending) { navigate("/admin", { replace: true }); return; }
    if (!user || user.role !== "admin") { navigate("/admin", { replace: true }); return; }


    if (step === 1 && !otpRequested.current) {
      otpRequested.current = true;
      setLoading(true);
      (async () => {
        try {
          await apiCall("manage-app", { action: "request_admin_otp", user_id: user.id });
          toast.success("Secure OTP sent to your Telegram.");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to send OTP";
          setError(msg);
          toast.error(msg);
          otpRequested.current = false;
        } finally {
          setLoading(false);
        }
      })();
    }

    if (step === 2 && !user.totpSecret) {
      (async () => {
        try {
          if (user.totpConfigured) return;
          const res = await apiCall("manage-app", { action: "update_totp", user_id: user.id });
          if (res.secret) setSecretKey(res.secret);
          if (res.otpauthUrl) setQrCode(res.otpauthUrl);
        } catch (err) {
          console.error("TOTP setup error:", err);
          toast.error(err instanceof Error ? err.message : "Could not start authenticator setup");
        }
      })();
    }
  }, [step, user]);

  const verifyTelegramOtp = async (submittedOtp = otp) => {
    const code = submittedOtp.trim();
    if (loading) return;
    if (!user?.id) {
      navigate("/admin", { replace: true });
      return;
    }
    if (code.length < 6) {
      setError("Enter the 6-digit Telegram OTP.");
      return;
    }
    setLoading(true);
    try {
      await apiCall("manage-app", { action: "verify_otp", user_id: user.id, otp: code });
      setStep(2);
      setError("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid OTP";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const verifyTotp = async (submittedTotp = totp) => {
    const code = submittedTotp.trim();
    if (loading) return;
    if (!user?.id) {
      navigate("/admin", { replace: true });
      return;
    }
    if (code.length < 6) {
      setError("Enter the 6-digit authenticator code.");
      return;
    }
    setLoading(true);
    try {
      await apiCall("manage-app", { action: "verify_totp", user_id: user.id, code });
      const finalData = await apiCall("manage-app", { action: "finalize_admin_session", user_id: user.id });
      if (finalData.workerUrls && Array.isArray(finalData.workerUrls) && finalData.workerUrls.length > 0) {
        storeWorkerUrls(finalData.workerUrls);
      }
      if (finalData.sessionToken) sessionSet("session_token" as any, finalData.sessionToken);
      sessionRemove("pending_admin_token" as any);
      sessionSet("admin_auth" as any, "true");
      sessionSet("user" as any, JSON.stringify(finalData.user));
      markSessionStart();
      toast.success("Admin session secured.");
      navigate("/admin/dashboard");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid Google Auth Code";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleTelegramOtpSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const formOtp = new FormData(e.currentTarget).get("telegramOtp")?.toString() ?? otp;
    const normalizedOtp = formOtp.replace(/\D/g, "").slice(0, 6);
    if (normalizedOtp !== otp) setOtp(normalizedOtp);
    void verifyTelegramOtp(normalizedOtp);
  };

  const handleTotpSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const formTotp = new FormData(e.currentTarget).get("totpCode")?.toString() ?? totp;
    const normalizedTotp = formTotp.replace(/\D/g, "").slice(0, 6);
    if (normalizedTotp !== totp) setTotp(normalizedTotp);
    void verifyTotp(normalizedTotp);
  };

  const handleOtpInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    const normalizedOtp = e.currentTarget.value.replace(/\D/g, "").slice(0, 6);
    if (normalizedOtp !== otp) setOtp(normalizedOtp);
    void verifyTelegramOtp(normalizedOtp);
  };

  const handleTotpInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    const normalizedTotp = e.currentTarget.value.replace(/\D/g, "").slice(0, 6);
    if (normalizedTotp !== totp) setTotp(normalizedTotp);
    void verifyTotp(normalizedTotp);
  };

  return (
    <div className="min-h-[100dvh] bg-slate-950 flex items-center justify-center px-4 py-6 pt-[calc(env(safe-area-inset-top)+1rem)] relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:14px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-red-600/20 blur-[120px] rounded-full pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-slate-900/80 backdrop-blur-xl border border-slate-700/50 max-w-md w-full rounded-3xl p-6 sm:p-8 shadow-[0_0_40px_rgba(220,38,38,0.1)] relative z-10"
      >
        <div className="flex justify-center mb-6">
          <div className="bg-red-500/10 p-4 rounded-2xl border border-red-500/20">
            <ShieldCheck className="w-10 h-10 text-red-500" />
          </div>
        </div>

        <h2 className="text-2xl font-black text-center text-white tracking-tight mb-2">3-Factor Auth</h2>
        <p className="text-slate-400 text-center text-sm mb-3">
          {step === 1 ? "OTP sent to Telegram" : "Enter Google Authenticator code"}
        </p>
        <div className="flex justify-center mb-6">
          {expired ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1 rounded-full bg-red-500/15 border border-red-500/30 text-red-400 uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> Session expired
            </span>
          ) : (
            <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1 rounded-full border uppercase tracking-wider ${remainingMs < 60_000 ? "bg-amber-500/10 border-amber-500/30 text-amber-400" : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${remainingMs < 60_000 ? "bg-amber-400" : "bg-emerald-400"} animate-pulse`} /> Expires in {mm}:{ss}
            </span>
          )}
        </div>
        {expired && (
          <button type="button" onClick={restartLogin}
            className="w-full mb-6 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white font-semibold py-3 rounded-2xl transition-colors">
            Restart login
          </button>
        )}


        {step === 1 ? (
          <form onSubmit={handleTelegramOtpSubmit} className="space-y-6" noValidate>
            <input name="telegramOtp" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} onKeyDown={handleOtpInputKeyDown}
              className="w-full bg-slate-950 border border-slate-800 text-white text-center tracking-[0.75em] font-mono text-2xl rounded-2xl py-5 focus:ring-2 focus:ring-red-500 outline-none placeholder:tracking-normal placeholder:text-sm placeholder:text-slate-600"
              placeholder="••••••" maxLength={6} />
            <button type="submit" disabled={loading}
              className="w-full bg-gradient-to-r from-red-600 to-red-700 text-white font-bold py-4 rounded-2xl hover:from-red-500 hover:to-red-600 shadow-lg shadow-red-900/20 transition-all active:scale-[0.98] disabled:opacity-50">
              {loading ? "Verifying..." : "Verify Telegram OTP"}
            </button>
            {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-4 rounded-xl text-center">{error}</div>}
          </form>
        ) : (
          <form onSubmit={handleTotpSubmit} className="space-y-6" noValidate>
            {qrCode && (
              <div className="flex flex-col items-center bg-slate-950 p-6 rounded-2xl border border-slate-800">
                <p className="text-xs font-bold text-slate-400 uppercase mb-4">Scan with Google Authenticator</p>
                <div className="bg-white p-2 rounded-xl">
                  <Suspense fallback={<div className="w-[160px] h-[160px] bg-slate-100 animate-pulse rounded-md" />}>
                    <QRCodeSVG value={qrCode} size={160} />
                  </Suspense>
                </div>

                <div className="mt-4 w-full">
                  <p className="text-xs text-slate-500 text-center mb-2">Or enter this key manually:</p>
                  <div className="flex items-center justify-between bg-slate-900 border border-slate-700 rounded-xl p-3">
                    <code className="text-sm font-mono text-slate-300 tracking-wider truncate">{secretKey}</code>
                    <button type="button" onClick={() => { navigator.clipboard.writeText(secretKey); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      className="text-slate-400 hover:text-white transition-colors flex-shrink-0 ml-2">
                      {copied ? <CheckCircle2 className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <input name="totpCode" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} onKeyDown={handleTotpInputKeyDown}
              className="w-full bg-slate-950 border border-slate-800 text-white text-center tracking-[0.75em] font-mono text-2xl rounded-2xl py-5 focus:ring-2 focus:ring-red-500 outline-none placeholder:tracking-normal placeholder:text-sm placeholder:text-slate-600"
              placeholder="••••••" maxLength={6} />
            <button type="submit" disabled={loading}
              className="w-full bg-gradient-to-r from-red-600 to-red-700 text-white font-bold py-4 rounded-2xl hover:from-red-500 hover:to-red-600 shadow-lg shadow-red-900/20 transition-all active:scale-[0.98] disabled:opacity-50">
              {loading ? "Verifying..." : "Verify & Enter Admin"}
            </button>
            {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-4 rounded-xl text-center">{error}</div>}
          </form>
        )}
      </motion.div>
    </div>
  );
}

// ==================== ADMIN PANEL ====================
function LoginEventsPanel() {
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res: any = await apiCall("manage-app", { action: "list_login_events", limit: 300, search: search || undefined });

      setEvents(res?.events || []);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load login events");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const exportCsv = () => {
    if (!events.length) return;
    const cols = ["created_at","username","role","event","risk_score","ip","isp","country","city","device_brand","device_model","device_type","os_name","os_version","browser_name","browser_version","gps_lat","gps_lon","gps_accuracy","is_vpn","is_proxy","is_tor","is_hosting","is_new_device","impossible_travel","fingerprint_hash"];
    const rows = [cols.join(",")].concat(events.map(e => cols.map(c => JSON.stringify(e?.[c] ?? "")).join(",")));
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `login_events_${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `login_events_${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <section className="bg-white p-3 sm:p-6 rounded-2xl border shadow-sm">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h2 className="font-black text-base sm:text-lg flex items-center gap-2 mr-auto">
          <div className="bg-red-50 p-1.5 rounded-lg"><ShieldCheck className="w-4 h-4 text-red-600" /></div>
          Login Events <span className="text-xs font-normal text-slate-500">({events.length})</span>
        </h2>
        <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === "Enter" && load()}
          placeholder="Search user/IP/city/ISP…" aria-label="Search login events" className="border rounded-lg px-3 py-1.5 text-sm w-full sm:w-48" />
        <button onClick={load} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-semibold">Refresh</button>
        <button onClick={exportCsv} className="px-3 py-1.5 bg-slate-900 text-white hover:bg-slate-800 rounded-lg text-sm font-semibold">CSV</button>
        <button onClick={exportJson} className="px-3 py-1.5 bg-slate-700 text-white hover:bg-slate-800 rounded-lg text-sm font-semibold">JSON</button>
      </div>
      {loading ? (
        <div className="py-12 text-center text-slate-500 text-sm">Loading…</div>
      ) : events.length === 0 ? (
        <div className="py-12 text-center text-slate-500 text-sm">No login events yet.</div>
      ) : (
        <>
          {/* Desktop / tablet table */}
          <div className="hidden md:block overflow-auto border rounded-lg max-h-[65vh]">
            <table className="w-full text-xs sm:text-sm min-w-[820px]">
              <thead className="bg-slate-50 text-left text-slate-600 uppercase text-[10px] tracking-wider sticky top-0 z-10">
                <tr>
                  <th className="p-2">Time</th><th className="p-2">User</th>
                  <th className="p-2">Device</th><th className="p-2">Browser · OS</th>
                  <th className="p-2">IP</th><th className="p-2">ISP</th><th className="p-2">Location</th>
                  <th className="p-2">Flags</th><th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {events.map(e => (
                  <React.Fragment key={e.id}>
                    <tr className="hover:bg-slate-50">
                      <td className="p-2 whitespace-nowrap text-slate-600">{new Date(e.created_at).toLocaleString()}</td>
                      <td className="p-2 font-semibold">{e.username}<div className="text-[10px] text-slate-400">{e.role}</div>{e.is_new_device && <div className="text-[10px] text-orange-600 mt-1">🆕 new device</div>}</td>
                      <td className="p-2">{[e.device_brand, e.device_model].filter(Boolean).join(" ") || "—"}<div className="text-[10px] text-slate-400">{e.device_type}</div></td>
                      <td className="p-2">{e.browser_name} {e.browser_version?.split(".")[0]}<div className="text-[10px] text-slate-400">{e.os_name} {e.os_version}</div></td>
                      <td className="p-2 font-mono text-[11px]">{e.ip || "—"}<div className="text-[10px] text-slate-400">{e.ip_source}</div></td>
                      <td className="p-2">{e.isp || "—"}<div className="text-[10px] text-slate-400">{e.asn}</div></td>
                      <td className="p-2">{[e.city, e.region, e.country_code].filter(Boolean).join(", ") || "—"}{typeof e.gps_lat === "number" && <div className="text-[10px] text-emerald-600">GPS ±{Math.round(e.gps_accuracy || 0)}m</div>}</td>
                      <td className="p-2 space-x-1">
                        {e.is_vpn && <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px]">VPN</span>}
                        {e.is_proxy && <span className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 text-[10px]">PROXY</span>}
                        {e.is_tor && <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-[10px]">TOR</span>}
                        {e.is_hosting && <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 text-[10px]">HOST</span>}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {(typeof e.gps_lat === "number" || typeof e.ip_lat === "number") && (
                          <a target="_blank" rel="noreferrer" href={`https://maps.google.com/?q=${e.gps_lat ?? e.ip_lat},${e.gps_lon ?? e.ip_lon}`} className="text-blue-600 hover:underline text-[11px] mr-2">Map</a>
                        )}
                        {e.ip && <button onClick={() => { navigator.clipboard.writeText(e.ip); toast.success("IP copied"); }} className="text-slate-600 hover:underline text-[11px] mr-2">Copy IP</button>}
                        <button onClick={() => setExpanded(expanded === e.id ? null : e.id)} className="text-slate-600 hover:underline text-[11px]">{expanded === e.id ? "Hide" : "Raw"}</button>
                      </td>
                    </tr>
                    {expanded === e.id && (
                      <tr><td colSpan={9} className="p-2 bg-slate-50"><pre className="text-[10px] overflow-x-auto max-h-96">{JSON.stringify(e, null, 2)}</pre></td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card list — no horizontal scroll */}
          <div className="md:hidden space-y-3 max-h-[65vh] overflow-y-auto pr-1">
            {events.map(e => {
              const isOpen = expanded === e.id;
              const flags: { label: string; cls: string }[] = [];
              if (e.is_vpn) flags.push({ label: "VPN", cls: "bg-red-100 text-red-700" });
              if (e.is_proxy) flags.push({ label: "PROXY", cls: "bg-orange-100 text-orange-700" });
              if (e.is_tor) flags.push({ label: "TOR", cls: "bg-purple-100 text-purple-700" });
              if (e.is_hosting) flags.push({ label: "HOST", cls: "bg-slate-200 text-slate-700" });
              return (
                <div key={e.id} className="border rounded-xl p-3 bg-white shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-sm text-slate-900 truncate">{e.username}</p>
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">{e.role}</p>
                    </div>
                    <p className="text-[10px] text-slate-500 whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</p>
                  </div>

                  {e.is_new_device && <p className="text-[10px] text-orange-600 mt-1">🆕 new device</p>}

                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                    <div>
                      <p className="text-slate-400 text-[9px] uppercase tracking-wider">Device</p>
                      <p className="text-slate-700 truncate">{[e.device_brand, e.device_model].filter(Boolean).join(" ") || "—"}</p>
                      <p className="text-slate-400 text-[10px]">{e.device_type}</p>
                    </div>
                    <div>
                      <p className="text-slate-400 text-[9px] uppercase tracking-wider">Browser · OS</p>
                      <p className="text-slate-700 truncate">{e.browser_name} {e.browser_version?.split(".")[0]}</p>
                      <p className="text-slate-400 text-[10px] truncate">{e.os_name} {e.os_version}</p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-slate-400 text-[9px] uppercase tracking-wider">IP · ISP</p>
                      <p className="font-mono text-[11px] text-slate-700 break-all">{e.ip || "—"}</p>
                      <p className="text-slate-500 text-[10px] truncate">{e.isp || "—"} {e.asn ? `· ${e.asn}` : ""}</p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-slate-400 text-[9px] uppercase tracking-wider">Location</p>
                      <p className="text-slate-700 text-[11px]">{[e.city, e.region, e.country_code].filter(Boolean).join(", ") || "—"}</p>
                      {typeof e.gps_lat === "number" && (
                        <p className="text-emerald-600 text-[10px]">GPS ±{Math.round(e.gps_accuracy || 0)}m</p>
                      )}
                    </div>
                  </div>

                  {flags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {flags.map(f => (
                        <span key={f.label} className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${f.cls}`}>{f.label}</span>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2 pt-2 border-t">
                    {(typeof e.gps_lat === "number" || typeof e.ip_lat === "number") && (
                      <a target="_blank" rel="noreferrer" href={`https://maps.google.com/?q=${e.gps_lat ?? e.ip_lat},${e.gps_lon ?? e.ip_lon}`}
                        className="text-blue-600 hover:underline text-[11px] font-semibold">Map</a>
                    )}
                    {e.ip && <button onClick={() => { navigator.clipboard.writeText(e.ip); toast.success("IP copied"); }} className="text-slate-600 hover:underline text-[11px] font-semibold">Copy IP</button>}
                    <button onClick={() => setExpanded(isOpen ? null : e.id)} className="text-slate-600 hover:underline text-[11px] font-semibold ml-auto">{isOpen ? "Hide raw" : "Raw"}</button>
                  </div>

                  {isOpen && (
                    <pre className="mt-2 text-[9px] leading-tight bg-slate-50 rounded-lg p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">{JSON.stringify(e, null, 2)}</pre>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}


// ==================== ADMIN: ALL EMAILS (across every user/account) ====================
function AllEmailsPanel() {
  const [emails, setEmails] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<any | null>(null);
  const [offset, setOffset] = useState(0);
  const limit = 100;


  const load = useCallback(async (nextOffset = 0) => {
    setLoading(true);
    try {
      const res: any = await apiCall("manage-app", {
        action: "admin_list_emails",
        limit, offset: nextOffset,
        search: search || undefined,
        accountLabel: accountLabel || undefined,
      });
      setEmails(res?.emails || []);
      setTotal(res?.total || 0);
      setOffset(nextOffset);
      setSelected(new Set());
    } catch (e: any) {
      toast.error(e?.message || "Failed to load emails");
    } finally { setLoading(false); }
  }, [search, accountLabel]);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiCall("manage-app", { action: "get_settings", key: "email_accounts" });
        if (Array.isArray(data?.value)) setLabels(data.value.map((a: any) => a.label || a.user).filter(Boolean));
      } catch {}
    })();
    load(0);

    // eslint-disable-next-line
  }, [load]);


  const openEmail = async (id: string) => {
    try {
      const res: any = await apiCall("manage-app", { action: "admin_get_email", id });
      setViewing(res?.email || null);
    } catch (e: any) { toast.error(e?.message || "Failed to open"); }
  };

  const deleteIds = async (ids: string[]) => {
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} email${ids.length === 1 ? "" : "s"} from the database? This removes them for every user and cannot be undone.`)) return;
    try {
      const res: any = await apiCall("manage-app", { action: "admin_delete_emails", ids });
      toast.success(`Deleted ${res?.deleted ?? ids.length} email${(res?.deleted ?? ids.length) === 1 ? "" : "s"}`);
      if (viewing && ids.includes(viewing.id)) setViewing(null);
      await load(offset);
    } catch (e: any) { toast.error(e?.message || "Delete failed"); }
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };
  const toggleAll = () => {
    if (selected.size === emails.length) setSelected(new Set());
    else setSelected(new Set(emails.map(e => e.id)));
  };

  return (
    <section className="bg-white p-4 sm:p-6 rounded-2xl border shadow-sm">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h2 className="font-black text-base sm:text-lg flex items-center gap-2 mr-auto">
          <div className="bg-red-50 p-1.5 rounded-lg"><Mail className="w-4 h-4 text-red-600" /></div>
          All Emails <span className="text-xs font-normal text-slate-500">({total})</span>
        </h2>
        <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === "Enter" && load(0)}
          placeholder="Search subject / from / to / OTP…" aria-label="Search all emails" className="border rounded-lg px-3 py-1.5 text-sm w-56 text-slate-900" />
        <select value={accountLabel} onChange={e => setAccountLabel(e.target.value)} className="border rounded-lg px-2 py-1.5 text-sm text-slate-900">
          <option value="">All accounts</option>
          {labels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <button onClick={() => load(0)} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-semibold">Search</button>
        {selected.size > 0 && (
          <button onClick={() => deleteIds(Array.from(selected))} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold flex items-center gap-1">
            <Trash2 className="w-3.5 h-3.5" /> Delete {selected.size}
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-12 text-center text-slate-500 text-sm">Loading…</div>
      ) : emails.length === 0 ? (
        <div className="py-12 text-center text-slate-500 text-sm">No emails found.</div>
      ) : (
        <>
          <div className="overflow-auto border rounded-lg max-h-[65vh]">
            <table className="w-full text-xs sm:text-sm min-w-[800px]">
              <thead className="bg-slate-50 text-left text-slate-600 uppercase text-[10px] tracking-wider sticky top-0 z-10">
                <tr>
                  <th className="p-2 w-8"><input type="checkbox" checked={selected.size === emails.length && emails.length > 0} onChange={toggleAll} /></th>
                  <th className="p-2">Date</th><th className="p-2">Account</th><th className="p-2">From</th>
                  <th className="p-2">Subject</th><th className="p-2">OTP</th><th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {emails.map(e => (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="p-2"><input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} /></td>
                    <td className="p-2 whitespace-nowrap text-slate-600">{e.date ? new Date(e.date).toLocaleString() : "—"}</td>
                    <td className="p-2 text-slate-700">{e.account_label || "—"}</td>
                    <td className="p-2 text-slate-700 truncate max-w-[220px]" title={e.from_address}>{e.from_address || "—"}</td>
                    <td className="p-2 text-slate-900 font-medium truncate max-w-[300px]" title={e.subject}>{e.subject || "(no subject)"}</td>
                    <td className="p-2 font-mono text-[11px]">{e.otp || "—"}</td>
                    <td className="p-2 whitespace-nowrap">
                      <button onClick={() => openEmail(e.id)} className="text-blue-600 hover:underline text-[11px] mr-3">View</button>
                      <button onClick={() => deleteIds([e.id])} className="text-red-600 hover:underline text-[11px]">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between mt-3 text-xs text-slate-600">
            <span>Showing {offset + 1}–{Math.min(offset + emails.length, total)} of {total}</span>
            <div className="flex gap-2">
              <button disabled={offset === 0} onClick={() => load(Math.max(0, offset - limit))} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg font-semibold disabled:opacity-40">Prev</button>
              <button disabled={offset + limit >= total} onClick={() => load(offset + limit)} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg font-semibold disabled:opacity-40">Next</button>
            </div>
          </div>
        </>
      )}

      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3 sm:p-6" onClick={() => setViewing(null)}>
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-wider text-slate-500">{viewing.account_label || "—"} · {viewing.date ? new Date(viewing.date).toLocaleString() : "—"}</p>
                <h3 className="font-black text-lg text-slate-900 truncate">{viewing.subject || "(no subject)"}</h3>
                <p className="text-xs text-slate-600 truncate">From: {viewing.from_address}</p>
                <p className="text-xs text-slate-600 truncate">To: {viewing.to_address}</p>
                {viewing.otp && <p className="text-xs mt-1"><span className="font-mono bg-amber-100 text-amber-800 px-2 py-0.5 rounded">OTP: {viewing.otp}</span></p>}
              </div>
              <button onClick={() => deleteIds([viewing.id])} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> Delete</button>
              <button onClick={() => setViewing(null)} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
            </div>
            <div className="p-4 overflow-auto flex-1">
              {viewing.html ? (
                <iframe title="email" srcDoc={`<!DOCTYPE html><html><head><base target="_blank"></head><body>${viewing.html}<script>(function(){function force(a){try{a.setAttribute('target','_blank');a.setAttribute('rel','noopener noreferrer');}catch(e){}}function scan(){document.querySelectorAll('a,button').forEach(force);}document.addEventListener('click',function(e){var a=e.target.closest('a,button');if(!a)return;var h=a.getAttribute('href')||a.dataset.href;if(h){e.preventDefault();window.open(h,'_blank','noopener,noreferrer');}},true);scan();try{new MutationObserver(scan).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['href','target']});}catch(e){}})();<\/script></body></html>`} className="w-full min-h-[400px] border rounded" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-scripts" />
              ) : (
                <pre className="text-xs whitespace-pre-wrap text-slate-700">{viewing.preview || "(no content)"}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function usePageHead(title: string, description: string, path: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    const url = `https://nfotp.netlify.app${path}`;
    const upsert = (sel: string, create: () => HTMLElement, attr: string, value: string) => {
      let el = document.head.querySelector<HTMLElement>(sel);
      if (!el) { el = create(); document.head.appendChild(el); }
      el.setAttribute(attr, value);
      return el;
    };
    const md = upsert('meta[name="description"]', () => { const m = document.createElement('meta'); m.setAttribute('name', 'description'); return m; }, 'content', description);
    const ot = upsert('meta[property="og:title"]', () => { const m = document.createElement('meta'); m.setAttribute('property', 'og:title'); return m; }, 'content', title);
    const od = upsert('meta[property="og:description"]', () => { const m = document.createElement('meta'); m.setAttribute('property', 'og:description'); return m; }, 'content', description);
    const ou = upsert('meta[property="og:url"]', () => { const m = document.createElement('meta'); m.setAttribute('property', 'og:url'); return m; }, 'content', url);
    const cn = upsert('link[rel="canonical"]', () => { const l = document.createElement('link'); l.setAttribute('rel', 'canonical'); return l; }, 'href', url);
    return () => { document.title = prev; void md; void ot; void od; void ou; void cn; };
  }, [title, description, path]);
}

function timeAgo(iso?: string | null): string {
  if (!iso) return "—";
  const d = Date.now() - new Date(iso).getTime();
  if (d < 0) return "—";
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function RecipientsDrawer({ notification, onClose, onChanged }: { notification: any; onClose: () => void; onChanged?: () => void }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<NotificationRecipient[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "seen" | "read" | "clicked" | "deleted" | "pending">("all");
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const list = await adminListRecipients(notification.id);
      setRows(list);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load recipients");
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [notification.id]);

  const removeForUser = async (userId: string) => {
    if (!confirm("Is user ke inbox se yeh notification hata dein?")) return;
    setRemoving(userId);
    try {
      await adminDeleteNotificationForUser(notification.id, userId);
      toast.success("Removed for this user");
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally { setRemoving(null); }
  };

  const q = search.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (q && !((r.name || "").toLowerCase().includes(q) || (r.username || "").toLowerCase().includes(q))) return false;
    switch (filter) {
      case "seen": return !!r.seen_at;
      case "read": return !!r.read_at;
      case "clicked": return !!r.clicked_at;
      case "deleted": return !!r.deleted_at;
      case "pending": return !r.seen_at && !r.deleted_at;
      default: return true;
    }
  });

  const seenN = rows.filter((r) => !!r.seen_at).length;
  const readN = rows.filter((r) => !!r.read_at).length;
  const clickedN = rows.filter((r) => !!r.clicked_at).length;
  const deletedN = rows.filter((r) => !!r.deleted_at).length;

  return (
    <div className="fixed inset-0 z-[110] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-3xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 sm:p-5 border-b flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">👥 Recipients</div>
            <h3 className="font-black text-base sm:text-lg text-slate-900 truncate mt-0.5">{notification.title}</h3>
            <div className="mt-2 flex items-center gap-3 text-[11px] font-bold flex-wrap">
              <span className="text-slate-600">Total {rows.length}</span>
              <span className="text-slate-600">👀 {seenN} seen</span>
              <span className="text-emerald-700">✅ {readN} read</span>
              <span className="text-sky-700">🖱 {clickedN} clicked</span>
              <span className="text-rose-600">🗑 {deletedN} deleted</span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-900 shrink-0 p-1"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-3 sm:p-4 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or username…"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 bg-white focus:outline-none focus:border-slate-400"
            />
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {([
              { k: "all", label: "All" },
              { k: "pending", label: "Pending" },
              { k: "seen", label: "Seen" },
              { k: "read", label: "Read" },
              { k: "clicked", label: "Clicked" },
              { k: "deleted", label: "Deleted" },
            ] as const).map((f) => (
              <button key={f.k} onClick={() => setFilter(f.k)}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold transition-colors ${filter === f.k ? "bg-slate-900 text-white" : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"}`}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-8 text-center text-sm text-slate-500">Loading recipients…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">Koi recipient nahi mila.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0 z-10 text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                <tr>
                  <th className="text-left px-4 py-2.5">User</th>
                  <th className="text-left px-3 py-2.5">Seen</th>
                  <th className="text-left px-3 py-2.5">Read</th>
                  <th className="text-left px-3 py-2.5">Clicked</th>
                  <th className="text-left px-3 py-2.5">Deleted</th>
                  <th className="text-right px-4 py-2.5">Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const isDeleted = !!r.deleted_at;
                  return (
                    <tr key={r.user_id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2.5">
                        <div className="font-semibold text-slate-900 text-[13px]">{r.name || r.username}</div>
                        <div className="text-[11px] text-slate-500">@{r.username}</div>
                      </td>
                      <td className="px-3 py-2.5 text-[12px] text-slate-700">{timeAgo(r.seen_at)}</td>
                      <td className={`px-3 py-2.5 text-[12px] ${r.read_at ? "text-emerald-700 font-semibold" : "text-slate-400"}`}>{timeAgo(r.read_at)}</td>
                      <td className={`px-3 py-2.5 text-[12px] ${r.clicked_at ? "text-sky-700 font-semibold" : "text-slate-400"}`}>{timeAgo(r.clicked_at)}</td>
                      <td className={`px-3 py-2.5 text-[12px] ${isDeleted ? "text-rose-600 font-semibold" : "text-slate-400"}`}>{timeAgo(r.deleted_at)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {isDeleted ? (
                          <span className="text-[11px] text-slate-400 italic">already deleted</span>
                        ) : (
                          <button
                            onClick={() => removeForUser(r.user_id)}
                            disabled={removing === r.user_id}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-rose-600 hover:bg-rose-50 border border-rose-200 disabled:opacity-50">
                            <Trash2 className="w-3 h-3" />
                            {removing === r.user_id ? "…" : "Remove for user"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="p-3 border-t bg-slate-50 flex items-center justify-between rounded-b-2xl">
          <button onClick={load} className="text-[12px] font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-900 text-white text-[12px] font-bold hover:bg-slate-800">Done</button>
        </div>
      </div>
    </div>
  );
}

function AdminPanel() {
  usePageHead("Admin Dashboard — Netflix Mail", "Admin control panel for managing users, sessions, notifications, and email accounts.", "/admin/dashboard");
  const [activeTab, setActiveTab] = useState<"users" | "security" | "emails" | "settings" | "notifications" | "inbox" | "logins" | "allmails">("users");
  const [users, setUsers] = useState<UserData[]>(() => {
    // Instant hydrate from bootstrap cache so the users list renders on first paint.
    try {
      const cached = readBootstrapCache();
      if (cached?.users?.length) return cached.users as any;
    } catch {}
    return [];
  });
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [newUserAccounts, setNewUserAccounts] = useState<string[]>([]);
  const [siteKey, setSiteKey] = useState("");
  const [secretKeyVal, setSecretKeyVal] = useState("");
  const [sessionTimeoutMin, setSessionTimeoutMin] = useState<string>("0");
  const [savingSessionTimeout, setSavingSessionTimeout] = useState(false);
  const [adminSessionTimeoutMin, setAdminSessionTimeoutMin] = useState<string>("0");
  const [savingAdminSessionTimeout, setSavingAdminSessionTimeout] = useState(false);
  const [captchaEnabled, setCaptchaEnabled] = useState<boolean>(false);
  const [emailVisibilityEnabled, setEmailVisibilityEnabled] = useState(false);
  const [emailVisibilityDays, setEmailVisibilityDays] = useState<string>("20");
  const [savingEmailVisibility, setSavingEmailVisibility] = useState(false);
  const [emailAutoDeleteEnabled, setEmailAutoDeleteEnabled] = useState(false);
  const [emailAutoDeleteDays, setEmailAutoDeleteDays] = useState<string>("30");
  const [emailAutoDeleteHour, setEmailAutoDeleteHour] = useState<string>("3");
  const [savingEmailAutoDelete, setSavingEmailAutoDelete] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newAdminPassword, setNewAdminPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [changingUserPass, setChangingUserPass] = useState<string | null>(null);
  const [userNewPass, setUserNewPass] = useState("");
  const [showSignInCodes, setShowSignInCodes] = useState(true);
  const [showPasswordResets, setShowPasswordResets] = useState(false);
  const [showAccountUpdates, setShowAccountUpdates] = useState(false);
  const [editingUserAccounts, setEditingUserAccounts] = useState<string | null>(null);
  const [editAccountsList, setEditAccountsList] = useState<string[]>([]);
  const [serverConfig, setServerConfig] = useState({
    TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", IMAP_HOST: "", IMAP_PORT: "", IMAP_USER: "", IMAP_PASSWORD: "",
  });
  const [savingConfig, setSavingConfig] = useState(false);
  const [emailAccounts, setEmailAccounts] = useState<Array<{ label: string; host: string; port: string; user: string; password: string; cloudflareUrls: string[] }>>([]);
  const [newAccount, setNewAccount] = useState({ label: "", host: "imap.gmail.com", port: "993", user: "", password: "" });
  const [newAccountCfUrls, setNewAccountCfUrls] = useState<string[]>([]);
  const [newAccountCfInput, setNewAccountCfInput] = useState("");
  const [savingAccounts, setSavingAccounts] = useState(false);
  const [expandedAccount, setExpandedAccount] = useState<number | null>(null);
  const [primaryCfUrls, setPrimaryCfUrls] = useState<string[]>([]);
  // Location alert toggle
  const [ipwhoAlertEnabled, setIpwhoAlertEnabled] = useState(false);
  const [savingIpwho, setSavingIpwho] = useState(false);
  // Maintenance mode
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);
  const [maintenanceTitle, setMaintenanceTitle] = useState("");
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [maintenanceStartsAt, setMaintenanceStartsAt] = useState(""); // datetime-local "YYYY-MM-DDTHH:mm"
  const [maintenanceEndsAt, setMaintenanceEndsAt] = useState(""); // datetime-local value "YYYY-MM-DDTHH:mm"
  const [maintenanceVersionFrom, setMaintenanceVersionFrom] = useState("");
  const [maintenanceVersionTo, setMaintenanceVersionTo] = useState("");
  const [savingMaintenance, setSavingMaintenance] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const prevSavedVersionToRef = useRef<string>("");


  // Notifications tab
  const [adminNotifs, setAdminNotifs] = useState<any[]>([]);
  const [notifTitle, setNotifTitle] = useState("");
  const [notifBody, setNotifBody] = useState("");
  const [notifDescription, setNotifDescription] = useState("");
  const [notifImageUrl, setNotifImageUrl] = useState("");
  const [notifImageUploading, setNotifImageUploading] = useState(false);
  const [notifCategory, setNotifCategory] = useState<"announcement" | "update" | "security" | "maintenance" | "promo" | "billing">("announcement");
  const [notifPriority, setNotifPriority] = useState<"low" | "normal" | "high" | "critical">("normal");
  const [notifActionUrl, setNotifActionUrl] = useState("");
  const [notifActionLabel, setNotifActionLabel] = useState("");
  
  const [notifAudience, setNotifAudience] = useState<"all" | "user">("all");
  const [notifTargetUser, setNotifTargetUser] = useState<string>("");
  const [notifExpiresDays, setNotifExpiresDays] = useState<string>("");
  const [notifPlatformIcon, setNotifPlatformIcon] = useState<string>("");
  const [notifTemplate, setNotifTemplate] = useState<string>("");
  const [platformSearch, setPlatformSearch] = useState("");
  const { ready: platformLogosReady, results: platformLogoResults } = usePlatformLogoAudit(false);
  const [notifLocked, setNotifLocked] = useState(false);
  const [notifShowFrequency, setNotifShowFrequency] = useState<"once" | "always" | "session" | "daily">("once");
  const [notifMode, setNotifMode] = useState<"popup" | "silent" | "banner">("popup");
  const [sendingNotif, setSendingNotif] = useState(false);
  const [editingNotif, setEditingNotif] = useState<any | null>(null);
  const [savingEditNotif, setSavingEditNotif] = useState(false);
  const [recipientsFor, setRecipientsFor] = useState<any | null>(null);


  // R2 storage config
  type R2Cfg = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; publicBaseUrl: string; pathPrefix: string; enabled: boolean; secretAccessKeySet: boolean };
  const [r2Cfg, setR2Cfg] = useState<R2Cfg>({ accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "", publicBaseUrl: "", pathPrefix: "notifications/", enabled: false, secretAccessKeySet: false });
  const [r2Saving, setR2Saving] = useState(false);
  const [r2Testing, setR2Testing] = useState(false);
  const [r2TestResult, setR2TestResult] = useState<{ ok: boolean; message: string; latencyMs?: number; publicUrlWorks?: boolean; warnings?: string[] } | null>(null);
  const [r2ShowSecret, setR2ShowSecret] = useState(false);
  const [r2Dirty, setR2Dirty] = useState(false);
  const lastAdminRefreshRef = useRef(0);
  const updateR2Cfg = useCallback((patch: Partial<R2Cfg>) => {
    setR2Dirty(true);
    setR2Cfg((c) => ({ ...c, ...patch }));
  }, []);

  // Inbox tab
  const [inboxMode, setInboxMode] = useState<"all" | "label" | "days">("days");
  const [inboxLabel, setInboxLabel] = useState("");
  const [inboxDays, setInboxDays] = useState("30");
  const [inboxConfirm, setInboxConfirm] = useState("");
  const [clearingInbox, setClearingInbox] = useState(false);

  const [primaryCfInput, setPrimaryCfInput] = useState("");
  const [signingSecretReveal, setSigningSecretReveal] = useState<{ fingerprint: string; length: number; source: string } | null>(null);
  const [revealingSigningSecret, setRevealingSigningSecret] = useState(false);
  const [editingAccountUrls, setEditingAccountUrls] = useState<number | null>(null);
  const [editCfUrls, setEditCfUrls] = useState<string[]>([]);
  const [editCfInput, setEditCfInput] = useState("");
  const navigate = useNavigate();
  const { user: currentUser, checkAuth } = useAuth();

  const STATS_CACHE_KEY = "admin_stats_cache_v1";
  const [stats, setStats] = useState<{ totalUsers: number; totalEmails: number }>(() => {
    // Hydrate instantly from cache so the dashboard never flashes 0.
    try {
      const cached = localStorage.getItem(STATS_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed.totalUsers === "number" && typeof parsed.totalEmails === "number") return parsed;
      }
    } catch {}
    // Fallback: use bootstrap user count so we at least show a real number.
    try {
      const cached = readBootstrapCache();
      if (cached?.users?.length) return { totalUsers: cached.users.length, totalEmails: 0 };
    } catch {}
    return { totalUsers: 0, totalEmails: 0 };
  });
  useEffect(() => {
    try { localStorage.setItem(STATS_CACHE_KEY, JSON.stringify(stats)); } catch {}
  }, [stats]);

  const getAvailableAccounts = (): string[] => {
    const labels = ["Primary"];
    emailAccounts.forEach(acc => {
      if (acc.label && !labels.includes(acc.label)) labels.push(acc.label);
    });
    return labels;
  };

  const loadAdminData = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    // ONE composite server call replaces the 12 individual apiCalls.
    // - Bootstrap: users + emails count + notifications (+counts) + all settings + r2  → 1 HTTP request
    // - Refresh (silent): only the 3 live datasets, no settings → still 1 request
    // This keeps Supabase egress + edge-function invocations minimal so
    // free-tier limits don't get eaten by the admin panel.
    try {
      const res: any = await apiCall("manage-app", {
        action: silent ? "admin_dashboard_refresh" : "admin_dashboard_bootstrap",
      });
      if (Array.isArray(res?.users)) {
        setUsers(res.users);
        setStats(prev => ({ ...prev, totalUsers: res.users.length }));
      }
      if (typeof res?.emailsTotal === "number") {
        setStats(prev => ({ ...prev, totalEmails: res.emailsTotal }));
      }
      if (Array.isArray(res?.notifications)) setAdminNotifs(res.notifications);

      if (!silent && res?.settings) {
        const s = res.settings;
        if (s.recaptcha) {
          setSiteKey(s.recaptcha.siteKey || "");
          setSecretKeyVal(s.recaptcha.secretKey || "");
          setCaptchaEnabled(s.recaptcha.enabled === true);
        }
        if (s.email_visibility) {
          setEmailVisibilityEnabled(s.email_visibility.enabled === true);
          if (Number(s.email_visibility.days) > 0) setEmailVisibilityDays(String(s.email_visibility.days));
        }
        if (s.email_auto_delete) {
          setEmailAutoDeleteEnabled(s.email_auto_delete.enabled === true);
          if (Number(s.email_auto_delete.days) > 0) setEmailAutoDeleteDays(String(s.email_auto_delete.days));
          if (Number.isFinite(Number(s.email_auto_delete.hour))) setEmailAutoDeleteHour(String(s.email_auto_delete.hour));
        }
        if (s.config) {
          const c = s.config as any;
          setServerConfig({
            TELEGRAM_BOT_TOKEN: c.TELEGRAM_BOT_TOKEN || "",
            TELEGRAM_CHAT_ID: c.TELEGRAM_CHAT_ID || "",
            IMAP_HOST: c.IMAP_HOST || "",
            IMAP_PORT: c.IMAP_PORT || "",
            IMAP_USER: c.IMAP_USER || "",
            IMAP_PASSWORD: c.IMAP_PASSWORD || "",
          });
        }
        if (Array.isArray(s.primary_cloudflare_urls)) setPrimaryCfUrls(s.primary_cloudflare_urls);
        if (s.email_filters) {
          setShowSignInCodes(s.email_filters.showSignInCodes !== false);
          setShowPasswordResets(s.email_filters.showPasswordResets === true);
          setShowAccountUpdates(s.email_filters.showAccountUpdates === true);
          setEmailFiltersCache(s.email_filters);
        }
        if (Array.isArray(s.email_accounts)) {
          const migrated = s.email_accounts.map((acc: any) => {
            if (acc.cloudflareUrls && Array.isArray(acc.cloudflareUrls)) return acc;
            const urls: string[] = [];
            if (acc.cloudflareUrl && acc.cloudflareUrl.trim()) urls.push(acc.cloudflareUrl.trim());
            const { cloudflareUrl, ...rest } = acc;
            return { ...rest, cloudflareUrls: urls };
          });
          setEmailAccounts(migrated);
        }
        const m1 = Number(s.session_config?.timeoutMinutes);
        if (Number.isFinite(m1) && m1 >= 0) setSessionTimeoutMin(String(m1));
        const m2 = Number(s.admin_session_config?.timeoutMinutes);
        if (Number.isFinite(m2) && m2 >= 0) setAdminSessionTimeoutMin(String(m2));
        setIpwhoAlertEnabled(s.ipwho_alert?.enabled === true);
        if (s.maintenance) {
          const mnt = s.maintenance;
          setMaintenanceEnabled(mnt.enabled === true);
          setMaintenanceTitle(mnt.title || "");
          setMaintenanceMessage(mnt.message || "");
          setMaintenanceVersionFrom(mnt.versionFrom || "");
          setMaintenanceVersionTo(mnt.versionTo || "");
          prevSavedVersionToRef.current = mnt.versionTo || "";
          const toLocalInput = (iso: string) => {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return "";
            const pad = (n: number) => String(n).padStart(2, "0");
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
          };
          if (mnt.startsAt) setMaintenanceStartsAt(toLocalInput(mnt.startsAt));
          if (mnt.endsAt) setMaintenanceEndsAt(toLocalInput(mnt.endsAt));
        }
        if (res.r2) {
          setR2Cfg((current) => r2Dirty ? current : ({
            accountId: res.r2.accountId || "",
            accessKeyId: res.r2.accessKeyId || "",
            secretAccessKey: res.r2.secretAccessKey || "",
            bucket: res.r2.bucket || "",
            publicBaseUrl: res.r2.publicBaseUrl || "",
            pathPrefix: res.r2.pathPrefix || "notifications/",
            enabled: res.r2.enabled === true,
            secretAccessKeySet: res.r2.secretAccessKeySet === true,
          }));
        }
      }
    } catch (err) {
      if (!silent) console.warn("[admin] dashboard load failed:", err);
    }
  }, [r2Dirty]);

  useEffect(() => {
    // Initial full load
    void loadAdminData();

    // Refresh live data on tab focus only. NO polling — polling would burn
    // through Supabase egress + edge-function invocations on the free tier.
    // Admin still gets fresh data whenever they come back to the tab, and
    // can pull the manual "Refresh" button for on-demand updates.
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastAdminRefreshRef.current < 5 * 60_000) return;
      lastAdminRefreshRef.current = now;
      void loadAdminData({ silent: true });
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [loadAdminData]);



  const saveSessionTimeout = async () => {
    const m = Math.max(0, Math.floor(Number(sessionTimeoutMin) || 0));
    setSavingSessionTimeout(true);
    try {
      await apiCall("manage-app", {
        action: "set_settings",
        key: "session_config",
        value: { timeoutMinutes: m },
      });
      setSessionTimeoutMin(String(m));
      toast.success(m === 0 ? "Session timeout disabled" : `Session timeout set to ${m} min`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save session timeout");
    } finally {
      setSavingSessionTimeout(false);
    }
  };
  const saveAdminSessionTimeout = async () => {
    const m = Math.max(0, Math.floor(Number(adminSessionTimeoutMin) || 0));
    setSavingAdminSessionTimeout(true);
    try {
      await apiCall("manage-app", {
        action: "set_settings",
        key: "admin_session_config",
        value: { timeoutMinutes: m },
      });
      setAdminSessionTimeoutMin(String(m));
      toast.success(m === 0 ? "Admin session timeout disabled" : `Admin auto-logout set to ${m} min`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save admin session timeout");
    } finally {
      setSavingAdminSessionTimeout(false);
    }
  };

  const saveMaintenance = async (nextEnabled?: boolean) => {
    // Convert local datetime-local -> ISO. Empty string means no scheduled start/end.
    const toIso = (s: string): string | null => {
      if (!s) return null;
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d.toISOString();
    };
    const startsAtIso = toIso(maintenanceStartsAt);
    const endsAtIso = toIso(maintenanceEndsAt);
    if (startsAtIso && endsAtIso && new Date(endsAtIso).getTime() <= new Date(startsAtIso).getTime()) {
      toast.error("End time must be after start time");
      return;
    }

    // Auto-enable when the admin fills a schedule (even without flipping the toggle).
    const hasSchedule = !!(startsAtIso && endsAtIso);
    const enabled = typeof nextEnabled === "boolean" ? nextEnabled : (maintenanceEnabled || hasSchedule);

    // Version auto-bump: baseline 2.4.4. Each save bumps patch +1 from the previously saved
    // versionTo unless the admin manually typed a different (higher) version.
    const bumpPatch = (v: string) => {
      const parts = String(v || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10));
      while (parts.length < 3) parts.push(0);
      parts[2] = (Number.isFinite(parts[2]) ? parts[2] : 0) + 1;
      return parts.map((n) => (Number.isFinite(n) ? n : 0)).join(".");
    };
    const prevTo = prevSavedVersionToRef.current || "2.4.3";
    let nextVersionTo = maintenanceVersionTo.trim();
    let autoBumped = false;
    if (!nextVersionTo || nextVersionTo === prevTo) {
      nextVersionTo = bumpPatch(prevTo); // auto-bump patch from previously stored versionTo
      autoBumped = true;
    }
    // Current version is ALWAYS the previously stored upgrade target — admin cannot override via UI.
    const nextVersionFrom = prevTo;

    setSavingMaintenance(true);
    try {
      await apiCall("manage-app", {
        action: "set_settings",
        key: "maintenance",
        value: {
          enabled,
          title: maintenanceTitle.trim(),
          message: maintenanceMessage.trim(),
          startsAt: startsAtIso,
          endsAt: endsAtIso,
          versionFrom: nextVersionFrom,
          versionTo: nextVersionTo,
          updated_at: new Date().toISOString(),
        },
      });
      setMaintenanceEnabled(enabled);
      setMaintenanceVersionFrom(nextVersionFrom);
      setMaintenanceVersionTo(nextVersionTo);
      prevSavedVersionToRef.current = nextVersionTo;
      try { await refreshBootstrap(); } catch {}
      window.dispatchEvent(new Event("maintenance:changed"));
      if (autoBumped) toast.success(`Saved · version auto-bumped to v${nextVersionTo}`);
      else toast.success(enabled ? `Maintenance ON · v${nextVersionTo}` : `Maintenance OFF · v${nextVersionTo}`);
      if (hasSchedule && !maintenanceEnabled && typeof nextEnabled !== "boolean") {
        toast.message("Scheduled — site will auto-lock at start time and auto-unlock at end time.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save maintenance settings");
    } finally {
      setSavingMaintenance(false);
    }
  };

  const saveR2Config = async () => {
    setR2Saving(true);
    setR2TestResult(null);
    try {
      const res: any = await apiCall("manage-app", {
        action: "admin_save_r2_config",
        accountId: r2Cfg.accountId.trim(),
        accessKeyId: r2Cfg.accessKeyId.trim(),
        secretAccessKey: r2Cfg.secretAccessKey, // blank string = keep existing
        bucket: r2Cfg.bucket.trim(),
        publicBaseUrl: r2Cfg.publicBaseUrl.trim(),
        pathPrefix: (r2Cfg.pathPrefix.trim() || "notifications/"),
        enabled: r2Cfg.enabled,
      });
      if (res?.config) {
        setR2Cfg((c) => ({
          ...c,
          accountId: res.config.accountId ?? c.accountId,
          accessKeyId: res.config.accessKeyId ?? c.accessKeyId,
          secretAccessKey: res.config.secretAccessKey ?? c.secretAccessKey,
          bucket: res.config.bucket ?? c.bucket,
          publicBaseUrl: res.config.publicBaseUrl ?? c.publicBaseUrl,
          pathPrefix: res.config.pathPrefix ?? c.pathPrefix,
          enabled: res.config.enabled ?? c.enabled,
          secretAccessKeySet: res.config.secretAccessKeySet ?? c.secretAccessKeySet,
        }));
      }
      const persisted = r2Cfg.secretAccessKey.length > 0 || r2Cfg.secretAccessKeySet;
      setR2Cfg((c) => ({ ...c, secretAccessKeySet: persisted }));
      setR2Dirty(false);
      const note = Array.isArray(res?.warnings) && res.warnings.length ? ` (${res.warnings[0]})` : "";
      toast.success(`${r2Cfg.enabled ? "R2 storage saved & enabled" : "R2 storage saved"}${note}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save R2 config");
    } finally {
      setR2Saving(false);
    }
  };

  const testR2Connection = async () => {
    setR2Testing(true);
    setR2TestResult(null);
    try {
      const res: any = await apiCall("manage-app", {
        action: "admin_r2_test",
        accountId: r2Cfg.accountId.trim(),
        accessKeyId: r2Cfg.accessKeyId.trim(),
        secretAccessKey: r2Cfg.secretAccessKey,
        bucket: r2Cfg.bucket.trim(),
        publicBaseUrl: r2Cfg.publicBaseUrl.trim(),
        pathPrefix: (r2Cfg.pathPrefix.trim() || "notifications/"),
        enabled: r2Cfg.enabled,
      });
      setR2TestResult({
        ok: res?.success === true,
        message: res?.message || (res?.success ? "OK" : "Failed"),
        latencyMs: res?.latencyMs,
        publicUrlWorks: res?.publicUrlWorks,
        warnings: Array.isArray(res?.warnings) ? res.warnings : undefined,
      });
      if (res?.success) toast.success(`Typed R2 values valid · ${res.latencyMs}ms`);
      else toast.error(res?.message || "R2 test failed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "R2 test failed";
      setR2TestResult({ ok: false, message: msg });
      toast.error(msg);
    } finally {
      setR2Testing(false);
    }
  };


  const toggleCaptcha = async () => {
    try {
      const newEnabled = !captchaEnabled;
      if (newEnabled && (!siteKey || !secretKeyVal)) { toast.error("Enter both Site Key and Secret Key first"); return; }
      await apiCall("manage-app", { action: "set_settings", key: "recaptcha", value: { siteKey, secretKey: secretKeyVal, enabled: newEnabled } });
      const fresh = await apiCall("manage-app", { action: "get_settings", key: "recaptcha" });
      setCaptchaEnabled(fresh.value?.enabled === true);
      setSiteKey(fresh.value?.siteKey || "");
      setSecretKeyVal(fresh.value?.secretKey || "");
      toast.success(newEnabled ? "CAPTCHA enabled!" : "CAPTCHA disabled!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to toggle CAPTCHA");
    }
  };

  const saveRecaptchaSettings = async () => {
    try {
      const newEnabled = !!(siteKey && secretKeyVal);
      await apiCall("manage-app", { action: "set_settings", key: "recaptcha", value: { siteKey, secretKey: secretKeyVal, enabled: newEnabled } });
      const fresh = await apiCall("manage-app", { action: "get_settings", key: "recaptcha" });
      setCaptchaEnabled(fresh.value?.enabled === true);
      toast.success("ReCAPTCHA settings saved!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    }
  };

  const saveEmailVisibility = async (nextEnabled?: boolean) => {
    setSavingEmailVisibility(true);
    try {
      const enabled = typeof nextEnabled === "boolean" ? nextEnabled : emailVisibilityEnabled;
      const days = Math.max(1, Math.min(365, parseInt(emailVisibilityDays) || 30));
      await apiCall("manage-app", { action: "email_visibility_set", enabled, days });
      setEmailVisibilityEnabled(enabled);
      setEmailVisibilityDays(String(days));
      toast.success(enabled ? `Users will see last ${days} days of emails` : "Users can see all emails");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingEmailVisibility(false);
    }
  };

  const saveEmailAutoDelete = async (nextEnabled?: boolean) => {
    setSavingEmailAutoDelete(true);
    try {
      const enabled = typeof nextEnabled === "boolean" ? nextEnabled : emailAutoDeleteEnabled;
      const days = Math.max(1, Math.min(365, parseInt(emailAutoDeleteDays) || 30));
      const hour = Math.max(0, Math.min(23, parseInt(emailAutoDeleteHour) || 3));
      await apiCall("manage-app", { action: "email_cleanup_apply", enabled, days, hour });
      setEmailAutoDeleteEnabled(enabled);
      setEmailAutoDeleteDays(String(days));
      setEmailAutoDeleteHour(String(hour));
      toast.success(enabled ? `Auto-delete: emails older than ${days} days will be removed daily at ${hour}:00` : "Auto-delete turned off");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingEmailAutoDelete(false);
    }
  };

  const persistEmailFilters = async (next: { showSignInCodes: boolean; showPasswordResets: boolean; showAccountUpdates: boolean }) => {
    await apiCall("manage-app", { action: "set_settings", key: "email_filters", value: next });
    setEmailFiltersCache(next);
  };

  const toggleSignInCodeFilter = async () => {
    const newVal = !showSignInCodes;
    setShowSignInCodes(newVal);
    try {
      await persistEmailFilters({ showSignInCodes: newVal, showPasswordResets, showAccountUpdates });
      toast.success(newVal ? "Sign-in code emails will be shown" : "Sign-in code emails will be hidden");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save filter setting");
      setShowSignInCodes(!newVal);
    }
  };

  const togglePasswordResetFilter = async () => {
    const newVal = !showPasswordResets;
    setShowPasswordResets(newVal);
    try {
      await persistEmailFilters({ showSignInCodes, showPasswordResets: newVal, showAccountUpdates });
      toast.success(newVal ? "Password reset emails will be shown" : "Password reset emails will be hidden");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save filter setting");
      setShowPasswordResets(!newVal);
    }
  };

  const toggleAccountUpdateFilter = async () => {
    const newVal = !showAccountUpdates;
    setShowAccountUpdates(newVal);
    try {
      await persistEmailFilters({ showSignInCodes, showPasswordResets, showAccountUpdates: newVal });
      toast.success(newVal ? "Account update emails will be shown" : "Account update emails will be hidden");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save filter setting");
      setShowAccountUpdates(!newVal);
    }
  };

  const saveServerConfig = async () => {
    setSavingConfig(true);
    try {
      await apiCall("manage-app", { action: "set_settings", key: "config", value: serverConfig });
      await apiCall("manage-app", { action: "set_settings", key: "primary_cloudflare_urls", value: primaryCfUrls });
      // No browser-persistent worker URL cache; viewer reloads server settings.
      storeWorkerUrls(primaryCfUrls);
      toast.success("Server configuration saved!");
    } catch (err) {
      toast.error("Failed to save: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSavingConfig(false);
    }
  };

  const revealSigningSecret = async () => {
    setRevealingSigningSecret(true);
    try {
      // Direct Supabase call on purpose: this secret is needed to configure Cloudflare,
      // so revealing it must not depend on an already-working Worker.
      const token = getSessionToken();
      const { invokeEdge } = await import("./lib/secureTransport");
      const res: any = await invokeEdge(
        "manage-app",
        { action: "admin_reveal_session_signing_secret" },
        { headers: token ? { "X-Session-Token": token } : {} },
      );
      if (!res?.success) throw new Error(res?.error || "Could not inspect SESSION_SIGNING_SECRET");
      setSigningSecretReveal({
        fingerprint: String(res.fingerprint || ""),
        length: Number(res.length) || 0,
        source: String(res.source || ""),
      });
      toast.success("Signing secret verified. Copy the raw value from Supabase Dashboard → Edge Function Secrets.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not inspect SESSION_SIGNING_SECRET");
    } finally {
      setRevealingSigningSecret(false);
    }
  };

  const copySigningSecret = async () => {
    if (!signingSecretReveal?.fingerprint) return;
    try {
      await navigator.clipboard.writeText(signingSecretReveal.fingerprint);
      toast.success("Fingerprint copied (not the raw secret)");
    } catch {
      toast.error("Copy failed — long press/select manually.");
    }
  };

  const toggleIpwhoAlert = async () => {
    const next = !ipwhoAlertEnabled;
    setIpwhoAlertEnabled(next);
    setSavingIpwho(true);
    try {
      await apiCall("manage-app", { action: "set_settings", key: "ipwho_alert", value: { enabled: next } });
      toast.success(next ? "Legacy ipwho.is alert enabled" : "Legacy ipwho.is alert disabled");
    } catch (err) {
      setIpwhoAlertEnabled(!next);
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally { setSavingIpwho(false); }
  };

  const reloadAdminNotifs = async () => {
    try {
      const nl = await apiCall("manage-app", { action: "admin_list_notifications" });
      if (Array.isArray(nl?.notifications)) setAdminNotifs(nl.notifications);
    } catch (err) { console.warn(err); }
  };

  const sendNotification = async () => {
    if (!notifTitle.trim() || !notifBody.trim()) { toast.error("Title and body required"); return; }
    if (notifAudience === "user" && !notifTargetUser) { toast.error("Choose a target user"); return; }
    if (notifImageUrl.trim() && !/^https:\/\//i.test(notifImageUrl.trim())) { toast.error("Image URL must start with https://"); return; }
    if (notifActionUrl.trim() && !/^https?:\/\//i.test(notifActionUrl.trim())) { toast.error("Action URL must be a valid link"); return; }
    setSendingNotif(true);
    try {
      await apiCall("manage-app", {
        action: "admin_create_notification",
        title: notifTitle.trim(),
        body: notifBody.trim(),
        description: notifDescription.trim() || null,
        image_url: notifImageUrl.trim() || null,
        category: notifCategory,
        priority: notifPriority,
        kind: "flash",
        mode: notifMode,
        show_frequency: notifShowFrequency,
        platform_icon: resolvePlatformOption(notifPlatformIcon).id || null,
        sub_kind: notifTemplate || null,
        locked: notifLocked,
        action_url: notifActionUrl.trim() || null,
        action_label: notifActionLabel.trim() || null,
        audience: notifAudience,
        target_user_id: notifAudience === "user" ? notifTargetUser : null,
        expiresInDays: notifExpiresDays ? Number(notifExpiresDays) : null,
      });
      premiumToast("Notification sent", { variant: "info", description: "Delivered to targeted users", duration: 2400 });
      setNotifTitle(""); setNotifBody(""); setNotifDescription(""); setNotifImageUrl("");
      setNotifActionUrl(""); setNotifActionLabel("");
      setNotifExpiresDays(""); setNotifPlatformIcon(""); setNotifTemplate("");
      setNotifLocked(false);
      await reloadAdminNotifs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send");
    } finally { setSendingNotif(false); }
  };


  const deleteNotification = async (id: string) => {
    if (!confirm("Delete this notification for everyone?")) return;
    try {
      await apiCall("manage-app", { action: "admin_delete_notification", id });
      setAdminNotifs((prev) => prev.filter((n) => n.id !== id));
      toast.success("Deleted");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Failed"); }
  };

  const saveEditNotif = async () => {
    if (!editingNotif) return;
    const e = editingNotif;
    if (!e.title?.trim() || !e.body?.trim()) { toast.error("Title and message required"); return; }
    setSavingEditNotif(true);
    try {
      await apiCall("manage-app", {
        action: "admin_update_notification",
        id: e.id,
        title: e.title.trim(),
        body: e.body.trim(),
        action_url: e.action_url?.trim() || null,
        platform_icon: resolvePlatformOption(e.platform_icon).id || null,
        locked: !!e.locked,
        priority: e.priority || "normal",
        audience: e.audience || "all",
        target_user_id: e.audience === "user" ? (e.target_user_id || null) : null,
      });
      toast.success("Updated");
      setEditingNotif(null);
      await reloadAdminNotifs();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Failed"); }
    finally { setSavingEditNotif(false); }
  };

  const duplicateToComposer = (n: any) => {
    setNotifTitle(n.title || "");
    setNotifBody(n.body || "");
    setNotifDescription(n.description || "");
    setNotifImageUrl(n.image_url || "");
    setNotifActionUrl(n.action_url || "");
    setNotifActionLabel(n.action_label || "");
    setNotifPlatformIcon(resolvePlatformOption(n.platform_icon).id || "");
    setNotifLocked(!!n.locked);
    setNotifCategory(n.category || "announcement");
    setNotifPriority(n.priority || "normal");
    setNotifAudience(n.audience || "all");
    setNotifTargetUser(n.target_user_id || "");
    setNotifShowFrequency(n.show_frequency || "once");
    setNotifMode(n.mode || "popup");
    toast.success("Copied to composer — edit and publish as new");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };




  const adminClearInbox = async () => {
    if (inboxMode === "all" && inboxConfirm !== "DELETE ALL") {
      toast.error('Type DELETE ALL to confirm');
      return;
    }
    if (inboxMode === "label" && !inboxLabel) { toast.error("Choose an account label"); return; }
    if (inboxMode === "days" && !inboxDays) { toast.error("Enter days"); return; }
    if (!confirm("This permanently deletes emails from the database. Continue?")) return;
    setClearingInbox(true);
    try {
      const res = await apiCall("manage-app", {
        action: "admin_clear_inbox",
        mode: inboxMode,
        accountLabel: inboxMode === "label" ? inboxLabel : undefined,
        days: inboxMode === "days" ? Number(inboxDays) : undefined,
        confirm: inboxMode === "all" ? inboxConfirm : undefined,
      });
      toast.success(`Deleted ${res.deleted || 0} email(s)`);
      setInboxConfirm("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally { setClearingInbox(false); }
  };

  const changeAdminPassword = async () => {
    if (!currentPassword || !newAdminPassword) { toast.error("Fill both fields"); return; }
    setChangingPassword(true);
    try {
      await apiCall("manage-app", {
        action: "change_password", id: currentUser?.id, current_password: currentPassword, new_password: newAdminPassword,
      });
      setCurrentPassword(""); setNewAdminPassword("");
      toast.success("Password changed successfully!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setChangingPassword(false);
    }
  };

  const changeUserPassword = async (userId: string) => {
    if (!userNewPass || userNewPass.length < 6) { toast.error("Password must be at least 6 characters"); return; }
    try {
      await apiCall("manage-app", { action: "change_password", id: userId, new_password: userNewPass });
      setUserNewPass(""); setChangingUserPass(null);
      toast.success("User password changed!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change password");
    }
  };

  const loginAsUser = async (targetUser: UserData) => {
    try {
      // Snapshot the admin identity BEFORE the network call. The impersonate
      // response carries a user-role sessionToken; if we read session state
      // after the call, we'd back up the user token as "admin" and later
      // restoration would fail with "Admin access required".
      const adminUser = sessionGet("user" as any);
      const adminToken = sessionGet("session_token" as any);
      const adminAuth = sessionGet("admin_auth" as any);

      toast.loading(`Opening ${targetUser.name}'s inbox…`, { id: "impersonate" });
      const data = await apiCall("manage-app", { action: "impersonate", target_user_id: targetUser.id });
      toast.dismiss("impersonate");

      // F4: Use sessionStorage (auto-cleared on tab close) with a 10-min TTL so a
      // shared-device user or same-origin script can't lift the admin session token.
      try {
        sessionSet("admin_backup" as any, JSON.stringify({
          user: adminUser, token: adminToken, adminAuth, exp: Date.now() + 10 * 60_000,
        }));
      } catch {}
      try { sessionRemove("admin_backup" as any); } catch {}

      // CRITICAL: navigate to /viewer BEFORE swapping the session in state.
      // Otherwise ProtectedRoute on /admin/dashboard sees role="user" and
      // redirects to "/" (login), racing past navigate("/viewer") and
      // kicking the admin out.
      navigate("/viewer", { replace: true });

      sessionSet("user" as any, JSON.stringify(data.user));
      if (data.sessionToken) sessionSet("session_token" as any, data.sessionToken);
      // Impersonation: also defer session timer until EmailViewer loads inbox.
      try { sessionRemove("session_started_at" as any); } catch {}
      sessionRemove("admin_auth" as any);
      checkAuth();
      toast.success(`Viewing as ${targetUser.name}`);
    } catch (err) {
      toast.dismiss("impersonate");
      toast.error(err instanceof Error ? err.message : "Failed to impersonate user");
    }
  };



  const createUser = async () => {
    if (!newUsername || !newPassword || !newName) { toast.error("Please fill all fields"); return; }
    if (creatingUser) return;
    setCreatingUser(true);
    try {
      const res: any = await apiCall("manage-app", {
        action: "create", username: newUsername, password: newPassword, name: newName, role: "user",
        assigned_accounts: newUserAccounts.length > 0 ? newUserAccounts : null,
      });
      setNewUsername(""); setNewPassword(""); setNewName(""); setNewUserAccounts([]);
      if (!res?.user) throw new Error("Server did not return the created user");
      setUsers(prev => [...prev, res.user]);
      setStats(prev => ({ ...prev, totalUsers: prev.totalUsers + 1 }));
      toast.success("User created!");
    } catch (err) {
      toast.error("Failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setCreatingUser(false);
    }
  };

  const deleteUser = async (id: string) => {
    try {
      await apiCall("manage-app", { action: "delete", id });
      setUsers(users.filter(u => u.id !== id));
      toast.success("User deleted!");
    } catch (err) {
      toast.error("Failed: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const addEmailAccount = async () => {
    if (!newAccount.label || !newAccount.user || !newAccount.password) {
      toast.error("Fill label, email, and password"); return;
    }
    const updated = [...emailAccounts, { ...newAccount, cloudflareUrls: [...newAccountCfUrls] }];
    setEmailAccounts(updated);
    setNewAccount({ label: "", host: "imap.gmail.com", port: "993", user: "", password: "" });
    setNewAccountCfUrls([]);
    setNewAccountCfInput("");
    try {
      await apiCall("manage-app", { action: "set_settings", key: "email_accounts", value: updated });
      toast.success("Email account added!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save account");
    }
  };

  const removeEmailAccount = async (index: number) => {
    const updated = emailAccounts.filter((_, i) => i !== index);
    setEmailAccounts(updated);
    try {
      await apiCall("manage-app", { action: "set_settings", key: "email_accounts", value: updated });
      toast.success("Account removed!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove account");
    }
  };

  const updateUserAccounts = async (userId: string) => {
    try {
      await apiCall("manage-app", { action: "update_user", id: userId, assigned_accounts: editAccountsList.length > 0 ? editAccountsList : null });
      const nextAccounts = editAccountsList.length > 0 ? editAccountsList : null;
      setEditingUserAccounts(null);
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, assignedAccounts: nextAccounts } : u));
      toast.success("User accounts updated!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  };

  const tabs = [
    { id: "users" as const, label: "Users", icon: Users },
    { id: "logins" as const, label: "Login Events", icon: ShieldCheck },
    { id: "allmails" as const, label: "All Emails", icon: Mail },
    { id: "notifications" as const, label: "Notifications", icon: Bell },
    { id: "inbox" as const, label: "Inbox", icon: Mail },
    { id: "security" as const, label: "Security", icon: ShieldCheck },
    { id: "emails" as const, label: "Email Accounts", icon: Server },
    { id: "settings" as const, label: "Settings", icon: Settings },
  ];


  return (
    <div className="admin-panel min-h-[100dvh] bg-slate-50 overflow-x-hidden text-slate-900">
      <h1 className="sr-only">Admin Dashboard — Netflix Mail</h1>
      <header className="bg-white border-b px-3 sm:px-6 py-3 sm:py-4 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto flex justify-between items-center gap-2">
          <h2 className="text-sm sm:text-xl font-black flex items-center gap-2 min-w-0 truncate">
            <div className="bg-red-600 p-1.5 sm:p-2 rounded-xl">
              <Settings className="w-4 h-4 sm:w-5 sm:h-5 text-white" aria-hidden="true" />
            </div>
            <span className="hidden sm:inline">Admin Control Panel</span>
            <span className="sm:hidden">Admin</span>
          </h2>
          <button onClick={() => { sessionClearAll(); navigate("/"); }} className="p-2 hover:bg-slate-100 rounded-full transition-colors" title="Logout" aria-label="Logout">
            <LogOut className="w-5 h-5 text-slate-400" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-3 sm:px-6 pt-4 sm:pt-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white rounded-2xl border p-4 flex items-center gap-3">
            <div className="bg-blue-50 p-2.5 rounded-xl"><Users className="w-5 h-5 text-blue-600" /></div>
            <div><p className="text-2xl font-black text-slate-900">{stats.totalUsers}</p><p className="text-xs text-slate-500">Total Users</p></div>
          </div>
          <div className="bg-white rounded-2xl border p-4 flex items-center gap-3">
            <div className="bg-green-50 p-2.5 rounded-xl"><Mail className="w-5 h-5 text-green-600" /></div>
            <div><p className="text-2xl font-black text-slate-900">{stats.totalEmails}</p><p className="text-xs text-slate-500">Total Emails</p></div>
          </div>
          <div className="bg-white rounded-2xl border p-4 flex items-center gap-3">
            <div className="bg-purple-50 p-2.5 rounded-xl"><Globe className="w-5 h-5 text-purple-600" /></div>
            <div><p className="text-2xl font-black text-slate-900">{emailAccounts.length + 1}</p><p className="text-xs text-slate-500">Email Accounts</p></div>
          </div>
          <div className="bg-white rounded-2xl border p-4 flex items-center gap-3">
            <div className="bg-amber-50 p-2.5 rounded-xl"><ShieldCheck className="w-5 h-5 text-amber-600" /></div>
            <div><p className="text-2xl font-black text-slate-900">{captchaEnabled ? "ON" : "OFF"}</p><p className="text-xs text-slate-500">CAPTCHA</p></div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-3 sm:px-6 pt-4 sm:pt-6">
        <div className="flex gap-1 bg-white rounded-2xl border p-1.5 overflow-x-auto">
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 sm:px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all whitespace-nowrap ${
                activeTab === tab.id ? "bg-red-600 text-white shadow-md" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
              }`}>
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <main className="max-w-6xl mx-auto p-3 sm:p-6 pt-4 sm:pt-6">
        {activeTab === "users" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-green-50 p-1.5 rounded-lg"><Plus className="w-4 h-4 text-green-600" /></div>
                Create User
              </h2>
              <div className="space-y-3 min-w-0">
                <input type="text" placeholder="Display Name" value={newName} onChange={(e) => setNewName(e.target.value)}
                  className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                <input type="text" placeholder="Username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)}
                  className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                <PasswordInput value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Password"
                  className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />

                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Assign IMAP Accounts</label>
                  <div className="space-y-1.5">
                    {getAvailableAccounts().map(label => (
                      <label key={label} className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg cursor-pointer hover:bg-slate-100 transition-colors">
                        <input type="checkbox" checked={newUserAccounts.includes(label)}
                          onChange={(e) => {
                            if (e.target.checked) setNewUserAccounts([...newUserAccounts, label]);
                            else setNewUserAccounts(newUserAccounts.filter(a => a !== label));
                          }}
                          className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-500" />
                        <span className="text-sm text-slate-700">{label}</span>
                      </label>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">Leave empty = user sees no accounts</p>
                </div>

                <button onClick={createUser}
                  disabled={creatingUser}
                  className="w-full bg-slate-900 text-white font-bold py-3 rounded-xl hover:bg-slate-800 transition-all text-sm">
                  {creatingUser ? "Creating…" : "Create User"}
                </button>
              </div>
            </section>

            <section className="lg:col-span-2 bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-blue-50 p-1.5 rounded-lg"><Users className="w-4 h-4 text-blue-600" /></div>
                Active Users
                <span className="bg-slate-100 text-slate-600 text-xs px-2 py-0.5 rounded-full ml-auto">{users.length}</span>
              </h2>
              <div className="space-y-3">
                {users.map(u => (
                  <div key={u.id} className="p-3 sm:p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:border-slate-200 transition-colors min-w-0">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <ProfileAvatar
                          avatarId={getStableProfileAvatar(u)}
                          name={u.name}
                          className="w-10 h-10 !rounded-xl"
                          fallbackColor={u.role === "admin" ? "bg-red-500" : "bg-blue-500"}
                        />
                        <div className="min-w-0">
                          <p className="font-bold text-slate-900 truncate">{u.name}</p>
                          <p className="text-xs text-slate-500 truncate">@{u.username} • <span className={u.role === "admin" ? "text-red-600 font-bold" : "text-blue-600"}>{u.role}</span></p>
                          {u.assignedAccounts && u.assignedAccounts.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {u.assignedAccounts.map((a: string) => (
                                <span key={a} className="bg-blue-100 text-blue-700 text-[10px] px-1.5 py-0.5 rounded-md font-bold">{a}</span>
                              ))}
                            </div>
                          )}
                          {(!u.assignedAccounts || u.assignedAccounts.length === 0) && u.role !== "admin" && (
                            <p className="text-[10px] text-amber-600 mt-0.5 font-semibold">No accounts assigned</p>
                          )}
                        </div>
                      </div>
                      {u.role !== "admin" && (
                        <div className="flex items-center gap-1 self-end sm:self-auto">
                          <button onClick={() => loginAsUser(u)} title="View as user"
                            className="p-2 hover:bg-blue-50 text-blue-400 hover:text-blue-600 rounded-lg transition-colors">
                            <Eye className="w-4 h-4" />
                          </button>
                          <button onClick={() => { setEditingUserAccounts(editingUserAccounts === u.id ? null : u.id); setEditAccountsList((u as any).assignedAccounts || []); }} title="Edit accounts"
                            className="p-2 hover:bg-green-50 text-green-400 hover:text-green-600 rounded-lg transition-colors">
                            <Edit className="w-4 h-4" />
                          </button>
                          <button onClick={() => { setChangingUserPass(changingUserPass === u.id ? null : u.id); setUserNewPass(""); }} title="Change password"
                            className="p-2 hover:bg-amber-50 text-amber-400 hover:text-amber-600 rounded-lg transition-colors">
                            <KeyRound className="w-4 h-4" />
                          </button>
                          <button onClick={() => deleteUser(u.id)} title="Delete user"
                            className="p-2 hover:bg-red-50 text-red-400 hover:text-red-600 rounded-lg transition-colors">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>

                    {editingUserAccounts === u.id && u.role !== "admin" && (
                      <div className="mt-3 p-3 bg-white rounded-xl border">
                        <p className="text-xs font-bold text-slate-500 mb-2">Assign IMAP Accounts</p>
                        <div className="space-y-1.5 mb-2">
                          {getAvailableAccounts().map(label => (
                            <label key={label} className="flex items-center gap-2 p-1.5 rounded-lg cursor-pointer hover:bg-slate-50 transition-colors">
                              <input type="checkbox" checked={editAccountsList.includes(label)}
                                onChange={(e) => {
                                  if (e.target.checked) setEditAccountsList([...editAccountsList, label]);
                                  else setEditAccountsList(editAccountsList.filter(a => a !== label));
                                }}
                                className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-500" />
                              <span className="text-sm text-slate-700">{label}</span>
                            </label>
                          ))}
                        </div>
                        <button onClick={() => updateUserAccounts(u.id)}
                          className="w-full bg-green-600 text-white text-xs font-bold py-2 rounded-lg hover:bg-green-700 transition-all">
                          Save Accounts
                        </button>
                      </div>
                    )}

                    {changingUserPass === u.id && u.role !== "admin" && (
                      <div className="mt-3 flex flex-col sm:flex-row gap-2">
                        <PasswordInput value={userNewPass} onChange={(e) => setUserNewPass(e.target.value)}
                          placeholder="New password (min 6)"
                          className="flex-1 bg-white border rounded-lg p-2 pr-10 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                        <button onClick={() => changeUserPassword(u.id)}
                          className="px-4 py-2 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700 transition-all">
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {users.length === 0 && <p className="text-slate-400 text-sm text-center py-8">No users yet. Create one above.</p>}
              </div>
            </section>
          </div>
        )}

        {activeTab === "security" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-black text-base sm:text-lg flex items-center gap-2">
                  <div className="bg-blue-50 p-1.5 rounded-lg"><ShieldCheck className="w-4 h-4 text-blue-600" /></div>
                  CAPTCHA Protection
                </h2>
                <button onClick={toggleCaptcha}
                  className={`relative w-12 h-6 rounded-full transition-colors ${captchaEnabled ? "bg-green-500" : "bg-slate-300"}`}>
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${captchaEnabled ? "translate-x-6" : "translate-x-0.5"}`} />
                </button>
              </div>
              <p className="text-xs text-slate-500 mb-4">{captchaEnabled ? "✅ CAPTCHA is active on all logins" : "⚠️ CAPTCHA is disabled — logins are unprotected"}</p>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Site Key</label>
                  <input type="text" placeholder="Enter Site Key" value={siteKey} onChange={(e) => setSiteKey(e.target.value)}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Secret Key</label>
                  <PasswordInput value={secretKeyVal} onChange={(e) => setSecretKeyVal(e.target.value)}
                    placeholder="Enter Secret Key"
                    className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
                <button onClick={saveRecaptchaSettings}
                  className="w-full bg-red-600 text-white font-bold py-3 rounded-xl hover:bg-red-700 transition-all text-sm">
                  Save Keys
                </button>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-purple-50 p-1.5 rounded-lg"><Filter className="w-4 h-4 text-purple-600" /></div>
                Email Filters
              </h2>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border">
                  <div>
                    <p className="font-bold text-sm text-slate-900">Show Sign-In Code Emails</p>
                    <p className="text-xs text-slate-500 mt-1">When OFF, sign-in code & activity emails are hidden</p>
                  </div>
                  <button onClick={toggleSignInCodeFilter}
                    className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ml-3 ${showSignInCodes ? "bg-green-500" : "bg-slate-300"}`}>
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${showSignInCodes ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </div>
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border">
                  <div>
                    <p className="font-bold text-sm text-slate-900">Show Password Reset Emails</p>
                    <p className="text-xs text-slate-500 mt-1">When OFF, password reset emails are hidden from inbox</p>
                  </div>
                  <button onClick={togglePasswordResetFilter}
                    className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ml-3 ${showPasswordResets ? "bg-green-500" : "bg-slate-300"}`}>
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${showPasswordResets ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </div>
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border">
                  <div className="pr-3">
                    <p className="font-bold text-sm text-slate-900">Show Account Update Emails</p>
                    <p className="text-xs text-slate-500 mt-1">When OFF, Netflix "account info changed / email changed / membership cancelled / account deleted / on hold" emails are hidden from inbox. Telegram alerts are not affected.</p>
                  </div>
                  <button onClick={toggleAccountUpdateFilter}
                    className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ml-3 ${showAccountUpdates ? "bg-green-500" : "bg-slate-300"}`}>
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${showAccountUpdates ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </div>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-emerald-50 p-1.5 rounded-lg"><Mail className="w-4 h-4 text-emerald-600" /></div>
                User Email Visibility
              </h2>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border">
                  <div className="pr-3">
                    <p className="font-bold text-sm text-slate-900">Limit how far back users can see emails</p>
                    <p className="text-xs text-slate-500 mt-1">When OFF, every user sees all cached Netflix emails. When ON, only emails from the last N days are visible to users (admins always see everything).</p>
                  </div>
                  <button onClick={() => saveEmailVisibility(!emailVisibilityEnabled)} disabled={savingEmailVisibility}
                    className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ml-3 ${emailVisibilityEnabled ? "bg-green-500" : "bg-slate-300"}`}>
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${emailVisibilityEnabled ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                  <div className="flex-1">
                    <label className="text-xs font-bold text-slate-700 mb-1 block">Days visible to users</label>
                    <input type="number" min={1} max={365} value={emailVisibilityDays}
                      onChange={(e) => setEmailVisibilityDays(e.target.value)}
                      disabled={!emailVisibilityEnabled}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-emerald-500 text-sm disabled:opacity-50" />
                  </div>
                  <button onClick={() => saveEmailVisibility()} disabled={savingEmailVisibility || !emailVisibilityEnabled}
                    className="bg-emerald-600 text-white font-bold py-3 px-5 rounded-xl hover:bg-emerald-700 transition-all text-sm disabled:opacity-50">
                    {savingEmailVisibility ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-rose-50 p-1.5 rounded-lg"><Trash2 className="w-4 h-4 text-rose-600" /></div>
                Auto-Delete Old Emails
              </h2>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border">
                  <div className="pr-3">
                    <p className="font-bold text-sm text-slate-900">Automatic daily cleanup</p>
                    <p className="text-xs text-slate-500 mt-1">Runs once per day at the chosen hour and permanently deletes cached emails older than N days from the database.</p>
                  </div>
                  <button onClick={() => saveEmailAutoDelete(!emailAutoDeleteEnabled)} disabled={savingEmailAutoDelete}
                    className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ml-3 ${emailAutoDeleteEnabled ? "bg-green-500" : "bg-slate-300"}`}>
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${emailAutoDeleteEnabled ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-bold text-slate-700 mb-1 block">Delete older than (days)</label>
                    <input type="number" min={1} max={365} value={emailAutoDeleteDays}
                      onChange={(e) => setEmailAutoDeleteDays(e.target.value)}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-rose-500 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-700 mb-1 block">Run at hour (UTC, 0-23)</label>
                    <input type="number" min={0} max={23} value={emailAutoDeleteHour}
                      onChange={(e) => setEmailAutoDeleteHour(e.target.value)}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-rose-500 text-sm" />
                  </div>
                  <div className="flex items-end">
                    <button onClick={() => saveEmailAutoDelete()} disabled={savingEmailAutoDelete}
                      className="w-full bg-rose-600 text-white font-bold py-3 rounded-xl hover:bg-rose-700 transition-all text-sm disabled:opacity-50">
                      {savingEmailAutoDelete ? "Saving..." : (emailAutoDeleteEnabled ? "Update Schedule" : "Save")}
                    </button>
                  </div>
                </div>
              </div>
            </section>



            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-amber-50 p-1.5 rounded-lg"><Key className="w-4 h-4 text-amber-600" /></div>
                Change Admin Password
              </h2>
              <div className="space-y-3">
                <PasswordInput value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Current Password"
                  className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                <PasswordInput value={newAdminPassword} onChange={(e) => setNewAdminPassword(e.target.value)}
                  placeholder="New Password"
                  className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                <button onClick={changeAdminPassword} disabled={changingPassword}
                  className="w-full bg-red-600 text-white font-bold py-3 rounded-xl hover:bg-red-700 transition-all disabled:opacity-50 text-sm">
                  {changingPassword ? "Changing..." : "Change Password"}
                </button>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-2 flex items-center gap-2 text-slate-900">
                <div className="bg-indigo-50 p-1.5 rounded-lg"><Clock className="w-4 h-4 text-indigo-600" /></div>
                User Session Timeout
              </h2>
              <p className="text-xs text-slate-500 mb-4">
                Auto-logout for <span className="font-bold">end users</span> after this many minutes since login.
                Set <span className="font-bold">0</span> to disable.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                <div className="flex-1">
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1 ml-1">User timeout (minutes)</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={sessionTimeoutMin}
                    onChange={(e) => setSessionTimeoutMin(e.target.value)}
                    placeholder="e.g. 5"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>
                <button
                  onClick={saveSessionTimeout}
                  disabled={savingSessionTimeout}
                  className="sm:mt-5 bg-indigo-600 text-white font-bold py-3 px-6 rounded-xl hover:bg-indigo-700 transition-all disabled:opacity-50 text-sm whitespace-nowrap">
                  {savingSessionTimeout ? "Saving..." : "Save"}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-3">
                Current: {Number(sessionTimeoutMin) > 0 ? `${sessionTimeoutMin} min auto-logout` : "Disabled — user sessions never expire"}
              </p>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-2 flex items-center gap-2 text-slate-900">
                <div className="bg-red-50 p-1.5 rounded-lg"><Shield className="w-4 h-4 text-red-600" /></div>
                Admin Session Timeout
              </h2>
              <p className="text-xs text-slate-500 mb-4">
                Auto-logout for the <span className="font-bold">admin panel</span> after this many minutes.
                Independent from the user timeout. Set <span className="font-bold">0</span> to disable.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                <div className="flex-1">
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1 ml-1">Admin timeout (minutes)</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={adminSessionTimeoutMin}
                    onChange={(e) => setAdminSessionTimeoutMin(e.target.value)}
                    placeholder="e.g. 15"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>
                <button
                  onClick={saveAdminSessionTimeout}
                  disabled={savingAdminSessionTimeout}
                  className="sm:mt-5 bg-red-600 text-white font-bold py-3 px-6 rounded-xl hover:bg-red-700 transition-all disabled:opacity-50 text-sm whitespace-nowrap">
                  {savingAdminSessionTimeout ? "Saving..." : "Save"}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-3">
                Current: {Number(adminSessionTimeoutMin) > 0 ? `${adminSessionTimeoutMin} min auto-logout` : "Disabled — admin sessions never expire"}
              </p>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-red-50 p-1.5 rounded-lg"><Send className="w-4 h-4 text-red-600" /></div>
                ipwho.is provider
              </h2>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-800">Enable ipwho.is for login location</p>
                  <p className="text-xs text-slate-500 mt-1">When OFF, ipwho.is is not called at all — no IP goes to ipwho.is and the extra ipwho.is Telegram dump is not sent. Other providers (ipapi.co, ip-api.com, ipinfo.io, freeipapi.com) and device GPS still work.</p>
                </div>
                <button onClick={toggleIpwhoAlert} disabled={savingIpwho}
                  className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${ipwhoAlertEnabled ? "bg-green-500" : "bg-slate-300"}`}>
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${ipwhoAlertEnabled ? "translate-x-6" : "translate-x-0.5"}`} />
                </button>
              </div>
            </section>

            {/* --- Cloudflare R2 Storage (for notification images) --- */}
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <div className="flex items-start justify-between gap-4 mb-4">
                <h2 className="font-black text-base sm:text-lg flex items-center gap-2 text-slate-900">
                  <div className="bg-orange-50 p-1.5 rounded-lg"><HardDrive className="w-4 h-4 text-orange-600" /></div>
                  Cloudflare R2 Storage
                </h2>
                <label className="inline-flex items-center gap-2 cursor-pointer flex-shrink-0">
                  <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">{r2Cfg.enabled ? "Enabled" : "Disabled"}</span>
                  <button
                    type="button"
                    onClick={() => updateR2Cfg({ enabled: !r2Cfg.enabled })}
                    className={`relative w-12 h-6 rounded-full transition-colors ${r2Cfg.enabled ? "bg-green-500" : "bg-slate-300"}`}
                    aria-label="Toggle R2 enabled"
                  >
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${r2Cfg.enabled ? "translate-x-6" : "translate-x-0.5"}`} />
                  </button>
                </label>
              </div>
              <p className="text-xs text-slate-500 mb-4">
                Where notification hero images live. Admins can view and edit every R2 value here; the app uses exactly what is saved, with no hardcoded fallback.
                When disabled, admins can still paste an https image URL manually.
              </p>

              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Account ID</label>
                    <input value={r2Cfg.accountId} onChange={(e) => updateR2Cfg({ accountId: e.target.value })}
                      placeholder="abcdef1234567890"
                      className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900 font-mono" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Bucket</label>
                    <input value={r2Cfg.bucket} onChange={(e) => updateR2Cfg({ bucket: e.target.value })}
                      placeholder="notification-media"
                      className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900 font-mono" />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Access Key ID</label>
                  <input value={r2Cfg.accessKeyId} onChange={(e) => updateR2Cfg({ accessKeyId: e.target.value })}
                    placeholder="R2 API token — Access Key ID"
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900 font-mono" />
                </div>
                <div>
                  <label className="flex items-center justify-between text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                    <span>Secret Access Key {r2Cfg.secretAccessKeySet && (
                      <span className="ml-2 text-emerald-600 normal-case tracking-normal">✓ configured</span>
                    )}</span>
                  </label>
                  <input type="text" value={r2Cfg.secretAccessKey}
                    onChange={(e) => updateR2Cfg({ secretAccessKey: e.target.value })}
                    placeholder="Paste secret access key"
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900 font-mono" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Public Base URL</label>
                    <input value={r2Cfg.publicBaseUrl} onChange={(e) => updateR2Cfg({ publicBaseUrl: e.target.value })}
                      placeholder="https://cdn.example.com  (or  https://pub-xxx.r2.dev)"
                      className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                    <p className="text-[10.5px] text-slate-400 mt-1">Custom domain, or the r2.dev URL enabled on the bucket.</p>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Path Prefix</label>
                    <input value={r2Cfg.pathPrefix} onChange={(e) => updateR2Cfg({ pathPrefix: e.target.value })}
                      placeholder="notifications/"
                      className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900 font-mono" />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-2">
                  <button onClick={saveR2Config} disabled={r2Saving}
                    className="bg-orange-600 hover:bg-orange-700 disabled:opacity-60 text-white font-bold py-2.5 px-5 rounded-lg text-sm inline-flex items-center gap-2">
                    <HardDrive className="w-4 h-4" /> {r2Saving ? "Saving…" : "Save R2 Settings"}
                  </button>
                  <button onClick={testR2Connection} disabled={r2Testing || (!r2Cfg.accountId || !r2Cfg.accessKeyId || !r2Cfg.bucket || (!r2Cfg.secretAccessKey && !r2Cfg.secretAccessKeySet))}
                    className="bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white font-bold py-2.5 px-5 rounded-lg text-sm inline-flex items-center gap-2">
                    <Zap className="w-4 h-4" /> {r2Testing ? "Testing…" : "Test Typed Values"}
                  </button>
                </div>

                {r2TestResult && (
                  <div className={`mt-2 p-3 rounded-lg text-xs border ${r2TestResult.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-800"}`}>
                    <div className="font-bold flex items-center gap-2">
                      {r2TestResult.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                      {r2TestResult.ok ? "Typed R2 values valid" : "R2 test failed"}
                      {typeof r2TestResult.latencyMs === "number" && <span className="font-normal opacity-70">· {r2TestResult.latencyMs}ms</span>}
                    </div>
                    <div className="mt-1 opacity-90 break-words">{r2TestResult.message}</div>
                    {Array.isArray(r2TestResult.warnings) && r2TestResult.warnings.length > 0 && (
                      <ul className="mt-2 list-disc pl-4 space-y-1 text-amber-700">
                        {r2TestResult.warnings.map((warning, idx) => <li key={idx}>{warning}</li>)}
                      </ul>
                    )}
                    {r2TestResult.ok && r2TestResult.publicUrlWorks === false && (
                      <div className="mt-1 text-amber-700">⚠️ Upload signed OK but the public URL was not reachable — check your public domain / r2.dev setup and CORS.</div>
                    )}
                  </div>
                )}

                <details className="mt-2 text-xs text-slate-600">
                  <summary className="cursor-pointer font-semibold text-slate-700">Setup help — R2 API token permissions & CORS</summary>
                  <div className="mt-2 space-y-2 pl-2">
                    <p><span className="font-semibold">API token:</span> Cloudflare dashboard → R2 → Manage R2 API Tokens → Create with <span className="font-mono bg-slate-100 px-1 rounded">Object Read &amp; Write</span> scoped to this bucket.</p>
                    <p><span className="font-semibold">Public access:</span> Either connect a custom domain to the bucket, or turn on the r2.dev subdomain (Settings → Public access). Paste that URL as "Public Base URL".</p>
                    <p><span className="font-semibold">CORS (for image display in the browser):</span></p>
                    <pre className="bg-slate-900 text-slate-100 p-3 rounded-lg overflow-x-auto text-[11px]">{`[{"AllowedOrigins":["*"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]`}</pre>
                    <p className="text-slate-500">Uploads are signed server-side (via edge function) so browser CORS is only needed for GET/HEAD when displaying the images.</p>
                  </div>
                </details>
              </div>
            </section>
          </div>
        )}


        {activeTab === "logins" && (
          <LoginEventsPanel />
        )}

        {activeTab === "allmails" && (
          <AllEmailsPanel />
        )}

        {activeTab === "notifications" && (
          <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_1fr] gap-4 sm:gap-6">
            {/* --- Composer --- */}
            <section className="bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-6 sm:p-7 rounded-3xl border border-white/5 shadow-2xl relative overflow-hidden">
              <div className="absolute -top-24 -right-24 w-64 h-64 bg-orange-500/10 rounded-full blur-3xl pointer-events-none" />
              <div className="relative">
                <div className="flex items-center gap-3 mb-1">
                  <div className="bg-gradient-to-br from-orange-500 to-red-600 p-2 rounded-xl shadow-lg shadow-orange-500/20">
                    <Bell className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <h2 className="font-black text-white text-base sm:text-lg leading-tight">New Notification</h2>
                    <p className="text-[11px] text-slate-400">One card, one message. Keep it sharp.</p>
                  </div>
                </div>

                <div className="mt-5 space-y-4">
                  {/* Title + Link URL side by side */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1.5 block">Title <span className="text-orange-400">*</span></label>
                      <input value={notifTitle} onChange={(e) => setNotifTitle(e.target.value)} placeholder="e.g. Join our Telegram Group"
                        className="w-full px-3.5 py-2.5 bg-white/[0.04] border border-white/10 rounded-xl dark-input text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-orange-500/50 focus:bg-white/[0.06] transition-all" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1.5 block">Link URL</label>
                      <input value={notifActionUrl} onChange={(e) => setNotifActionUrl(e.target.value)} placeholder="https://t.me/yourchannel"
                        className="w-full px-3.5 py-2.5 bg-white/[0.04] border border-white/10 rounded-xl dark-input text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-orange-500/50 focus:bg-white/[0.06] transition-all" />
                    </div>
                  </div>

                  {/* Message */}
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1.5 block">Message <span className="text-orange-400">*</span></label>
                    <textarea value={notifBody} onChange={(e) => setNotifBody(e.target.value)} placeholder="e.g. Join our Telegram group for daily updates, free PDFs and notifications." rows={3}
                      className="w-full px-3.5 py-2.5 bg-white/[0.04] border border-white/10 rounded-xl dark-input text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-orange-500/50 focus:bg-white/[0.06] transition-all resize-none" />
                  </div>

                  {/* Notification Template (guided type) */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Notification Type</label>
                      {notifTemplate && (
                        <button type="button" onClick={() => setNotifTemplate("")} className="text-[10px] text-slate-500 hover:text-orange-400">Clear</button>
                      )}
                    </div>
                    <div className="bg-black/30 border border-white/[0.06] rounded-xl p-2">
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5 max-h-[132px] overflow-y-auto pr-1 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.15)_transparent]">
                        {TEMPLATE_OPTIONS.map((t) => {
                          const active = notifTemplate === t.id;
                          return (
                            <button key={t.id} type="button" onClick={() => setNotifTemplate(t.id)} title={t.hint}
                              className={`flex items-center gap-2 px-2 py-2 rounded-lg border transition-all min-w-0 ${active ? "border-orange-500/60 shadow-md shadow-orange-500/10" : "border-white/[0.06] hover:border-white/20"}`}
                              style={active ? { background: `linear-gradient(135deg, ${t.color}22, ${t.color}0d)` } : { background: "rgba(255,255,255,0.02)" }}>
                              <div className="w-6 h-6 rounded-md flex items-center justify-center text-white shrink-0" style={{ background: t.color }}>
                                <TemplateIcon id={t.id} className="w-3 h-3" />
                              </div>
                              <span className={`text-[10.5px] font-semibold truncate ${active ? "text-white" : "text-slate-300"}`}>{t.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Platform / Icon — scrollable container with search */}
                  <div>
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Platform / Icon</label>
                      <input value={platformSearch} onChange={(e) => setPlatformSearch(e.target.value)} placeholder="Search platform…"
                        className="w-40 px-2 py-1 bg-white/[0.04] border border-white/10 rounded-md dark-input text-[11px] text-white placeholder:text-slate-600 focus:outline-none focus:border-orange-500/50" />
                    </div>
                    <div className="bg-black/30 border border-white/[0.06] rounded-xl p-2 max-h-[240px] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.15)_transparent]">
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                        {!platformLogosReady && (
                          <div className="col-span-3 sm:col-span-4 py-8 text-center text-[11px] font-semibold text-slate-500">Loading platform logos…</div>
                        )}
                        {platformLogosReady && PLATFORM_OPTIONS.filter((p) => platformMatchesSearch(p, platformSearch)).map((p) => {
                          const active = resolvePlatformOption(notifPlatformIcon).id === p.id;
                          return (
                            <button key={p.id || "none"} type="button" onClick={() => setNotifPlatformIcon(p.id)}
                              className={`group relative flex flex-col items-center justify-center gap-1.5 py-2.5 px-1.5 rounded-lg border transition-all min-h-[74px] ${active ? "bg-orange-500/10 border-orange-500/60 shadow-md shadow-orange-500/10" : "bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.05] hover:border-white/15"}`}>
                              <PlatformChipVisual id={p.id} size={40} audit={platformLogoResults[p.id || "__custom"]} />
                              <span className={`text-[9.5px] font-medium text-center leading-tight px-0.5 line-clamp-2 ${active ? "text-white" : "text-slate-400 group-hover:text-slate-200"}`}>{p.label}</span>
                            </button>
                          );
                        })}
                      </div>
                      {platformLogosReady && PLATFORM_OPTIONS.filter((p) => platformMatchesSearch(p, platformSearch)).length === 0 && (
                        <p className="text-center text-[11px] text-slate-500 py-4">No platform matches "{platformSearch}"</p>
                      )}
                    </div>
                  </div>



                  {/* Toggles: User can delete + Audience */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                      <label className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500 block mb-2">User Can Delete?</label>
                      <button type="button" onClick={() => setNotifLocked(!notifLocked)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${!notifLocked ? "bg-emerald-500" : "bg-slate-700"}`}
                        aria-label="Allow user to delete this notification">
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${!notifLocked ? "translate-x-6" : "translate-x-1"}`} />
                      </button>
                      <span className="ml-2 text-[11px] text-slate-400">
                        {notifLocked
                          ? "🔒 Locked — user delete nahi kar sakta"
                          : "🔓 Haan, user delete kar sakta hai"}
                      </span>
                    </div>
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3">
                      <label className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-slate-500 block mb-2">Audience</label>
                      <div className="flex gap-1 text-[11px]">
                        <button type="button" onClick={() => setNotifAudience("all")}
                          className={`px-2.5 py-1 rounded-md font-semibold transition-all ${notifAudience === "all" ? "bg-white text-slate-900" : "text-slate-400 hover:text-white"}`}>All users</button>
                        <button type="button" onClick={() => setNotifAudience("user")}
                          className={`px-2.5 py-1 rounded-md font-semibold transition-all ${notifAudience === "user" ? "bg-white text-slate-900" : "text-slate-400 hover:text-white"}`}>Specific</button>
                      </div>
                    </div>
                  </div>

                  {notifAudience === "user" && (
                    <select value={notifTargetUser} onChange={(e) => setNotifTargetUser(e.target.value)}
                      className="w-full px-3.5 py-2.5 bg-white border border-white/10 rounded-xl text-sm text-slate-900 font-medium focus:outline-none focus:border-orange-500/60">
                      <option value="">— select user —</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.username}</option>)}
                    </select>
                  )}


                  {/* Advanced toggle */}
                  <details className="group">
                    <summary className="cursor-pointer text-[11px] font-semibold text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1.5 list-none">
                      <ChevronDown className="w-3.5 h-3.5 group-open:rotate-180 transition-transform" />
                      Advanced (image, CTA label, expiry)
                    </summary>
                    <div className="mt-3 space-y-3 pl-1">
                      <div>
                        <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1.5 block">Hero image URL</label>
                        <div className="flex gap-2">
                          <input value={notifImageUrl} onChange={(e) => setNotifImageUrl(e.target.value)} placeholder="https://…/image.jpg"
                            className="flex-1 px-3.5 py-2 bg-white/[0.04] border border-white/10 rounded-xl dark-input text-sm text-white placeholder:text-slate-600" />
                          <label className={`px-3 py-2 rounded-xl text-xs font-semibold cursor-pointer whitespace-nowrap transition-colors ${notifImageUploading ? "bg-white/5 text-slate-500 cursor-wait" : "bg-white text-slate-900 hover:bg-slate-200"}`}>
                            {notifImageUploading ? "Uploading…" : "Upload"}
                            <input type="file" accept="image/*" className="hidden" disabled={notifImageUploading}
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                e.currentTarget.value = "";
                                if (!file) return;
                                if (file.size > 8 * 1024 * 1024) { toast.error("Image too large (max 8 MB)"); return; }
                                setNotifImageUploading(true);
                                try {
                                  const dataBase64: string = await new Promise((resolve, reject) => {
                                    const r = new FileReader();
                                    r.onload = () => resolve(String(r.result || ""));
                                    r.onerror = () => reject(new Error("read failed"));
                                    r.readAsDataURL(file);
                                  });
                                  const res = await apiCall("manage-app", {
                                    action: "admin_upload_notification_image",
                                    filename: file.name,
                                    contentType: file.type || "image/jpeg",
                                    dataBase64,
                                  });
                                  if (res?.success && res.url) { setNotifImageUrl(res.url); toast.success("Uploaded"); }
                                  else throw new Error(res?.error || "upload failed");
                                } catch (err: any) { toast.error(err?.message || "Upload failed"); }
                                finally { setNotifImageUploading(false); }
                              }} />
                          </label>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <input value={notifActionLabel} onChange={(e) => setNotifActionLabel(e.target.value)} placeholder="CTA label (auto if empty)"
                          className="px-3.5 py-2 bg-white/[0.04] border border-white/10 rounded-xl dark-input text-sm text-white placeholder:text-slate-600" />
                        <input value={notifExpiresDays} onChange={(e) => setNotifExpiresDays(e.target.value)} placeholder="Expires (days)" type="number" min="1"
                          className="px-3.5 py-2 bg-white/[0.04] border border-white/10 rounded-xl dark-input text-sm text-white placeholder:text-slate-600" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <select value={notifPriority} onChange={(e) => setNotifPriority(e.target.value as any)}
                          className="px-3.5 py-2 bg-white border border-white/10 rounded-xl text-sm text-slate-900 font-medium capitalize focus:outline-none focus:border-orange-500/60">
                          {(["low","normal","high","critical"] as const).map(p => <option key={p} value={p} className="capitalize">{p} priority</option>)}
                        </select>
                        <select value={notifShowFrequency} onChange={(e) => setNotifShowFrequency(e.target.value as any)}
                          className="px-3.5 py-2 bg-white border border-white/10 rounded-xl text-sm text-slate-900 font-medium focus:outline-none focus:border-orange-500/60">
                          <option value="once">Show once</option>
                          <option value="session">Every session</option>
                          <option value="daily">Once per day</option>
                          <option value="always">Always until read</option>
                        </select>
                      </div>

                    </div>
                  </details>

                  <button onClick={sendNotification} disabled={sendingNotif || !notifTitle.trim() || !notifBody.trim()}
                    className="w-full mt-2 bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-400 hover:to-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 rounded-xl text-sm flex items-center justify-center gap-2 shadow-lg shadow-orange-500/25 transition-all">
                    <Send className="w-4 h-4" /> {sendingNotif ? "Publishing…" : "Publish Notification"}
                  </button>
                </div>
              </div>
            </section>


            {/* --- Live preview + Past notifications --- */}
            <div className="space-y-4 sm:space-y-6">
              <section className="rounded-2xl overflow-hidden border shadow-sm" style={{ background: "linear-gradient(180deg,#111 0%,#1a1a1c 100%)" }}>
                <div className="px-4 py-2.5 flex items-center justify-between border-b border-white/[0.06]">
                  <span className="text-[10.5px] uppercase tracking-[0.16em] text-zinc-400 font-medium">Live Preview</span>
                  <span className="text-[10px] text-zinc-500">how users will see it</span>
                </div>
                <div className="p-5">
                  <div className="rounded-2xl overflow-hidden mx-auto max-w-[400px]" style={{
                    background: "rgba(14,14,17,0.92)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    boxShadow: "0 20px 50px -10px rgba(0,0,0,0.6)",
                  }}>
                    <div className={`h-[3px] ${notifPriority === "critical" ? "bg-rose-500" : notifPriority === "high" ? "bg-amber-500" : notifPriority === "normal" ? "bg-sky-500" : "bg-zinc-500"}`} />
                    {notifImageUrl && (
                      <div className="aspect-[16/9] w-full bg-zinc-900 overflow-hidden">
                        <img src={notifImageUrl} referrerPolicy="no-referrer" className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                      </div>
                    )}
                    <div className="p-5">
                      <span className="text-[10px] uppercase tracking-[0.14em] text-zinc-400 font-medium capitalize">{notifCategory}</span>
                      <h3 className="text-white text-[19px] leading-tight mt-2 mb-2" style={{ fontFamily: "'Instrument Serif', ui-serif, Georgia, serif", letterSpacing: "-0.015em" }}>
                        {notifTitle || "Your title here"}
                      </h3>
                      <p className="text-zinc-300 text-[13px] leading-relaxed font-light">{notifBody || "Short body text preview…"}</p>
                      {notifDescription && <p className="mt-2 text-zinc-500 text-[12px] leading-relaxed font-light line-clamp-3">{notifDescription}</p>}
                      {(notifActionLabel || notifActionUrl) && (
                        <div className="mt-4 py-2 px-4 rounded-xl bg-white text-black text-center text-[13px] font-semibold">
                          {notifActionLabel || "CTA"}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-black text-base sm:text-lg flex items-center gap-2">
                    <div className="bg-slate-100 p-1.5 rounded-lg"><MessageSquare className="w-4 h-4 text-slate-700" /></div>
                    Past Notifications
                    <span className="text-[11px] font-semibold text-slate-400">({adminNotifs.length})</span>
                  </h2>
                  <button onClick={reloadAdminNotifs} className="text-[11px] font-semibold text-slate-500 hover:text-slate-900 flex items-center gap-1">
                    <RefreshCw className="w-3 h-3" /> Refresh
                  </button>
                </div>
                <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                  {adminNotifs.length === 0 && <p className="text-sm text-slate-500">No notifications yet.</p>}
                  {adminNotifs.map((n) => (
                    <div key={n.id} className="border-2 rounded-2xl p-4 hover:border-slate-300 hover:shadow-md transition-all group bg-white">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                            {n.platform_icon ? <PlatformChipVisual id={n.platform_icon} size={20} audit={platformLogoResults[resolvePlatformOption(n.platform_icon).id || "__custom"]} /> : null}
                            <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold ${n.locked ? "bg-amber-50 text-amber-700 border border-amber-200" : "bg-emerald-50 text-emerald-700 border border-emerald-200"}`}>
                              {n.locked ? "🔒 Locked" : "🔓 User delete OK"}
                            </span>
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 capitalize font-medium">{n.category || "announcement"}</span>
                            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold capitalize ${n.priority === "critical" ? "text-rose-600" : n.priority === "high" ? "text-amber-600" : n.priority === "normal" ? "text-sky-600" : "text-zinc-500"}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${n.priority === "critical" ? "bg-rose-500" : n.priority === "high" ? "bg-amber-500" : n.priority === "normal" ? "bg-sky-500" : "bg-zinc-400"}`} />
                              {n.priority || "low"}
                            </span>
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium">
                              {n.audience === "all" ? `👥 Sabko (${n.totalRecipients || 0})` : "👤 Ek user ko"}
                            </span>
                          </div>
                          <p className="font-black text-[15px] text-slate-900 truncate">{n.title}</p>
                          <p className="text-xs text-slate-600 line-clamp-2 mt-0.5">{n.body}</p>
                          <div className="flex items-center gap-3 mt-2 flex-wrap text-[11px] font-semibold">
                            <span className="inline-flex items-center gap-1 text-slate-600">👀 {n.seenCount || 0} <span className="text-slate-400 font-normal">seen</span></span>
                            <span className="inline-flex items-center gap-1 text-emerald-700">✅ {n.readCount || 0} <span className="text-slate-400 font-normal">read</span></span>
                            <span className="inline-flex items-center gap-1 text-sky-700">🖱 {n.clickCount || 0} <span className="text-slate-400 font-normal">clicked</span></span>
                            <span className="inline-flex items-center gap-1 text-rose-600">🗑 {n.deletedCount || 0} <span className="text-slate-400 font-normal">deleted</span></span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-slate-100">
                        <button onClick={() => setRecipientsFor(n)} className="flex-1 min-h-[40px] px-3 py-2 rounded-lg text-[12px] font-bold text-white bg-slate-900 hover:bg-slate-800 flex items-center justify-center gap-1.5">
                          <Users className="w-3.5 h-3.5" /> Recipients
                        </button>
                        <button onClick={() => setEditingNotif({ ...n })} className="flex-1 min-h-[40px] px-3 py-2 rounded-lg text-[12px] font-semibold text-slate-700 hover:bg-slate-100 border border-slate-200 flex items-center justify-center gap-1.5">
                          <Edit className="w-3.5 h-3.5" /> Edit
                        </button>
                        <button onClick={() => duplicateToComposer(n)} className="min-h-[40px] px-3 py-2 rounded-lg text-[12px] font-semibold text-slate-700 hover:bg-slate-100 border border-slate-200 flex items-center justify-center gap-1.5" title="Duplicate">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteNotification(n.id)} className="min-h-[40px] px-3 py-2 rounded-lg text-[12px] font-semibold text-red-600 hover:bg-red-50 border border-red-200 flex items-center justify-center gap-1.5" title="Delete for everyone">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        )}

        {editingNotif && createPortal(
          <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => !savingEditNotif && setEditingNotif(null)}>
            <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="p-5 border-b flex items-center justify-between">
                <h3 className="font-black text-base flex items-center gap-2 text-slate-900"><Edit className="w-4 h-4" /> Edit Notification</h3>
                <button onClick={() => setEditingNotif(null)} className="text-slate-400 hover:text-slate-900" disabled={savingEditNotif}><X className="w-5 h-5" /></button>
              </div>
              <div className="p-5 space-y-3">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Title</label>
                  <input value={editingNotif.title || ""} onChange={(e) => setEditingNotif({ ...editingNotif, title: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Message</label>
                  <textarea value={editingNotif.body || ""} onChange={(e) => setEditingNotif({ ...editingNotif, body: e.target.value })} rows={3}
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Link URL</label>
                  <input value={editingNotif.action_url || ""} onChange={(e) => setEditingNotif({ ...editingNotif, action_url: e.target.value })} placeholder="https://…"
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5 block">Platform / Icon</label>
                  <div className="grid grid-cols-5 gap-1.5">
                    {!platformLogosReady && (
                      <div className="col-span-5 py-6 text-center text-[11px] font-semibold text-slate-500">Loading platform logos…</div>
                    )}
                    {platformLogosReady && PLATFORM_OPTIONS.map((p) => {
                      const active = resolvePlatformOption(editingNotif.platform_icon).id === p.id;
                      return (
                        <button key={p.id || "none"} type="button" onClick={() => setEditingNotif({ ...editingNotif, platform_icon: p.id })}
                          className={`flex flex-col items-center gap-1.5 py-2.5 px-1 rounded-lg border transition-all ${active ? "border-orange-500 bg-orange-50" : "border-slate-200 hover:border-slate-300"}`}>
                          <PlatformChipVisual id={p.id} size={40} audit={platformLogoResults[p.id || "__custom"]} />
                          <span className="text-[9px] font-medium text-slate-600 text-center leading-tight">{p.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Priority</label>
                    <select value={editingNotif.priority || "normal"} onChange={(e) => setEditingNotif({ ...editingNotif, priority: e.target.value })}
                      className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900 capitalize">
                      {["low","normal","high","critical"].map(p => <option key={p} value={p} className="capitalize">{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Audience</label>
                    <select value={editingNotif.audience || "all"} onChange={(e) => setEditingNotif({ ...editingNotif, audience: e.target.value })}
                      className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900">
                      <option value="all">All users</option>
                      <option value="user">Specific user</option>
                    </select>
                  </div>
                </div>
                {editingNotif.audience === "user" && (
                  <select value={editingNotif.target_user_id || ""} onChange={(e) => setEditingNotif({ ...editingNotif, target_user_id: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900">
                    <option value="">— select user —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.username}</option>)}
                  </select>
                )}
                <div className={`rounded-xl p-3 border-2 ${!editingNotif.locked ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={!editingNotif.locked} onChange={(e) => setEditingNotif({ ...editingNotif, locked: !e.target.checked })} className="mt-1 w-4 h-4" />
                    <div className="flex-1">
                      <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                        {!editingNotif.locked ? "🔓 User is notification ko delete kar sakta hai" : "🔒 Locked — user delete nahi kar sakta"}
                      </div>
                      <div className="text-[11px] text-slate-600 mt-0.5">
                        {!editingNotif.locked
                          ? "User ke notification panel me delete/close button dikhega."
                          : "User na dismiss kar sakta, na delete. Sirf admin hata sakta."}
                      </div>
                    </div>
                  </label>
                </div>
              </div>
              <div className="p-5 border-t flex items-center gap-2 bg-slate-50 rounded-b-2xl">
                <button onClick={() => setEditingNotif(null)} disabled={savingEditNotif} className="flex-1 px-4 py-2.5 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-white">Cancel</button>
                <button onClick={saveEditNotif} disabled={savingEditNotif} className="flex-1 px-4 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-60">
                  {savingEditNotif ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

        {recipientsFor && createPortal(
          <RecipientsDrawer notification={recipientsFor} onClose={() => setRecipientsFor(null)} onChanged={reloadAdminNotifs} />,
          document.body,
        )}





        {activeTab === "inbox" && (
          <div className="max-w-2xl">
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-red-50 p-1.5 rounded-lg"><Trash2 className="w-4 h-4 text-red-600" /></div>
                Clear Cached Inbox
              </h2>
              <p className="text-xs text-slate-500 mb-4">Permanently deletes from <code>cached_emails</code>. This affects every user.</p>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3 text-sm">
                  <label className="flex items-center gap-2 text-slate-800">
                    <input type="radio" checked={inboxMode === "days"} onChange={() => setInboxMode("days")} /> Older than N days
                  </label>
                  <label className="flex items-center gap-2 text-slate-800">
                    <input type="radio" checked={inboxMode === "label"} onChange={() => setInboxMode("label")} /> By account label
                  </label>
                  <label className="flex items-center gap-2 text-slate-800">
                    <input type="radio" checked={inboxMode === "all"} onChange={() => setInboxMode("all")} /> ALL emails
                  </label>
                </div>
                {inboxMode === "days" && (
                  <input value={inboxDays} onChange={(e) => setInboxDays(e.target.value)} type="number" min="1" placeholder="Days"
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                )}
                {inboxMode === "label" && (
                  <select value={inboxLabel} onChange={(e) => setInboxLabel(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900">
                    <option value="">— select account —</option>
                    {emailAccounts.map((a) => <option key={a.label} value={a.label}>{a.label}</option>)}
                  </select>
                )}
                {inboxMode === "all" && (
                  <input value={inboxConfirm} onChange={(e) => setInboxConfirm(e.target.value)} placeholder='Type DELETE ALL to confirm'
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                )}
                <button onClick={adminClearInbox} disabled={clearingInbox}
                  className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white font-bold py-2.5 rounded-lg text-sm flex items-center justify-center gap-2">
                  <Trash2 className="w-4 h-4" /> {clearingInbox ? "Deleting…" : "Delete now"}
                </button>
              </div>
            </section>
          </div>
        )}



        {activeTab === "emails" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-green-50 p-1.5 rounded-lg"><Plus className="w-4 h-4 text-green-600" /></div>
                Add Email Account
              </h2>
              <div className="space-y-3">
                <input type="text" placeholder="Account Label (e.g. Gmail Main)" value={newAccount.label} onChange={(e) => setNewAccount({ ...newAccount, label: e.target.value })}
                  className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                <div className="grid grid-cols-2 gap-2">
                  <input type="text" placeholder="IMAP Host" value={newAccount.host} onChange={(e) => setNewAccount({ ...newAccount, host: e.target.value })}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                  <input type="text" placeholder="Port" value={newAccount.port} onChange={(e) => setNewAccount({ ...newAccount, port: e.target.value })}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
                <input type="text" placeholder="Email Address" value={newAccount.user} onChange={(e) => setNewAccount({ ...newAccount, user: e.target.value })}
                  className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                <PasswordInput value={newAccount.password} onChange={(e) => setNewAccount({ ...newAccount, password: e.target.value })}
                  placeholder="App Password"
                  className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />

                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Cloudflare Worker URLs</label>
                  <p className="text-[10px] text-slate-400 mb-2 ml-1">Assign dedicated Cloudflare Worker URLs to this account. Emails for this account will be fetched through these workers. If none are added, primary workers will be used. Multiple URLs are load-balanced randomly.</p>
                  <div className="space-y-1.5 mb-2">
                    {newAccountCfUrls.map((url, i) => (
                      <div key={i} className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg border">
                        <Globe className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                        <span className="text-xs text-slate-700 flex-1 break-all">{url}</span>
                        <button onClick={() => setNewAccountCfUrls(newAccountCfUrls.filter((_, idx) => idx !== i))}
                          className="p-1 hover:bg-red-50 text-red-400 hover:text-red-600 rounded transition-colors">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input type="text" placeholder="https://worker.workers.dev" value={newAccountCfInput}
                      onChange={(e) => setNewAccountCfInput(e.target.value)}
                      className="flex-1 bg-slate-50 border rounded-lg p-2 outline-none focus:ring-2 focus:ring-red-500 text-xs" />
                    <button onClick={() => {
                      if (!newAccountCfInput.trim()) return;
                      setNewAccountCfUrls([...newAccountCfUrls, newAccountCfInput.trim().replace(/\/+$/, "")]);
                      setNewAccountCfInput("");
                    }} className="px-3 py-1.5 bg-slate-800 text-white text-xs font-bold rounded-lg hover:bg-slate-700">
                      Add
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">Add multiple worker URLs for redundancy</p>
                </div>

                <button onClick={addEmailAccount}
                  className="w-full bg-slate-900 text-white font-bold py-3 rounded-xl hover:bg-slate-800 transition-all text-sm">
                  Add Account
                </button>
              </div>
            </section>

            <section className="lg:col-span-2 bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-blue-50 p-1.5 rounded-lg"><Mail className="w-4 h-4 text-blue-600" /></div>
                Connected Accounts
                <span className="bg-slate-100 text-slate-600 text-xs px-2 py-0.5 rounded-full ml-auto">{emailAccounts.length + 1}</span>
              </h2>

              <div
                className={`p-4 rounded-2xl border mb-3 cursor-pointer transition-all ${expandedAccount === -1 ? "bg-green-100 border-green-300 shadow-md" : "bg-green-50 border-green-100 hover:border-green-200"}`}
                onClick={() => setExpandedAccount(expandedAccount === -1 ? null : -1)}
              >
                <div className="flex items-center gap-3">
                  <div className="bg-green-200 p-2 rounded-xl">
                    <Server className="w-4 h-4 text-green-700" />
                  </div>
                  <div className="flex-1">
                    <p className="font-bold text-sm text-green-900">Primary</p>
                    <p className="text-xs text-green-700">{serverConfig.IMAP_USER || "Configure in Settings tab"} • {serverConfig.IMAP_HOST || "imap.gmail.com"}:{serverConfig.IMAP_PORT || "993"}</p>
                  </div>
                  <Eye className={`w-4 h-4 transition-transform ${expandedAccount === -1 ? "text-green-700" : "text-green-400"}`} />
                </div>
                {expandedAccount === -1 && (
                  <div className="mt-4 pt-3 border-t border-green-200 space-y-2">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[10px] font-bold text-green-600 uppercase">Host</p>
                        <p className="text-sm text-green-900 font-medium">{serverConfig.IMAP_HOST || "Not set"}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-green-600 uppercase">Port</p>
                        <p className="text-sm text-green-900 font-medium">{serverConfig.IMAP_PORT || "Not set"}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-green-600 uppercase">Email</p>
                        <p className="text-sm text-green-900 font-medium">{serverConfig.IMAP_USER || "Not set"}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-green-600 uppercase">Password</p>
                        <p className="text-sm text-green-900 font-medium">{serverConfig.IMAP_PASSWORD ? "••••••••" : "Not set"}</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-green-600 uppercase">Cloudflare Worker URLs</p>
                      {primaryCfUrls.length > 0 ? (
                        <div className="space-y-1 mt-1">
                          {primaryCfUrls.map((url, ui) => (
                            <p key={ui} className="text-sm text-green-900 font-medium break-all">• {url}</p>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-green-700 font-medium">Not configured — add in Settings tab</p>
                      )}
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-green-600 uppercase">Configured via</p>
                      <p className="text-sm text-green-900 font-medium">Settings tab</p>
                    </div>
                  </div>
                )}
              </div>

              {emailAccounts.length === 0 ? (
                <p className="text-slate-400 text-sm text-center py-6">No additional accounts. Add one from the left panel.</p>
              ) : (
                <div className="space-y-3">
                  {emailAccounts.map((acc, i) => (
                    <div key={i}
                      className={`p-4 rounded-2xl border cursor-pointer transition-all ${expandedAccount === i ? "bg-blue-50 border-blue-200 shadow-md" : "bg-slate-50 border-slate-100 hover:border-slate-200"}`}
                      onClick={() => setExpandedAccount(expandedAccount === i ? null : i)}
                    >
                      <div className="flex items-center gap-3">
                        <div className="bg-blue-100 p-2 rounded-xl">
                          <Mail className="w-4 h-4 text-blue-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-sm text-slate-900">{acc.label}</p>
                          <p className="text-xs text-slate-500 truncate">{acc.user} • {acc.host}:{acc.port}</p>
                          {acc.cloudflareUrls && acc.cloudflareUrls.length > 0 && (
                            <p className="text-[10px] text-orange-600 font-bold mt-0.5">{acc.cloudflareUrls.length} Worker URL{acc.cloudflareUrls.length > 1 ? "s" : ""}</p>
                          )}
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); removeEmailAccount(i); }}
                          className="p-2 hover:bg-red-50 text-red-400 hover:text-red-600 rounded-lg transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      {expandedAccount === i && (
                        <div className="mt-4 pt-3 border-t border-blue-200 space-y-2">
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <p className="text-[10px] font-bold text-blue-500 uppercase">Host</p>
                              <p className="text-sm text-slate-800 font-medium">{acc.host}</p>
                            </div>
                            <div>
                              <p className="text-[10px] font-bold text-blue-500 uppercase">Port</p>
                              <p className="text-sm text-slate-800 font-medium">{acc.port}</p>
                            </div>
                            <div>
                              <p className="text-[10px] font-bold text-blue-500 uppercase">Email</p>
                              <p className="text-sm text-slate-800 font-medium">{acc.user}</p>
                            </div>
                            <div>
                              <p className="text-[10px] font-bold text-blue-500 uppercase">Password</p>
                              <p className="text-sm text-slate-800 font-medium">{acc.password ? "••••••••" : "Not set"}</p>
                            </div>
                          </div>
                          <div>
                            <div className="flex items-center justify-between">
                              <p className="text-[10px] font-bold text-blue-500 uppercase">Cloudflare Worker URLs</p>
                              <button onClick={(e) => {
                                e.stopPropagation();
                                if (editingAccountUrls === i) {
                                  setEditingAccountUrls(null);
                                } else {
                                  setEditingAccountUrls(i);
                                  setEditCfUrls([...(acc.cloudflareUrls || [])]);
                                  setEditCfInput("");
                                }
                              }} className="text-[10px] font-bold text-blue-600 hover:text-blue-800 transition-colors">
                                {editingAccountUrls === i ? "Cancel" : "Edit URLs"}
                              </button>
                            </div>
                            {editingAccountUrls === i ? (
                              <div className="mt-1 space-y-1.5">
                                {editCfUrls.map((url, ui) => (
                                  <div key={ui} className="flex items-center gap-2 p-1.5 bg-white rounded-lg border">
                                    <Globe className="w-3 h-3 text-slate-400 flex-shrink-0" />
                                    <span className="text-xs text-slate-700 flex-1 break-all">{url}</span>
                                    <button onClick={(e) => { e.stopPropagation(); setEditCfUrls(editCfUrls.filter((_, idx) => idx !== ui)); }}
                                      className="p-0.5 hover:bg-red-50 text-red-400 hover:text-red-600 rounded transition-colors">
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                ))}
                                <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                                  <input type="text" placeholder="https://worker.workers.dev" value={editCfInput}
                                    onChange={(e) => setEditCfInput(e.target.value)}
                                    className="flex-1 bg-white border rounded-lg p-1.5 outline-none focus:ring-2 focus:ring-blue-500 text-xs" />
                                  <button onClick={() => {
                                    if (!editCfInput.trim()) return;
                                    setEditCfUrls([...editCfUrls, editCfInput.trim().replace(/\/+$/, "")]);
                                    setEditCfInput("");
                                  }} className="px-2 py-1 bg-slate-800 text-white text-[10px] font-bold rounded-lg hover:bg-slate-700">
                                    Add
                                  </button>
                                </div>
                                <button onClick={async (e) => {
                                  e.stopPropagation();
                                  const updated = [...emailAccounts];
                                  updated[i] = { ...updated[i], cloudflareUrls: [...editCfUrls] };
                                  setEmailAccounts(updated);
                                  setEditingAccountUrls(null);
                                  try {
                                    await apiCall("manage-app", { action: "set_settings", key: "email_accounts", value: updated });
                                    toast.success("Worker URLs updated!");
                                  } catch (err) {
                                    toast.error(err instanceof Error ? err.message : "Failed to save URLs");
                                  }
                                }} className="w-full bg-blue-600 text-white text-xs font-bold py-1.5 rounded-lg hover:bg-blue-700 transition-all">
                                  Save URLs
                                </button>
                              </div>
                            ) : acc.cloudflareUrls && acc.cloudflareUrls.length > 0 ? (
                              <div className="space-y-1 mt-1">
                                {acc.cloudflareUrls.map((url, ui) => (
                                  <p key={ui} className="text-sm text-slate-800 font-medium break-all">• {url}</p>
                                ))}
                              </div>
                            ) : (
                              <p className="text-sm text-slate-400 font-medium">Not configured — click Edit URLs to add</p>
                            )}
                          </div>
                          <div>
                            <p className="text-[10px] font-bold text-blue-500 uppercase">Label</p>
                            <p className="text-sm text-slate-800 font-medium">{acc.label}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === "settings" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-blue-50 p-1.5 rounded-lg"><Server className="w-4 h-4 text-blue-600" /></div>
                Telegram Notifications
              </h2>
              <p className="text-[10px] text-slate-400 mb-3">💡 Save once to persist these values</p>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Bot Token</label>
                  <PasswordInput value={serverConfig.TELEGRAM_BOT_TOKEN}
                    onChange={(e) => setServerConfig({ ...serverConfig, TELEGRAM_BOT_TOKEN: e.target.value })}
                    placeholder="e.g. 8575582532:AAE..."
                    className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Chat ID</label>
                  <input type="text" placeholder="e.g. 769748540" value={serverConfig.TELEGRAM_CHAT_ID}
                    onChange={(e) => setServerConfig({ ...serverConfig, TELEGRAM_CHAT_ID: e.target.value })}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-red-50 p-1.5 rounded-lg"><Mail className="w-4 h-4 text-red-600" /></div>
                Primary IMAP Server
              </h2>
              <p className="text-[10px] text-slate-400 mb-3">💡 Save once to persist these values</p>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Host</label>
                    <input type="text" placeholder="imap.gmail.com" value={serverConfig.IMAP_HOST}
                      onChange={(e) => setServerConfig({ ...serverConfig, IMAP_HOST: e.target.value })}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Port</label>
                    <input type="text" placeholder="993" value={serverConfig.IMAP_PORT}
                      onChange={(e) => setServerConfig({ ...serverConfig, IMAP_PORT: e.target.value })}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">IMAP Email</label>
                  <input type="text" placeholder="Email Address" value={serverConfig.IMAP_USER}
                    onChange={(e) => setServerConfig({ ...serverConfig, IMAP_USER: e.target.value })}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">App Password</label>
                  <PasswordInput value={serverConfig.IMAP_PASSWORD}
                    onChange={(e) => setServerConfig({ ...serverConfig, IMAP_PASSWORD: e.target.value })}
                    placeholder="16-digit App Password"
                    className="w-full bg-slate-50 border rounded-xl p-3 pr-12 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Cloudflare Worker URLs</label>
                  <p className="text-[10px] text-slate-400 mb-2 ml-1">These are the default/primary workers used for all accounts without dedicated workers. Add multiple URLs for random load balancing. Deploy workers using <span className="font-mono">npx wrangler deploy</span> from the <span className="font-mono">cloudflare-worker/</span> folder.</p>
                  <div className="space-y-1.5 mb-2">
                    {primaryCfUrls.map((url, i) => (
                      <div key={i} className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg border">
                        <Globe className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                        <span className="text-xs text-slate-700 flex-1 break-all">{url}</span>
                        <button onClick={() => setPrimaryCfUrls(primaryCfUrls.filter((_, idx) => idx !== i))}
                          className="p-1 hover:bg-red-50 text-red-400 hover:text-red-600 rounded transition-colors">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input type="text" placeholder="https://worker.workers.dev" value={primaryCfInput}
                      onChange={(e) => setPrimaryCfInput(e.target.value)}
                      className="flex-1 bg-slate-50 border rounded-lg p-2 outline-none focus:ring-2 focus:ring-red-500 text-xs" />
                    <button onClick={() => {
                      if (!primaryCfInput.trim()) return;
                      setPrimaryCfUrls([...primaryCfUrls, primaryCfInput.trim().replace(/\/+$/, "")]);
                      setPrimaryCfInput("");
                    }} className="px-3 py-1.5 bg-slate-800 text-white text-xs font-bold rounded-lg hover:bg-slate-700">
                      Add
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">Multiple URLs are shuffled randomly for load balancing — not sequential failover</p>
                </div>

                {/* Cloudflare Setup Guide - Mobile Friendly (No PC needed) */}
                <details className="mt-4 bg-blue-50 border border-blue-200 rounded-xl overflow-hidden">
                  <summary className="text-xs font-bold text-blue-700 cursor-pointer select-none flex items-center gap-2 p-3 active:bg-blue-100 transition-colors">
                    <Info className="w-4 h-4 flex-shrink-0" />
                    <span>📘 Cloudflare Worker Setup (No PC Needed)</span>
                  </summary>
                  <div className="px-2.5 pb-3 space-y-2">
                    <p className="text-[11px] text-blue-800 bg-blue-100 rounded-lg p-2">✅ Sab kuch phone browser se hoga — koi terminal ya PC ki zaroorat nahi!</p>

                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-black text-amber-900">🔐 SESSION_SIGNING_SECRET yahi se copy karo</p>
                          <p className="text-[11px] text-amber-800 mt-0.5">Admin login ke bina value nahi dikhegi. Cloudflare me Type hamesha <b>Secret</b> select karna, Plaintext nahi.</p>
                        </div>
                        <button
                          type="button"
                          onClick={revealSigningSecret}
                          disabled={revealingSigningSecret}
                          className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-[11px] font-black text-white hover:bg-slate-800 disabled:opacity-60"
                        >
                          {revealingSigningSecret ? "Opening..." : signingSecretReveal ? "Reveal again" : "Reveal"}
                        </button>
                      </div>
                      {signingSecretReveal && (
                        <div className="rounded-lg border border-amber-300 bg-white p-2">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-[10px] font-black uppercase text-amber-700">Verified · {signingSecretReveal.length} chars · {signingSecretReveal.source}</span>
                            <button type="button" onClick={copySigningSecret} className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-[10px] font-black text-amber-900 hover:bg-amber-200">
                              <Copy className="w-3 h-3" /> Copy fingerprint
                            </button>
                          </div>
                          <code className="block break-all rounded-md bg-slate-950 p-2 text-[11px] leading-relaxed text-amber-100">fp: {signingSecretReveal.fingerprint}</code>
                          <p className="mt-2 text-[10px] leading-snug text-amber-800">
                            🔒 For security, the raw signing secret is never returned by the API. Copy it from
                            <strong> Supabase Dashboard → Edge Functions → Secrets → SESSION_SIGNING_SECRET</strong>.
                            The fingerprint above lets you confirm both sides match after rotation.
                          </p>
                        </div>
                      )}
                    </div>

                    {[
                      {
                        step: "1",
                        title: "Cloudflare Account Banao (2 min)",
                        points: [
                          "Browser me naya tab kholo → address bar me type karo: dash.cloudflare.com",
                          "Right side upar 'Sign Up' button dabao",
                          "Apna email + strong password daalo → 'Create Account'",
                          "Cloudflare tere email pe verification link bhejega — Gmail kholo, us link pe click karo",
                          "Verify hone ke baad wapas dash.cloudflare.com pe login karo",
                          "Home page khulega jisme left side ek sidebar dikhega",
                        ],
                      },
                      {
                        step: "2",
                        title: "Worker Create Karo (3 min)",
                        points: [
                          "Left sidebar me neeche scroll karo → 'Compute (Workers)' dhundo",
                          "Uske andar 'Workers & Pages' pe click karo",
                          "Right side blue button 'Create' pe dabao",
                          "Options aayenge — 'Start with Hello World' select karo → 'Get started' dabao",
                          "Worker ka naam do: netflixfetch (ya kuch bhi lowercase, no spaces)",
                          "Neeche 'Deploy' button dabao",
                          "10 second wait karo — 'Success!' message aayega",
                          "'Continue to project' ya 'Edit code' button dikhega",
                        ],
                      },
                      {
                        step: "3",
                        title: "Worker Code Paste Karo (5 min)",
                        points: [
                          "'Edit code' pe click karo — code editor khulega browser me hi",
                          "Left side ek file dikhegi 'worker.js' — usme default 'Hello World' code hai",
                          "Poore code pe click karo → Ctrl+A (ya mobile pe long-press → Select All) → Delete",
                          "",
                          "📥 Ab tereko project ka worker code chahiye:",
                          "→ Lovable me left side 'Code' icon pe click karo (ya GitHub repo kholo)",
                          "→ Folder: cloudflare-worker/worker.js file kholo",
                          "→ Poora code Ctrl+A → Copy karo",
                          "",
                          "Cloudflare editor me wapas jao → khali jagah pe Paste karo",
                          "Upar right side 'Deploy' button dabao",
                          "'Deploy' confirmation aayega — dabao",
                          "✅ Green 'Deployed successfully' message aayega",
                        ],
                      },
                      {
                        step: "4",
                        title: "KV Storage Banao (Email Cache ke liye) — 3 min",
                        points: [
                          "Upar left me '← Workers & Pages' pe click karke wapas jao",
                          "Top pe tabs dikhenge: Overview | KV | R2 | D1 | Queues...",
                          "'KV' tab pe click karo",
                          "Blue button 'Create instance' (ya '+ Create') dabao",
                          "Namespace name: EMAIL_CACHE (exact same, capital letters)",
                          "'Add' dabao — namespace ban jayega",
                          "",
                          "🔗 Ab is KV ko Worker se connect karna hai:",
                          "→ 'Workers & Pages' pe wapas jao",
                          "→ Apna worker (netflixfetch) pe click karo",
                          "→ Top tabs me 'Settings' pe click karo",
                          "→ Left sub-menu me 'Bindings' pe click karo",
                          "→ '+ Add' button → 'KV Namespace' select karo",
                          "→ Variable name: EMAIL_CACHE",
                          "→ KV namespace dropdown me: EMAIL_CACHE select karo",
                          "→ 'Deploy' dabao",
                        ],
                      },
                      {
                        step: "5-A",
                        title: "🔓 Pehle: SESSION_SIGNING_SECRET ki value nikaalo",
                        points: [
                          "Ye value tera password jaisa hai — Cloudflare ko dena hai taki dono milke session verify kar sakein.",
                          "",
                          "📱 SIMPLE TAREEKA (admin panel se, 10 second):",
                          "1. Isi blue guide ke upar yellow box me 'Reveal' button dabao",
                          "2. Neeche black box me long value dikhegi",
                          "3. 'Copy' dabao — wahi SESSION_SIGNING_SECRET value hai",
                          "4. Cloudflare me SECRET #3 ke Value field me paste karo",
                          "",
                          "Agar copy fail ho jaye: black box pe long press/drag karke manually select karke copy karo.",
                        ],
                        warning: "🔒 Ye admin-only reveal hai. Value kisi ko bhi mat dena — Telegram/WhatsApp pe bhi nahi bhejna.",
                      },
                      {
                        step: "5-B",
                        title: "4 Secrets Cloudflare Worker me Add Karo",
                        points: [
                          "Worker page → 'Settings' tab → left sub-menu me 'Variables and Secrets'",
                          "Right side '+ Add' button dabao",
                          "",
                          "⚙️ HAR SECRET ke liye ye 3 cheezein bharni hain:",
                          "   • Type: dropdown se 'Secret' select karo (Plaintext NAHI)",
                          "   • Variable name: (neeche list se copy karo, EXACT same spelling)",
                          "   • Value: (neeche list se copy karo)",
                          "   • Fir 'Deploy' dabao — har secret ke baad ek baar",
                          "",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "🔑 SECRET #1",
                          "Name: SUPABASE_URL",
                          "Value: https://jsqchutnfdeljajkxmly.supabase.co",
                          "(Ye tera Supabase project URL hai — already known)",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "🔑 SECRET #2",
                          "Name: SUPABASE_KEY",
                          "Value kaha se milega:",
                          "  → supabase.com/dashboard kholo",
                          "  → Apna project (jsqchutnfdeljajkxmly) select karo",
                          "  → Left sidebar niche gear icon 'Project Settings'",
                          "  → 'API Keys' section pe click",
                          "  → 'anon' 'public' row me lambi key dikhegi (eyJhbGc... se shuru)",
                          "  → 'Copy' button dabao → Cloudflare me paste",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "🔑 SECRET #3 ⭐ (MOST IMPORTANT)",
                          "Name: SESSION_SIGNING_SECRET",
                          "Value: Step 5-A me jo string copy ki thi wahi paste karo",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "🔑 SECRET #4 (backward compatibility)",
                          "Name: SESSION_SECRET",
                          "Value kaha se milega:",
                          "  → Supabase Dashboard → Project Settings → API Keys",
                          "  → NEECHE scroll karo → 'service_role' 'secret' row",
                          "  → 'Reveal' dabake copy karo (ye SUPER secret hai, kisi ko mat dena)",
                          "  → Cloudflare me paste",
                          "  Note: 24 ghante baad ye safely delete kar sakte ho",
                          "━━━━━━━━━━━━━━━━━━━━━━",
                          "",
                          "Chaaron add ho gaye? → Last 'Deploy' dabao → ✅ Done",
                        ],
                        warning: "⚠️ Spelling galat hui (jaise SUPBASE_URL) to worker fail hoga. Copy-paste karo, type mat karo.",
                      },
                      {
                        step: "6",
                        title: "Worker URL Copy Karo aur App me Daalo",
                        points: [
                          "Worker page pe wapas jao (top pe worker naam pe click)",
                          "'Overview' tab pe URL dikhega, kuch aisa:",
                          "   https://netflixfetch.YOURNAME.workers.dev",
                          "'Copy' icon dabake URL copy karo",
                          "",
                          "📲 App me daalne ke steps:",
                          "  → App me admin login karo",
                          "  → Admin Panel → 'Cloudflare Workers' section",
                          "  → 'Primary Cloudflare Worker URLs' input me paste karo",
                          "  → '+ Add' dabao",
                          "  → 'Save' dabao",
                          "",
                          "✅ Ho gaya! Ab test karo — koi email account refresh karo, emails worker se aayenge.",
                        ],
                      },
                    ].map((s) => (
                      <details key={s.step} className="bg-white rounded-lg border border-blue-100 overflow-hidden">
                        <summary className="flex items-center gap-2 p-2.5 cursor-pointer active:bg-blue-50 transition-colors">
                          <span className="bg-blue-600 text-white text-[10px] font-bold min-w-[20px] h-5 px-1 rounded-full flex items-center justify-center flex-shrink-0">{s.step}</span>
                          <span className="text-xs font-bold text-slate-800">{s.title}</span>
                        </summary>
                        <div className="px-2.5 pb-2.5">
                          <ul className="space-y-1">
                            {s.points.map((p, i) => (
                              <li key={i} className={`text-[11px] text-slate-700 ${p === "" ? "h-1" : "flex gap-1.5"}`}>
                                {p !== "" && <><span className="text-blue-400 mt-0.5 flex-shrink-0">•</span><span className="whitespace-pre-wrap break-words">{p}</span></>}
                              </li>
                            ))}
                          </ul>
                          {"warning" in s && s.warning && (
                            <p className="text-[10px] text-red-600 font-bold mt-1.5 bg-red-50 p-1.5 rounded">{s.warning}</p>
                          )}
                        </div>
                      </details>
                    ))}

                    <details className="bg-yellow-50 rounded-lg border border-yellow-200 overflow-hidden">
                      <summary className="flex items-center gap-2 p-2.5 cursor-pointer active:bg-yellow-100 transition-colors">
                        <span className="text-xs font-bold text-yellow-800">🔄 Naya Email Account / Second Cloudflare Account?</span>
                      </summary>
                      <div className="px-2.5 pb-2.5">
                        <ol className="text-[11px] text-yellow-900 space-y-1.5 ml-4 list-decimal">
                          <li>Naye Cloudflare account me login karo (ya same account me new worker banao)</li>
                          <li>Step 2 se 6 repeat karo — worker ka naam alag rakhna (jaise netflixfetch2)</li>
                          <li><b>Same 4 secrets</b> daalna — value bhi bilkul same (SUPABASE_URL/KEY/SESSION_SIGNING_SECRET/SESSION_SECRET). Kuch bhi change mat karna.</li>
                          <li>Naya worker URL copy karo</li>
                          <li>App → Admin Panel → Email Accounts tab</li>
                          <li>Us specific account ke 'Edit' me jao → 'Cloudflare Worker URLs' me naya URL add karo</li>
                          <li>Ya sab accounts ke liye global chahiye to 'Primary Cloudflare Worker URLs' me add karo — load balance hoga automatic</li>
                        </ol>
                      </div>
                    </details>


                    <div className="bg-green-50 rounded-lg border border-green-200 p-2.5">
                      <p className="text-xs font-bold text-green-800 mb-1">💡 Tips</p>
                      <ul className="text-[11px] text-green-900 space-y-0.5 ml-3 list-disc">
                        <li>Multiple URLs = random load balancing</li>
                        <li>Per-account URL = dedicated routing</li>
                        <li>Worker down? App direct Supabase use karega</li>
                      </ul>
                    </div>
                  </div>
                </details>
              </div>
            </section>

            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm lg:col-span-2">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <h2 className="font-black text-base sm:text-lg mb-1 flex items-center gap-2">
                    <div className={`p-1.5 rounded-lg ${maintenanceEnabled ? "bg-amber-100" : "bg-slate-100"}`}>
                      <AlertTriangle className={`w-4 h-4 ${maintenanceEnabled ? "text-amber-600" : "text-slate-500"}`} />
                    </div>
                    Maintenance Mode
                  </h2>
                  <p className="text-xs text-slate-500 max-w-md">When enabled, all non-admin users see an animated maintenance screen. Admins can still browse the site normally.</p>
                </div>
                <button
                  type="button"
                  onClick={() => saveMaintenance(!maintenanceEnabled)}
                  disabled={savingMaintenance}
                  aria-pressed={maintenanceEnabled}
                  className={`relative inline-flex h-8 w-14 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${maintenanceEnabled ? "bg-amber-500" : "bg-slate-300"}`}
                >
                  <span className={`inline-block w-6 h-6 bg-white rounded-full shadow transform transition-transform ${maintenanceEnabled ? "translate-x-7" : "translate-x-1"}`} />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-5">
                <div className="md:col-span-2">
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Headline (optional)</label>
                  <input type="text" value={maintenanceTitle} onChange={(e) => setMaintenanceTitle(e.target.value)}
                    placeholder="We're upgrading the system"
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm" />
                </div>
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Starts at (date + time)</label>
                  <DateTimePicker
                    value={maintenanceStartsAt}
                    onChange={setMaintenanceStartsAt}
                  />
                  <p className="text-[10.5px] text-slate-500 mt-1 ml-1">
                    {maintenanceStartsAt
                      ? `Site locks at ${new Date(maintenanceStartsAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", hour12: true, day: "numeric", month: "short" })}`
                      : "Leave empty to start immediately when enabled."}
                  </p>
                </div>
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Back online at (date + time)</label>
                  <DateTimePicker
                    value={maintenanceEndsAt}
                    onChange={setMaintenanceEndsAt}
                    min={maintenanceStartsAt || undefined}
                  />
                  <p className="text-[10.5px] text-slate-500 mt-1 ml-1">
                    {maintenanceEndsAt
                      ? `Site auto-unlocks at ${new Date(maintenanceEndsAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", hour12: true, day: "numeric", month: "short" })}`
                      : "Leave empty for open-ended maintenance."}
                  </p>
                </div>
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Current version (auto)</label>
                  <input type="text" value={maintenanceVersionFrom} readOnly disabled
                    placeholder="—"
                    className="w-full bg-slate-100 border rounded-xl p-3 outline-none text-sm font-mono text-slate-500 cursor-not-allowed select-all"
                    title="Auto-filled from the last saved upgrade target. Change it only from the database." />
                  <p className="text-[10.5px] text-slate-500 mt-1 ml-1">Locked — mirrors the last saved “Upgrading to”. Edit in DB only.</p>
                </div>
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Upgrading to (upgrade-only)</label>
                  <input type="text" value={maintenanceVersionTo} onChange={(e) => setMaintenanceVersionTo(e.target.value)}
                    placeholder="e.g. 2.5.0"
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm font-mono text-slate-900" />
                  <p className="text-[10.5px] text-slate-500 mt-1 ml-1">Stored in DB. Downgrades are blocked. Leave blank to auto-bump patch.</p>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Message shown to users</label>
                  <textarea value={maintenanceMessage} onChange={(e) => setMaintenanceMessage(e.target.value)} rows={3}
                    placeholder="The site is offline for a short while so we can make it faster and safer for you. No action needed — please check back soon."
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm resize-none" />
                </div>
              </div>

              {/* Live preview */}
              <div className="mt-5 rounded-2xl overflow-hidden border border-slate-800 bg-black text-white p-5 sm:p-6 relative">
                <div className="flex items-center gap-2 text-[10px] tracking-[0.28em] uppercase text-white/60 font-semibold mb-3">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#e50914] animate-pulse" />
                  Live preview — this is what users see
                </div>
                <div className="text-[22px] sm:text-[28px] font-semibold leading-[1.2] tracking-[-0.02em] mb-2 min-h-[1.2em]">
                  {maintenanceTitle.trim() || <span className="text-white/40 italic">(rotating headlines when empty)</span>}
                </div>
                <p className="text-white/70 text-sm leading-relaxed">
                  {maintenanceMessage.trim() || <span className="text-white/40 italic">The site is offline for a short while so we can make it faster and safer for you. You don't need to do anything — just come back in a few minutes.</span>}
                </p>
                {(maintenanceStartsAt || maintenanceEndsAt) && (
                  <div className="mt-4 flex flex-wrap gap-2 text-[11.5px]">
                    {maintenanceStartsAt && (
                      <span className="inline-flex items-center gap-1.5 bg-white/[0.06] border border-white/10 rounded-lg px-2.5 py-1">
                        <span className="text-white/50">Starts:</span>
                        <span className="text-white">{new Date(maintenanceStartsAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", hour12: true, day: "numeric", month: "short" })}</span>
                      </span>
                    )}
                    {maintenanceEndsAt && (
                      <span className="inline-flex items-center gap-1.5 bg-white/[0.06] border border-white/10 rounded-lg px-2.5 py-1">
                        <span className="text-white/50">Back at:</span>
                        <span className="text-white">{new Date(maintenanceEndsAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", hour12: true, day: "numeric", month: "short" })}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 mt-4 flex-wrap">
                <button onClick={() => saveMaintenance()} disabled={savingMaintenance}
                  className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-60">
                  {savingMaintenance ? "Saving…" : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={() => { setMaintenanceStartsAt(""); setMaintenanceEndsAt(""); }}
                  className="px-4 py-2 rounded-xl bg-white border text-slate-700 text-sm font-semibold hover:bg-slate-50"
                >
                  Clear schedule
                </button>
                {maintenanceEnabled && (
                  <span className="text-[11px] px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 inline-flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" /> Site is in maintenance mode
                  </span>
                )}
              </div>
            </section>



            <div className="lg:col-span-2">
              <button onClick={saveServerConfig} disabled={savingConfig}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all disabled:opacity-50 shadow-sm">
                {savingConfig ? "Saving..." : "Save All Configuration"}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ==================== CHANGE PASSWORD MODAL ====================
function ChangePasswordModal({ user, onDone, forced = false }: { user: UserData; onDone: () => void; forced?: boolean }) {
  const [currentPass, setCurrentPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!forced && !currentPass) { setError("Enter your current password"); return; }
    if (newPass.length < 6) { setError("Password must be at least 6 characters"); return; }
    if (newPass !== confirmPass) { setError("Passwords do not match"); return; }
    setLoading(true);
    try {
      await apiCall("manage-app", {
        action: "change_password", id: user.id,
        ...(forced ? {} : { current_password: currentPass }),
        new_password: newPass,
      });
      const stored = JSON.parse(sessionGet("user" as any) || "{}");
      stored.mustChangePassword = false;
      sessionSet("user" as any, JSON.stringify(stored));
      toast.success("Password changed successfully!");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="bg-white w-full max-w-sm rounded-2xl p-6 shadow-2xl">
        <div className="flex justify-center mb-4">
          <div className="bg-gradient-to-br from-violet-500 to-purple-600 p-3 rounded-2xl shadow-lg shadow-purple-200">
            <Key className="text-white w-6 h-6" />
          </div>
        </div>
        <h2 className="text-xl font-black text-center text-slate-900 mb-1">
          {forced ? "Set Your Password" : "Change Password"}
        </h2>
        <p className="text-slate-500 text-center text-xs mb-6">
          {forced ? "For security, set a private password only you know." : "Update your password to keep your account secure."}
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          {!forced && (
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5 z-10" />
              <PasswordInput value={currentPass} onChange={(e) => setCurrentPass(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-12 pr-12 focus:ring-2 focus:ring-purple-500 outline-none text-sm"
                placeholder="Current password" required autoFocus />
            </div>
          )}
          <div className="relative">
            <Key className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5 z-10" />
            <PasswordInput value={newPass} onChange={(e) => setNewPass(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-12 pr-12 focus:ring-2 focus:ring-purple-500 outline-none text-sm"
              placeholder="New password (min 6 chars)" required {...(forced ? { autoFocus: true } : {})} />
          </div>
          <div className="relative">
            <ShieldCheck className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5 z-10" />
            <PasswordInput value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-12 pr-12 focus:ring-2 focus:ring-purple-500 outline-none text-sm"
              placeholder="Confirm new password" required />
          </div>
          {error && (
            <div className="bg-red-50 text-red-600 text-xs p-3 rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
            </div>
          )}
          <div className="flex gap-3 pt-1">
            {!forced && (
              <button type="button" onClick={onDone}
                className="flex-1 bg-slate-100 text-slate-700 font-bold py-3 rounded-xl hover:bg-slate-200 transition-all active:scale-95">
                Cancel
              </button>
            )}
            <button type="submit" disabled={loading}
              className={`${forced ? "w-full" : "flex-1"} bg-gradient-to-r from-violet-500 to-purple-600 text-white font-bold py-3 rounded-xl hover:from-violet-600 hover:to-purple-700 transition-all active:scale-95 disabled:opacity-50 shadow-md shadow-purple-200`}>
              {loading ? "Saving..." : forced ? "Set Password" : "Update Password"}
            </button>
          </div>
        </form>
        <p className="text-[10px] text-slate-400 text-center mt-4">🔒 Your password is encrypted and secure.</p>
      </motion.div>
    </motion.div>
  );
}

function AvatarRow({
  category,
  userName,
  selectedAvatar,
  onPick,
  saving,
}: {
  category: typeof AVATAR_CATEGORIES[number];
  userName?: string;
  selectedAvatar: string | null;
  onPick: (id: string) => void;
  saving: boolean;
}) {
  return (
    <section id={`avatar-row-${category.key}`} className="scroll-mt-16">
      <div className="flex items-center justify-between px-4 sm:px-5 mb-2">
        <h4 className="text-sm sm:text-base font-black text-slate-900 tracking-tight">{category.label}</h4>
        <span className="text-[10px] font-bold text-slate-400">{category.files.length}</span>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 gap-3 px-4 sm:px-5 pb-3">
        {category.files.map((file) => {
          const id = buildAvatarId(category.key, file);
          const selected = selectedAvatar === id;
          return (
            <button
              key={id}
              onClick={() => onPick(id)}
              disabled={saving}
              title={prettyName(file)}
              className={`group relative aspect-square rounded-2xl overflow-hidden transition-shadow duration-200 active:scale-95 ${selected ? "ring-4 ring-red-500 shadow-lg shadow-red-500/40" : "ring-2 ring-transparent hover:ring-white/70"}`}
            >
              <ProfileAvatar avatarId={id} name={userName} className="w-full h-full !rounded-2xl" eager />
              <span className="absolute inset-x-0 bottom-0 px-1.5 py-1 text-[9px] sm:text-[10px] font-bold text-white text-center bg-gradient-to-t from-black/85 via-black/50 to-transparent truncate">
                {prettyName(file)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}


function AvatarPicker({
  userName,
  selectedAvatar,
  onPick,
  saving,
}: {
  userName?: string;
  selectedAvatar: string | null;
  onPick: (id: string) => void;
  saving: boolean;
}) {
  const [activeCategoryKey, setActiveCategoryKey] = useState(() => getCategoryKeyFromAvatarId(selectedAvatar) || AVATAR_CATEGORIES[0]?.key || "");
  const [pendingCategoryKey, setPendingCategoryKey] = useState<string | null>(null);
  const activeCategory = AVATAR_CATEGORIES.find((c) => c.key === activeCategoryKey) || AVATAR_CATEGORIES[0];
  const activeIndex = Math.max(0, AVATAR_CATEGORIES.findIndex((c) => c.key === activeCategory.key));

  useEffect(() => {
    if (!activeCategory) return;
    void preloadAvatarCategory(activeCategory.key, 2500);
    const next = AVATAR_CATEGORIES[activeIndex + 1];
    const prev = AVATAR_CATEGORIES[activeIndex - 1];
    if (next) warmAvatarCategory(next.key, "low");
    if (prev) warmAvatarCategory(prev.key, "low");
  }, [activeCategory?.key, activeIndex]);

  useEffect(() => {
    let cancelled = false;
    const warmRest = async () => {
      const ordered = AVATAR_CATEGORIES.filter((category) => category.key !== activeCategory?.key);
      for (const category of ordered) {
        if (cancelled) return;
        warmAvatarCategory(category.key, "low");
        await preloadAvatarCategory(category.key, 1200, "low");
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
    };
    const run = () => void warmRest();
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const idle = win.requestIdleCallback
      ? win.requestIdleCallback(run, { timeout: 1200 })
      : window.setTimeout(run, 700);
    return () => {
      cancelled = true;
      if (typeof idle === "number") window.clearTimeout(idle);
      if (win.cancelIdleCallback) win.cancelIdleCallback(idle);
    };
  }, [activeCategory?.key]);

  const selectCategory = (key: string) => {
    if (key === activeCategoryKey || pendingCategoryKey) return;
    setPendingCategoryKey(key);
    preloadAvatarCategory(key, 5000).finally(() => {
      setActiveCategoryKey(key);
      setPendingCategoryKey(null);
    });
  };

  const chipScrollRef = useRef<HTMLDivElement | null>(null);
  const [chipEdges, setChipEdges] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });

  const updateChipEdges = () => {
    const el = chipScrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setChipEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  };

  useEffect(() => {
    updateChipEdges();
    const el = chipScrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateChipEdges, { passive: true });
    window.addEventListener("resize", updateChipEdges);
    return () => {
      el.removeEventListener("scroll", updateChipEdges);
      window.removeEventListener("resize", updateChipEdges);
    };
  }, []);

  // Auto-scroll nudge: scroll right ~120px then back so users notice the row scrolls
  useEffect(() => {
    const el = chipScrollRef.current;
    if (!el) return;
    if (el.scrollWidth <= el.clientWidth + 8) return;
    const start = el.scrollLeft;
    let raf1: number, raf2: number;
    const t1 = window.setTimeout(() => {
      el.scrollTo({ left: start + 140, behavior: "smooth" });
      const t2 = window.setTimeout(() => {
        el.scrollTo({ left: start, behavior: "smooth" });
      }, 700);
      raf2 = t2 as unknown as number;
    }, 450);
    raf1 = t1 as unknown as number;
    return () => {
      window.clearTimeout(raf1);
      window.clearTimeout(raf2);
    };
  }, []);

  // Center active chip when it changes
  useEffect(() => {
    const el = chipScrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLButtonElement>(`button[data-cat-key="${activeCategoryKey}"]`);
    if (active) {
      const target = active.offsetLeft - el.clientWidth / 2 + active.clientWidth / 2;
      el.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
    }
  }, [activeCategoryKey]);

  const scrollChips = (dir: 1 | -1) => {
    const el = chipScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(200, el.clientWidth * 0.7), behavior: "smooth" });
  };

  if (!activeCategory) return null;

  return (
    <div className="pb-4">
      <div className="sticky top-0 z-10 bg-gradient-to-b from-slate-950 via-slate-900 to-slate-900 border-b border-red-600/30 px-4 sm:px-5 pt-4 pb-3 space-y-3 shadow-lg shadow-black/40">
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-1.5 rounded-full bg-gradient-to-b from-red-500 to-red-700 shadow-[0_0_12px_rgba(239,68,68,0.6)]" />
            <div>
              <h3 className="text-base sm:text-lg font-black text-white tracking-tight leading-none">Choose your character</h3>
              <p className="text-[11px] font-semibold text-red-400/90 mt-1 flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                Swipe categories &nbsp;·&nbsp; {activeCategory.label}
              </p>
            </div>
          </div>
          <span className="text-[10px] font-bold uppercase tracking-widest text-white/60 whitespace-nowrap">
            {saving ? "Saving…" : pendingCategoryKey ? "Preparing…" : `${activeCategory.files.length} icons`}
          </span>
        </div>
        <div className="relative">
          {chipEdges.left && (
            <>
              <div className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-slate-900 to-transparent z-10" />
              <button
                type="button"
                aria-label="Scroll left"
                onClick={() => scrollChips(-1)}
                className="hidden sm:flex absolute left-0 top-1/2 -translate-y-1/2 z-20 h-7 w-7 items-center justify-center rounded-full bg-black/70 border border-white/10 text-white hover:bg-red-600 transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            </>
          )}
          {chipEdges.right && (
            <>
              <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-slate-900 to-transparent z-10" />
              <button
                type="button"
                aria-label="Scroll right"
                onClick={() => scrollChips(1)}
                className="hidden sm:flex absolute right-0 top-1/2 -translate-y-1/2 z-20 h-7 w-7 items-center justify-center rounded-full bg-black/70 border border-white/10 text-white hover:bg-red-600 transition-colors"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </>
          )}
          <div
            ref={chipScrollRef}
            className="flex gap-2 overflow-x-auto scrollbar-none -mx-1 px-1 pb-1 snap-x snap-mandatory"
            style={{ scrollbarWidth: "none" }}
          >
            {AVATAR_CATEGORIES.map((c) => {
              const active = activeCategoryKey === c.key;
              const pending = pendingCategoryKey === c.key;
              return (
                <button
                  key={c.key}
                  data-cat-key={c.key}
                  onClick={() => selectCategory(c.key)}
                  onMouseEnter={() => warmAvatarCategory(c.key, "low")}
                  className={`snap-start flex-shrink-0 px-3.5 py-1.5 text-[12px] font-bold rounded-full transition-all duration-200 border ${
                    active
                      ? "bg-gradient-to-r from-red-600 to-red-700 text-white border-red-500 shadow-[0_4px_14px_rgba(239,68,68,0.5)] scale-105"
                      : pending
                      ? "bg-white text-slate-900 border-white animate-pulse"
                      : "bg-white/5 text-white/80 border-white/10 hover:bg-white/10 hover:text-white hover:border-red-500/40"
                  }`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="pt-4">
        <AvatarRow
          key={activeCategory.key}
          category={activeCategory}
          userName={userName}
          selectedAvatar={selectedAvatar}
          onPick={onPick}
          saving={saving}
        />
      </div>
    </div>
  );
}

function UserProfileModal({
  user,
  prefs,
  onPrefsSaved,
  onPassword,
  onDeleteOldEmails,
  onClose,
}: {
  user: UserData;
  prefs: UserProfilePrefs;
  onPrefsSaved: (prefs: UserProfilePrefs) => void;
  onPassword: () => void;
  onDeleteOldEmails: () => void;
  onClose: () => void;
}) {
  const [savingAvatar, setSavingAvatar] = useState(false);
  const selectedAvatar = prefs.avatarId || getStableProfileAvatar(user);

  useEffect(() => {
    const selectedUri = getAvatarUri(selectedAvatar);
    warmAvatarUrls(selectedUri ? [selectedUri] : [], "high");
    if (AVATAR_CATEGORIES[0]) warmAvatarCategory(AVATAR_CATEGORIES[0].key, "high");
  }, [selectedAvatar]);

  const saveAvatar = async (avatarId: string) => {
    if (savingAvatar) return;
    const nextPrefs = { ...prefs, avatarId };
    setSavingAvatar(true);
    onPrefsSaved(nextPrefs);
    // Update the cached bootstrap immediately so the profile-selection grid
    // shows the new avatar the very next time it mounts (e.g. after logout),
    // without waiting for a network refresh.
    if (user?.id) {
      patchBootstrapCacheUser(user.id, { profile_prefs: nextPrefs, profileAvatar: avatarId });
    }
    try {
      await apiCall("manage-app", { action: "update_profile_prefs", profile_prefs: nextPrefs });
      toast.success("Profile icon updated");
      // Kick off a background refresh so any other cached fields also update.
      refreshBootstrap().catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save icon");
    } finally {
      setSavingAvatar(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div initial={{ scale: 0.94, opacity: 0, y: 12 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.94, opacity: 0, y: 12 }}
        className="bg-white w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <ProfileAvatar avatarId={selectedAvatar} name={user.name} className="w-12 h-12" fallbackColor="bg-red-500" eager />
            <div className="min-w-0">
              <h2 className="text-lg font-black text-slate-900 leading-tight truncate">{user.name}</h2>
              <p className="text-xs text-slate-500 truncate">@{user.username}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full transition-colors" aria-label="Close profile">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <AvatarPicker
            userName={user.name}
            selectedAvatar={selectedAvatar}
            onPick={saveAvatar}
            saving={savingAvatar}
          />
        </div>
        <div className="p-4 border-t border-slate-100 bg-white/95 backdrop-blur">


          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button onClick={() => { onClose(); onPassword(); }}
              className="flex items-center justify-center gap-2 bg-slate-900 text-white font-bold py-3 rounded-xl hover:bg-slate-800 transition-all active:scale-95">
              <Key className="w-4 h-4" /> Change Password
            </button>
            <button onClick={onDeleteOldEmails}
              className="flex items-center justify-center gap-2 bg-red-600 text-white font-bold py-3 rounded-xl hover:bg-red-700 transition-all active:scale-95">
              <Trash2 className="w-4 h-4" /> Delete old emails
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ==================== EMAIL VIEWER ====================
function EmailViewer() {
  usePageHead("Email Inbox — Netflix Mail", "Secure viewer for Netflix sign-in codes, OTPs, and household verification emails.", "/viewer");
  const user = useMemo<UserData>(() => {
    try { return JSON.parse(sessionGet("user" as any) || "{}"); }
    catch { return {} as UserData; }
  }, []);
  const refreshAccountLabels = useMemo(() => getUserRefreshAccountLabels(user), [user]);
  const { checkAuth } = useAuth();
  const [profilePrefs, setProfilePrefs] = useState<UserProfilePrefs>(() => user.profilePrefs || {});
  const saveProfilePrefsLocally = useCallback((nextPrefs: UserProfilePrefs) => {
    setProfilePrefs(nextPrefs);
    try {
      const stored = JSON.parse(sessionGet("user" as any) || "{}");
      stored.profilePrefs = nextPrefs;
      stored.profileAvatar = nextPrefs.avatarId || null;
      sessionSet("user" as any, JSON.stringify(stored));
    } catch {}
  }, []);
  const [emails, setEmailsRaw] = useState<Email[]>([]);
  const setEmails = useCallback((next: Email[]) => {
    const visible = filterVisibleEmails(next, profilePrefs)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    setEmailsRaw(visible);
  }, [profilePrefs]);
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [otpCopied, setOtpCopied] = useState(false);
  const navigate = useNavigate();
  const [showChangePassword, setShowChangePassword] = useState(!!user.mustChangePassword);
  const [showProfile, setShowProfile] = useState(false);
  const [forcedPasswordChange] = useState(!!user.mustChangePassword);
  // F4: read impersonation backup from sessionStorage (with TTL check).
  const readImpersonationBackup = (): { user?: string | null; token?: string | null; adminAuth?: string | null } | null => {
    try {
      const raw = sessionGet("admin_backup" as any);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || (parsed.exp && Date.now() > parsed.exp)) {
        try { sessionRemove("admin_backup" as any); } catch {}
        return null;
      }
      return parsed;
    } catch { return null; }
  };
  const isImpersonating = !!readImpersonationBackup();

  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const refreshPollRef = useRef<number | null>(null);
  const [resolvedWorkerUrls, setResolvedWorkerUrls] = useState<string[]>(() => getStoredWorkerUrls());
  const [workerUrlMap, setWorkerUrlMap] = useState<WorkerUrlMap>({ primary: [], byAccount: {} });
  const [workerUrlsLoading, setWorkerUrlsLoading] = useState(true);
  const workerUrlLoaded = React.useRef(false);

  // F7: refresh diagnostics — records each worker hit while the
  // spinner is running so we can tell WHY it never stops.
  type DiagEntry = {
    ts: number; kind: "worker" | "sync" | "iframe" | "cache";
    endpoint: string; status?: number; ms?: number;
    cacheStatus?: string; cacheAge?: string; cacheKey?: string;
    error?: string; note?: string;
  };
  const [diag, setDiag] = useState<DiagEntry[]>([]);
  const [showDiag, setShowDiag] = useState(false);
  const pushDiag = useCallback((e: DiagEntry) => {
    setDiag((prev) => [e, ...prev].slice(0, 40));
  }, []);
  const clearDiag = useCallback(() => setDiag([]), []);

  const backToAdmin = () => {
    try {
      const backup = readImpersonationBackup();
      if (!backup) {
        toast.error("Impersonation session expired — please sign in again as admin.");
        try { sessionRemove("admin_backup" as any); } catch {}
        navigate("/admin");
        return;
      }
      if (backup.user) sessionSet("user" as any, backup.user);
      if (backup.token) sessionSet("session_token" as any, backup.token);
      if (backup.adminAuth) sessionSet("admin_auth" as any, backup.adminAuth);
      try { sessionRemove("admin_backup" as any); } catch {}
      try { sessionRemove("admin_backup" as any); } catch {}
      checkAuth();
      navigate("/admin/dashboard");
    } catch {
      navigate("/admin");
    }
  };


  useEffect(() => {
    if (workerUrlLoaded.current) return;
    workerUrlLoaded.current = true;
    (async () => {
      const primaryUrls: string[] = [];
      const accountUrls: Record<string, string[]> = {};

      try {
        const pcf = await apiCall("manage-app", { action: "get_settings", key: "primary_cloudflare_urls" });
        if (pcf.value && Array.isArray(pcf.value)) {
          for (const u of pcf.value) {
            const trimmed = u.trim().replace(/\/+$/, "");
            if (trimmed && !primaryUrls.includes(trimmed)) primaryUrls.push(trimmed);
          }
        }
      } catch { }
      try {
        const data = await apiCall("manage-app", { action: "get_settings", key: "email_accounts" });
        if (data.value && Array.isArray(data.value)) {
          for (const acc of data.value) {
            const label = acc.label || acc.user;
            const accUrls: string[] = [];
            if (acc.cloudflareUrls && Array.isArray(acc.cloudflareUrls)) {
              for (const u of acc.cloudflareUrls) {
                const trimmed = u.trim().replace(/\/+$/, "");
                if (trimmed) accUrls.push(trimmed);
              }
            }
            if (acc.cloudflareUrl && acc.cloudflareUrl.trim()) {
              const trimmed = acc.cloudflareUrl.trim().replace(/\/+$/, "");
              if (!accUrls.includes(trimmed)) accUrls.push(trimmed);
            }
            if (accUrls.length > 0 && label) {
              accountUrls[label] = accUrls;
            }
          }
        }
      } catch { }

      // Only primary URLs go into the general pool (used by apiCall)
      const normalizedPrimary = primaryUrls
        .map((u) => u.trim().replace(/\/+$/, ""))
        .filter(Boolean)
        .filter((u, i, arr) => arr.indexOf(u) === i);

      setResolvedWorkerUrls(normalizedPrimary);
      setWorkerUrlMap({ primary: normalizedPrimary, byAccount: accountUrls });
      if (normalizedPrimary.length > 0) storeWorkerUrls(normalizedPrimary);
      setWorkerUrlsLoading(false);
    })();
  }, []);

  const loadCachedEmails = useCallback(async (opts?: { bust?: boolean; limit?: number }) => {
    const bust = !!opts?.bust;
    const limit = opts?.limit || 3;
    try {
      const token = getSessionToken();
      const headers: Record<string, string> = {};
      if (token) headers["X-Session-Token"] = token;

      const labels = refreshAccountLabels;
      if (labels && labels.length === 0) {
        setEmails([]);
        setError(null);
        setLastUpdated(new Date());
        return 0;
      }
      const readDirectFromEdge = async (accountLabels?: string[]): Promise<Email[]> => {
        const { invokeEdge } = await import("./lib/secureTransport");
        const data: any = await invokeEdge(
          "fetch-emails",
          { mode: "cache", limit, accountLabels: accountLabels && accountLabels.length > 0 ? accountLabels : undefined },
          { headers },
        );
        if (Array.isArray(data)) return data as Email[];
        if (Array.isArray(data?.emails)) return data.emails as Email[];
        return [];
      };
      const groups = buildWorkerRequestGroups(labels, workerUrlMap, resolvedWorkerUrls);
      if (groups.length === 0) {
        const emailList = mergeEmailsById([await readDirectFromEdge(labels || undefined)]);
        setEmails(emailList);
        setError(null);
        setLastUpdated(new Date());
        return filterVisibleEmails(emailList, profilePrefs).length;
      }

      const lists = await Promise.all(groups.map(async (group) => {
        const params = new URLSearchParams({ limit: String(limit) });
        if (bust) params.set("bust", "1");
        appendAccountLabelParams(params, group.labels);
        const workerEndpoint = `${group.url}/api/emails?${params.toString()}`;
        const started = performance.now();
        const res = await fetch(workerEndpoint, { headers });
        const text = await res.text();
        pushDiag({
          ts: Date.now(),
          kind: "worker",
          endpoint: workerEndpoint,
          status: res.status,
          ms: Math.round(performance.now() - started),
          cacheStatus: res.headers.get("X-Cache-Status") || undefined,
          cacheAge: res.headers.get("X-Cache-Age") || undefined,
          cacheKey: res.headers.get("X-Cache-Key") || undefined,
          note: `${bust ? "bust=1" : "kv"}${group.labels ? ` · ${group.labels.join(", ")}` : ""}`,
        });
        if (!res.ok) {
          if (isEncryptedTransportError(text)) return await readDirectFromEdge(group.labels || labels || undefined);
          throw new Error(text.slice(0, 180) || "Worker failed to load emails");
        }
        const data = text ? JSON.parse(text) : [];
        return Array.isArray(data) ? data as Email[] : [];
      }));

      const emailList = mergeEmailsById(lists);
      setEmails(emailList);
      setError(null);
      setLastUpdated(new Date());
      return filterVisibleEmails(emailList, profilePrefs).length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load emails";
      pushDiag({ ts: Date.now(), kind: "cache", endpoint: "loadCachedEmails", error: msg });
      // Do NOT surface worker-transport errors ("encrypted transport required" etc.)
      // to the inbox UI — they would replace the cached list with a scary banner.
      // Current in-memory emails stay visible; user can hit Refresh.
      if (!isEncryptedTransportError(msg)) setError(msg);
      return 0;
    }
  }, [profilePrefs, setEmails, pushDiag, resolvedWorkerUrls, workerUrlMap, refreshAccountLabels]);


  const syncViaWorker = useCallback(async (): Promise<Email[] | null> => {
    const token = getSessionToken();
    const headers: Record<string, string> = {};
    if (token) headers["X-Session-Token"] = token;
    const labels = refreshAccountLabels;
    if (labels && labels.length === 0) return null;
    const groups = buildWorkerRequestGroups(labels, workerUrlMap, resolvedWorkerUrls);

    const syncDirectFromEdge = async (accountLabels?: string[]): Promise<Email[]> => {
      const { invokeEdge } = await import("./lib/secureTransport");
      const data: any = await invokeEdge(
        "fetch-emails",
        { mode: "user_sync", source: "user_refresh", limit: 3, accountLabels: accountLabels && accountLabels.length > 0 ? accountLabels : undefined },
        { headers },
      );
      if (data && data.success === false) throw new Error(data?.error || "Sync failed");
      return Array.isArray(data?.emails) ? data.emails as Email[] : [];
    };

    if (groups.length === 0) {
      return mergeEmailsById([await syncDirectFromEdge(labels || undefined)]);
    }

    const collected: Email[][] = [];
    await Promise.all(groups.map(async (group) => {
      const endpoint = `${group.url}/api/emails/sync`;
      const started = performance.now();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "user_sync", source: "user_refresh", limit: 3, accountLabels: group.labels || undefined }),
      });
      const text = await res.text();
      pushDiag({ ts: Date.now(), kind: "worker", endpoint, status: res.status, ms: Math.round(performance.now() - started), note: `user_sync${group.labels ? ` · ${group.labels.join(", ")}` : ""}` });
      if (!res.ok) {
        if (isEncryptedTransportError(text)) {
          const directEmails = await syncDirectFromEdge(group.labels || labels || undefined);
          if (directEmails.length > 0) collected.push(directEmails);
          pushDiag({ ts: Date.now(), kind: "sync", endpoint: "encrypted edge fallback", note: group.labels ? group.labels.join(", ") : "assigned accounts" });
          return;
        }
        throw new Error(text.slice(0, 180) || "Worker sync failed");
      }
      const data: any = text ? JSON.parse(text) : null;
      if (data && data.success === false) {
        if (isEncryptedTransportError(data?.error)) {
          const directEmails = await syncDirectFromEdge(group.labels || labels || undefined);
          if (directEmails.length > 0) collected.push(directEmails);
          pushDiag({ ts: Date.now(), kind: "sync", endpoint: "encrypted edge fallback", note: group.labels ? group.labels.join(", ") : "assigned accounts" });
          return;
        }
        throw new Error(data?.error || "Sync failed");
      }
      if (data && Array.isArray(data.emails)) collected.push(data.emails as Email[]);
    }));

    if (collected.length === 0) return [];
    return mergeEmailsById(collected);
  }, [pushDiag, resolvedWorkerUrls, workerUrlMap, refreshAccountLabels]);

  const fetchEmails = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const beforeIds = new Set(emails.map((e) => e.id));
    const toastId = "nf-refresh";
    toast.loading("Checking Netflix mail…", { id: toastId });
    try {
      // Fast path: worker sync returns fresh emails directly — no second round-trip.
      const synced = await syncViaWorker();
      let merged: Email[] = emails;
      if (synced && synced.length > 0) {
        merged = mergeEmailsById([emails, synced]);
        setEmails(merged);
        setError(null);
        setLastUpdated(new Date());
      }
      const visible = filterVisibleEmails(merged, profilePrefs);
      const newCount = visible.filter((e) => !beforeIds.has(e.id)).length;
      toast.dismiss(toastId);
      if (newCount > 0) {
        premiumToast(`${newCount} new email${newCount === 1 ? "" : "s"} arrived`, {
          variant: "mail",
          description: "Freshly delivered to your inbox",
          duration: 2600,
        });
      } else {
        premiumToast(visible.length > 0 ? "Inbox is up to date" : "No Netflix emails yet", {
          variant: "success",
          duration: 2000,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load";
      toast.dismiss(toastId);
      if (!isEncryptedTransportError(msg)) {
        premiumToast("Refresh could not complete", { variant: "error", description: msg, duration: 3200 });
      }
    } finally {
      if (refreshPollRef.current) {
        clearTimeout(refreshPollRef.current);
        refreshPollRef.current = null;
      }
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  const deleteOldEmailsForUser = async () => {
    const newestVisibleTime = emails.reduce((max, email) => {
      const time = new Date(email.date || 0).getTime();
      return Number.isNaN(time) ? max : Math.max(max, time);
    }, 0);
    const hiddenBefore = new Date(newestVisibleTime || Date.now()).toISOString();
    const nextPrefs = {
      ...profilePrefs,
      hiddenBefore,
      hiddenEmailIds: Array.from(new Set([...(profilePrefs.hiddenEmailIds || []), ...emails.map(emailIdentity), ...emails.map((e) => e.id)])).slice(-2000),
    };

    saveProfilePrefsLocally(nextPrefs);
    setEmailsRaw([]);
    setSelectedEmail(null);

    try {
      await apiCall("manage-app", { action: "update_profile_prefs", profile_prefs: nextPrefs });
      toast.success("Old emails deleted for this profile");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save delete setting");
    }
  };

  // On mount/login: ONE silent auto-refresh via the worker POST sync path.
  // No browser-persistent email cache, no background polling, no GET /api/emails.
  const didAutoRefreshRef = useRef(false);
  useEffect(() => {
    setLoading(false);
    if (!sessionGet("session_started_at" as any)) markSessionStart();

    // Fire ONE silent auto-refresh once worker URLs are known — per component mount/login.
    if (workerUrlsLoading) return;
    if (didAutoRefreshRef.current) return;
    didAutoRefreshRef.current = true;

    (async () => {
      try {
        await loadCachedEmails({ limit: 200 });
        const synced = await syncViaWorker();
        if (synced && synced.length > 0) {
          setEmailsRaw((prev) => {
            const merged = mergeEmailsById([prev, synced]);
            const visible = filterVisibleEmails(merged, profilePrefs)
              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            return visible;
          });
          setError(null);
          setLastUpdated(new Date());
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err || "");
        if (!isEncryptedTransportError(msg)) {
          pushDiag({ ts: Date.now(), kind: "sync", endpoint: "login auto-refresh", error: msg });
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerUrlsLoading]);

  // F7: listen for iframe self-report messages verifying that the link/button
  // click hijack is actually attached inside the sandboxed email preview.
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const d: any = ev.data;
      if (!d || typeof d !== "object" || d.__nf !== "iframe-links") return;
      pushDiag({
        ts: Date.now(),
        kind: "iframe",
        endpoint: "email preview",
        note: `links=${d.links} buttons=${d.buttons} hijack=${d.hijack ? "ON" : "OFF"} target=${d.baseTarget || "?"}`,
        error: d.hijack ? undefined : "link hijack not active",
      });
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [pushDiag]);




  const copyOtp = (otp: string) => {
    navigator.clipboard.writeText(otp);
    setOtpCopied(true);
    setTimeout(() => setOtpCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <h1 className="sr-only">Email Inbox — Netflix Mail</h1>
      {showChangePassword && (
        <ChangePasswordModal user={user} onDone={() => setShowChangePassword(false)} forced={forcedPasswordChange && showChangePassword} />
      )}
      <AnimatePresence>
        {showProfile && (
          <UserProfileModal
            user={user}
            prefs={profilePrefs}
            onPrefsSaved={saveProfilePrefsLocally}
            onPassword={() => setShowChangePassword(true)}
            onDeleteOldEmails={deleteOldEmailsForUser}
            onClose={() => setShowProfile(false)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showDiag && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
            onClick={() => setShowDiag(false)}
          >
            <motion.div
              initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full sm:max-w-2xl bg-white sm:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
            >
              <div className="p-4 border-b bg-slate-50 flex items-center justify-between">
                <div>
                  <h3 className="font-black text-slate-900 text-base flex items-center gap-2"><Info className="w-4 h-4" /> Refresh Diagnostics</h3>
                  <p className="text-[11px] text-slate-500">Live view of worker endpoints, KV cache status & fetch errors</p>
                </div>
                <button onClick={() => setShowDiag(false)} className="p-1.5 rounded-full hover:bg-slate-200"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-3 text-[11px] text-slate-600 border-b bg-slate-50/50 flex flex-wrap gap-x-4 gap-y-1">
                <span>Refreshing: <b className={refreshing ? "text-amber-600" : "text-emerald-600"}>{refreshing ? "yes" : "idle"}</b></span>
                <span>Primary workers: <b>{workerUrlMap.primary.length}</b></span>
                <span>Per-account: <b>{Object.keys(workerUrlMap.byAccount).length}</b></span>
                <span>Last update: <b>{lastUpdated.toLocaleTimeString()}</b></span>
              </div>
              <div className="flex-1 overflow-auto divide-y divide-slate-100">
                {diag.length === 0 && (
                  <div className="p-6 text-center text-slate-400 text-sm">No activity yet — hit Refresh to see live worker calls.</div>
                )}
                {diag.map((e, i) => {
                  const color = e.error ? "text-red-600" :
                    e.cacheStatus === "HIT" ? "text-emerald-600" :
                    e.cacheStatus === "STALE" ? "text-amber-600" :
                    e.cacheStatus === "BYPASS" ? "text-blue-600" :
                    e.cacheStatus === "MISS" ? "text-fuchsia-600" : "text-slate-600";
                  return (
                    <div key={i} className="p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`font-bold uppercase tracking-wide ${color}`}>{e.kind}{e.status ? ` · ${e.status}` : ""}{e.cacheStatus ? ` · ${e.cacheStatus}` : ""}</span>
                        <span className="text-slate-400">{new Date(e.ts).toLocaleTimeString()}{e.ms != null ? ` · ${e.ms}ms` : ""}</span>
                      </div>
                      <div className="mt-0.5 font-mono text-[10.5px] text-slate-700 break-all">{e.endpoint}</div>
                      {e.cacheAge && <div className="text-[10.5px] text-slate-500">cache age: {e.cacheAge}s</div>}
                      {e.cacheKey && <div className="text-[10.5px] text-slate-500 truncate">key: {e.cacheKey}</div>}
                      {e.note && <div className="text-[10.5px] text-slate-500">{e.note}</div>}
                      {e.error && <div className="mt-1 text-[11px] text-red-700 font-semibold">✗ {e.error}</div>}
                    </div>
                  );
                })}
              </div>
              <div className="p-3 border-t bg-slate-50 flex flex-wrap gap-2">
                <button onClick={clearDiag} className="px-3 py-1.5 text-xs font-bold rounded-lg bg-white border border-slate-200 hover:bg-slate-100">Clear</button>
                <button
                  onClick={async () => {
                    pushDiag({ ts: Date.now(), kind: "cache", endpoint: "worker cache purge", note: "blocked in encrypted-only mode" });
                    toast.message("Worker cache purge is disabled in encrypted-only mode");
                  }}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg bg-red-600 text-white hover:bg-red-700"
                >Purge KV cache</button>
                <button
                  onClick={() => { void loadCachedEmails({ bust: true }); }}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg bg-slate-900 text-white hover:bg-slate-800"
                >Force fresh fetch</button>
                <button
                  onClick={async () => {
                    pushDiag({ ts: Date.now(), kind: "worker", endpoint: "worker /api/health", note: "blocked in encrypted-only mode" });
                    toast.message("Worker health ping is disabled in encrypted-only mode");
                  }}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg bg-slate-100 hover:bg-slate-200"
                >Ping /api/health</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <header className="bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-6xl mx-auto px-3 sm:px-4 h-14 sm:h-16 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="flex-shrink-0 flex items-center gap-1.5">
              {/* Mobile: user's profile avatar (click opens profile settings). Desktop: N logo + divider + avatar */}
              <button
                type="button"
                onClick={() => !isImpersonating && setShowProfile(true)}
                className="sm:hidden rounded-md focus:outline-none focus:ring-2 focus:ring-red-600/60 active:scale-95 transition-transform"
                aria-label="Open profile settings"
                title="Profile settings"
              >
                <ProfileAvatar avatarId={profilePrefs.avatarId || user.profileAvatar} name={user.name} className="w-8 h-8 rounded-md overflow-hidden ring-1 ring-red-600/40" fallbackColor="bg-red-600" eager />
              </button>
              <NetflixNLogo className="hidden sm:block w-6 h-6 sm:w-8 sm:h-8" />
              <div className="hidden sm:block h-8 w-px bg-slate-200 ml-1" />
              <button
                type="button"
                onClick={() => !isImpersonating && setShowProfile(true)}
                className="hidden sm:block ml-1 rounded-full focus:outline-none focus:ring-2 focus:ring-red-600/60 active:scale-95 transition-transform"
                aria-label="Open profile settings"
                title="Profile settings"
              >
                <ProfileAvatar avatarId={profilePrefs.avatarId || user.profileAvatar} name={user.name} className="w-9 h-9" fallbackColor="bg-red-600" eager />
              </button>
            </div>
            <div className="min-w-0">
              <h2 className="font-bold text-sm sm:text-lg tracking-tight leading-tight text-red-600">Netflix Mail</h2>
              <span className="text-[10px] sm:text-xs text-slate-500 truncate block max-w-[100px] sm:max-w-[180px]">{user.name}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            {isImpersonating && (
              <button onClick={backToAdmin}
                className="flex items-center gap-1.5 px-3 py-2 bg-amber-500 text-white rounded-full text-xs font-bold hover:bg-amber-600 transition-all active:scale-95">
                <ArrowLeft className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Back to Admin</span>
                <span className="sm:hidden">Admin</span>
              </button>
            )}
            <NotificationBell />
            <button onClick={() => fetchEmails()}
              disabled={refreshing}
              className="flex items-center p-2.5 sm:px-4 sm:py-2 bg-slate-900 text-white rounded-full text-sm font-bold hover:bg-slate-800 transition-all active:scale-95 disabled:opacity-60">
              <RefreshCw className={`w-4 h-4 sm:w-5 sm:h-5 ${refreshing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline ml-1.5">Refresh</span>
            </button>





            {!isImpersonating && (
              <button onClick={() => setShowProfile(true)}
                className="flex items-center p-2.5 sm:px-3 sm:py-2 bg-gradient-to-r from-violet-500 to-purple-600 text-white rounded-full text-sm font-bold hover:from-violet-600 hover:to-purple-700 transition-all active:scale-95 shadow-md shadow-purple-200"
                title="Profile">
                <UserCircle className="w-4 h-4 sm:w-5 sm:h-5" />
                <span className="hidden sm:inline ml-1.5">Profile</span>
              </button>
            )}
            <button onClick={() => {
              if (isImpersonating) { backToAdmin(); return; }
              sessionClearAll(); navigate("/");
            }} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
              <LogOut className="w-5 h-5 text-slate-400" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-2 sm:px-4 h-[calc(100vh-3.5rem)] sm:h-[calc(100vh-4rem)] overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 sm:gap-8 h-full py-4 sm:py-8">
          <div className={`${selectedEmail ? "hidden md:block" : "block"} md:col-span-5 xl:col-span-4 flex flex-col overflow-hidden h-full`}>
            <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-3 sm:p-5 flex items-center gap-3 sm:gap-4 flex-shrink-0">
              <div className="bg-green-100 p-2 sm:p-3 rounded-xl flex-shrink-0">
                <ShieldCheck className="text-green-600 w-6 h-6" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-slate-800">System Active</h2>
                <p className="text-xs text-slate-500">Monitoring emails securely</p>
              </div>
            </section>

            <section className="mt-4 flex-1 overflow-y-auto min-h-0 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                  Inbox
                  <span className="bg-slate-200 text-slate-600 text-[10px] px-2 py-0.5 rounded-full">{emails.length}</span>
                </h3>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-100 rounded-xl p-3 mb-2">
                  <p className="text-red-600 text-xs flex items-center gap-2"><AlertCircle className="w-3 h-3" />{error}</p>
                </div>
              )}

              <div className="space-y-2 flex-1 overflow-y-auto min-h-0">
                {emails.length === 0 && !error ? (
                  <div className="bg-white border border-dashed border-slate-200 rounded-xl p-12 text-center">
                    <div className="bg-slate-50 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Mail className="text-slate-200 w-6 h-6" />
                    </div>
                    <p className="text-[10px] sm:text-xs text-slate-400 font-medium">
                      No Netflix emails found
                    </p>
                  </div>
                ) : (
                  emails.map(email => (
                    <button key={email.id} onClick={() => setSelectedEmail(email)}
                      className={`w-full text-left p-3 rounded-xl border transition-all ${
                        selectedEmail?.id === email.id
                          ? "bg-white border-red-200 shadow-md ring-1 ring-red-100"
                          : "bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm"
                      }`}>
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-[10px] font-bold text-red-600 uppercase tracking-tight truncate max-w-[70%]">
                          {email.from?.split("<")[0]?.trim() || "Unknown"}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {new Date(email.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true })}
                        </span>
                      </div>
                      <h4 className="text-sm font-bold text-slate-900 truncate mb-1">{email.subject}</h4>
                      <p className="text-xs text-slate-500 line-clamp-1">{email.preview}</p>
                      {email.otp && (
                        <div className="mt-2 flex items-center gap-2">
                          <div className="bg-slate-900 text-white text-[10px] font-mono px-2 py-0.5 rounded">OTP: {email.otp}</div>
                          <span className="text-[10px] text-slate-400 font-bold uppercase">Ready</span>
                        </div>
                      )}
                    </button>
                  ))
                )}
              </div>
            </section>
          </div>

          <div className={`${selectedEmail ? "block" : "hidden md:flex"} md:col-span-7 xl:col-span-8 flex flex-col overflow-hidden h-full`}>
            {selectedEmail ? (
              <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full overflow-hidden">
                <div className="p-3 sm:p-6 border-b border-slate-100 bg-white sticky top-0 z-10">
                  <div className="flex items-center gap-2 sm:gap-4 mb-3 sm:mb-6">
                    <button onClick={() => setSelectedEmail(null)}
                      className="flex items-center gap-1.5 px-3 py-1.5 sm:px-4 sm:py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full transition-colors font-bold text-xs sm:text-sm active:scale-95">
                      <ArrowLeft className="w-4 h-4" />Inbox
                    </button>
                  </div>
                  <h2 className="text-base sm:text-2xl font-bold text-slate-900 mb-2 sm:mb-4 leading-tight">{selectedEmail.subject}</h2>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                      {/netflix\.com/i.test(selectedEmail.from || "") ? (
                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-black flex items-center justify-center flex-shrink-0 ring-1 ring-slate-200">
                          <span className="text-red-600 font-black text-base sm:text-xl leading-none" style={{ fontFamily: "'Bebas Neue', 'Arial Black', system-ui, sans-serif", letterSpacing: "-0.05em" }}>N</span>
                        </div>
                      ) : (
                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600 font-bold text-sm sm:text-lg flex-shrink-0">
                          {(selectedEmail.from?.charAt(0) || "?").toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0">
                        <span className="font-bold text-xs sm:text-sm text-slate-900 truncate block">
                          {selectedEmail.from?.split("<")[0]?.trim() || "Unknown Sender"}
                        </span>
                        <p className="text-[10px] sm:text-xs text-slate-500 truncate">{selectedEmail.from}</p>
                      </div>
                    </div>
                    <p className="text-[10px] sm:text-xs text-slate-400">{new Date(selectedEmail.date).toLocaleString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })}</p>
                  </div>
                </div>

                <div className="flex-1 overflow-auto p-2 sm:p-6 bg-white">
                  {selectedEmail.otp && (
                    <div className="mb-4 sm:mb-8 bg-slate-900 rounded-xl sm:rounded-2xl p-4 sm:p-6 text-center shadow-xl shadow-slate-200 relative overflow-hidden">
                      <div className="relative z-10">
                        <p className="text-slate-400 text-[10px] sm:text-xs font-bold uppercase tracking-[0.15em] mb-1 sm:mb-2">Detected OTP Code</p>
                        <div className="text-3xl sm:text-5xl font-mono font-black text-white tracking-wider sm:tracking-widest mb-2 sm:mb-4">{selectedEmail.otp}</div>
                        <button onClick={() => copyOtp(selectedEmail.otp!)}
                          className="flex items-center gap-1.5 mx-auto px-4 py-1.5 sm:px-6 sm:py-2 bg-red-600 hover:bg-red-700 text-white rounded-full font-bold text-xs sm:text-sm transition-all active:scale-95">
                          {otpCopied ? <><Check className="w-4 h-4" />Copied!</> : <><Copy className="w-4 h-4" />Copy Code</>}
                        </button>
                      </div>
                      <div className="absolute top-0 right-0 p-2 sm:p-4 opacity-10">
                        <ShieldCheck className="w-16 h-16 sm:w-24 sm:h-24 text-white" />
                      </div>
                    </div>
                  )}
                  <div className="email-html-wrapper">
                    <iframe
                      srcDoc={`<!DOCTYPE html><html><head><base target="_blank"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:8px;font-family:sans-serif;font-size:14px;color:#334155;overflow-x:hidden;word-break:break-word}img{max-width:100%!important;height:auto!important}table{max-width:100%!important;width:100%!important}td,th{max-width:100%!important;overflow:hidden}a{color:#e11d48}*{box-sizing:border-box}</style></head><body>${selectedEmail.html}<script>(function(){function force(a){try{a.setAttribute('target','_blank');a.setAttribute('rel','noopener noreferrer');}catch(e){}}function scan(){document.querySelectorAll('a,button').forEach(force);}document.addEventListener('click',function(e){var a=e.target.closest('a,button');if(!a)return;var href=a.getAttribute('href')||a.dataset.href;if(href){e.preventDefault();window.open(href,'_blank','noopener,noreferrer');}},true);document.addEventListener('contextmenu',function(e){e.preventDefault();});scan();try{new MutationObserver(scan).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['href','target']});}catch(e){}try{var links=document.querySelectorAll('a').length;var buttons=document.querySelectorAll('button').length;var base=document.querySelector('base');window.parent&&window.parent.postMessage({__nf:'iframe-links',links:links,buttons:buttons,hijack:true,baseTarget:(base&&base.getAttribute('target'))||''}, '*');}catch(e){}})();<\/script></body></html>`}
                      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-scripts"
                      className="w-full border-0"
                      style={{ minHeight: "400px" }}
                      title="Email content"
                      onLoad={(e) => {
                        const iframe = e.target as HTMLIFrameElement;
                        if (iframe.contentDocument?.body) {
                          iframe.style.height = iframe.contentDocument.body.scrollHeight + 20 + "px";
                        }
                      }}
                    />
                  </div>
                </div>
              </motion.div>
            ) : (
              <div className="bg-white rounded-2xl border border-dashed border-slate-200 flex flex-col items-center justify-center h-full text-center p-6 sm:p-12">
                <div className="bg-slate-50 w-16 h-16 sm:w-20 sm:h-20 rounded-full flex items-center justify-center mb-4 sm:mb-6">
                  <Mail className="text-slate-200 w-8 h-8 sm:w-10 sm:h-10" />
                </div>
                <h3 className="text-base sm:text-xl font-bold text-slate-800 mb-2">Select an email to read</h3>
                <p className="text-sm sm:text-base text-slate-400 max-w-xs mx-auto">Click on any email from the inbox list.</p>
              </div>
            )}
          </div>
        </div>
      </main>

      <style>{`
        .email-html-wrapper {
          overflow: hidden;
          max-width: 100%;
          width: 100%;
        }
        .email-html-wrapper iframe {
          display: block;
          width: 100%;
        }
      `}</style>
    </div>
  );
}

// ==================== MAINTENANCE GATE ====================
const MAINT_BYPASS_KEY = "maintenance_admin_bypass";

// D.2: bypass is a server-signed JWS `{kind:'maint_bypass', uid, exp, jti}` with
// 10 min TTL. Client parses `exp` locally to auto-expire; signature is HMAC so
// clients cannot forge or extend it. Old "1" values are treated as invalid.
function readMaintBypassExp(): number | null {
  try {
    const raw = sessionStorage.getItem(MAINT_BYPASS_KEY);
    if (!raw || raw === "1") return null;
    const dataB64 = raw.split(".")[0];
    if (!dataB64) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload?.kind !== "maint_bypass") return null;
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload.exp;
  } catch { return null; }
}


function hasActiveAdminImpersonationBackup(): boolean {
  try {
    const raw = sessionGet("admin_backup" as any);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || (parsed.exp && Date.now() > parsed.exp)) {
      sessionRemove("admin_backup" as any);
      return false;
    }
    return !!parsed.token && !!parsed.user;
  } catch {
    return false;
  }
}

function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const { user, checkAuth } = useAuth();
  const navigate = useNavigate();
  const cached = useMemo(() => readBootstrapCache(), []);
  const [maint, setMaint] = useState<MaintenanceInfo>(
    cached?.maintenance || { enabled: false }
  );
  const [bypass, setBypass] = useState<boolean>(() => readMaintBypassExp() !== null);

  // Auto-expire bypass locally when the signed token's exp passes (no round-trip).
  useEffect(() => {
    if (!bypass) return;
    const exp = readMaintBypassExp();
    if (exp === null) {
      try { sessionStorage.removeItem(MAINT_BYPASS_KEY); } catch {}
      setBypass(false);
      return;
    }
    const t = setTimeout(() => {
      try { sessionStorage.removeItem(MAINT_BYPASS_KEY); } catch {}
      setBypass(false);
    }, Math.max(0, exp - Date.now()) + 250);
    return () => clearTimeout(t);
  }, [bypass]);


  // 🚨 Force-kick non-admin users the moment maintenance turns ON.
  // Admins are never kicked — they can bypass to continue working.
  useEffect(() => {
    if (!maint.enabled) return;
    if (!user) return;
    if (user.role === "admin") return;
    if (user.impersonated === true || hasActiveAdminImpersonationBackup()) return;
    const path = typeof window !== "undefined" ? window.location.pathname : "/";
    if (path.startsWith("/admin")) return;
    try { clearSessionData(); } catch {}
    try { sessionStorage.removeItem(MAINT_BYPASS_KEY); } catch {}
    checkAuth();
    toast("🛠 Maintenance started", {
      id: "maint-kick",
      description: "You've been signed out while we perform updates.",
      duration: 4000,
    });
    navigate("/", { replace: true });
  }, [maint.enabled, user?.id, user?.role]);


  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const bs = await refreshBootstrap();
        if (!cancelled) setMaint(bs.maintenance || { enabled: false });
      } catch {}
    };
    const isAdminPath = window.location.pathname.startsWith("/admin");
    const adminLike = user?.role === "admin" || user?.impersonated === true || hasActiveAdminImpersonationBackup();
    if (!isAdminPath && !adminLike) load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !window.location.pathname.startsWith("/admin")) load();
    }, 120000);
    const onChange = () => load();
    window.addEventListener("maintenance:changed", onChange);
    if (!isAdminPath) window.addEventListener("focus", onChange);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("maintenance:changed", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [user?.role, user?.impersonated]);

  // Local auto-expiry: when endsAt passes on the client, flip off immediately
  // without waiting for the next server poll.
  useEffect(() => {
    if (!maint.enabled || !maint.endsAt) return;
    const ms = new Date(maint.endsAt).getTime() - Date.now();
    if (ms <= 0) {
      setMaint((m) => ({ ...m, enabled: false }));
      return;
    }
    const t = setTimeout(() => {
      setMaint((m) => ({ ...m, enabled: false }));
      // Refresh bootstrap so the server also flips (it auto-expires on read).
      refreshBootstrap().catch(() => {});
    }, ms + 500);
    return () => clearTimeout(t);
  }, [maint.enabled, maint.endsAt]);

  // If maintenance turns off, clear the bypass flag so admins re-arm on next outage.
  useEffect(() => {
    if (!maint.enabled && bypass) {
      try { sessionStorage.removeItem(MAINT_BYPASS_KEY); } catch {}
      setBypass(false);
    }
  }, [maint.enabled, bypass]);

  const isAdmin = user?.role === "admin" || user?.impersonated === true || hasActiveAdminImpersonationBackup();

  // Always let the admin login flow through, even during maintenance.
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  const isAdminRoute = path.startsWith("/admin");

  const screenProps = {
    title: maint.title,
    message: maint.message,
    endsAt: maint.endsAt || null,
    versionFrom: maint.versionFrom || "",
    versionTo: maint.versionTo || "",
  };

  if (maint.enabled && !isAdmin && !isAdminRoute) {
    return <MaintenanceScreen {...screenProps} />;
  }
  if (maint.enabled && isAdmin && !bypass && !isAdminRoute) {
    return (
      <MaintenanceScreen
        {...screenProps}
        isAdmin
        onAdminBypass={async () => {
          // D.2: request a signed short-lived bypass token from server. Falls back
          // to legacy client flag only if the server call fails (e.g. offline) so
          // admins are never locked out of their own maintenance window.
          try {
            const res = await apiCall("manage-app", { action: "admin_issue_maint_bypass" });
            if (res?.success && typeof res.token === "string") {
              try { sessionStorage.setItem(MAINT_BYPASS_KEY, res.token); } catch {}
              setBypass(true);
              return;
            }
          } catch {}
          try { sessionStorage.setItem(MAINT_BYPASS_KEY, "1"); } catch {}
          setBypass(true);
        }}
      />
    );
  }



  return <>{children}</>;
}

// ==================== MAIN APP ====================
export default function App() {
  return (
    <Router>
      <AuthProvider>
        <ResponsiveToaster />
        <ErrorBoundary>
          <MaintenanceGate>
            <Routes>
              <Route path="/" element={<ProfileSelectPage />} />
              <Route path="/admin" element={<AdminLoginPage />} />
              <Route path="/admin-auth" element={<AdminAuthPage />} />
              <Route path="/admin/dashboard" element={<ProtectedRoute role="admin"><AdminPanel /></ProtectedRoute>} />
              <Route path="/viewer" element={<ProtectedRoute role="user"><EmailViewer /></ProtectedRoute>} />
              <Route path="/guides/netflix-household-verification" element={<NetflixHouseholdVerificationGuide />} />
            </Routes>
          </MaintenanceGate>
        </ErrorBoundary>
      </AuthProvider>
    </Router>
  );
}


const ProtectedRoute = ({ children, role }: { children: React.ReactNode; role: "admin" | "user" }) => {
  const { user, loading } = useAuth();
  const roleAllowed = !!user && (role !== "admin" || user.role === "admin");
  useSessionTimeoutGuard(role, roleAllowed);
  if (loading) return <div className="min-h-screen bg-slate-950 flex items-center justify-center"><div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" /></div>;
  if (!user) return <Navigate to={role === "admin" ? "/admin" : "/"} />;
  if (role === "admin" && user.role !== "admin") return <Navigate to="/" />;
  // Note: allow admin accounts to freely browse the user viewer too — do not auto-redirect back to admin panel.
  return <><SessionCountdown role={role} />{children}</>;
};
