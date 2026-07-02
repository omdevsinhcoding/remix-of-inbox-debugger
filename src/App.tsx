import React, { useState, useEffect, createContext, useContext, useCallback, useRef, useMemo, Suspense, lazy } from "react";
import { createPortal } from "react-dom";
import { Mail, RefreshCw, ShieldCheck, Shield, Clock, AlertCircle, Copy, Check, ArrowLeft, Lock, Key, LogOut, Settings, Plus, Users, Trash2, CheckCircle2, X, Eye, EyeOff, KeyRound, Filter, Server, BarChart3, Globe, Edit, Database, Wifi, Info, UserCircle, Search, ChevronLeft, ChevronRight, Bell, Send, MessageSquare, Image as ImageIcon, Pin, ExternalLink, Archive, AlertTriangle, Sparkles, Megaphone, Wrench, CreditCard, Tag, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Toaster, toast } from "sonner";
import { supabase } from "./integrations/supabase/client";
import { AVATAR_CATEGORIES, resolveAvatar, buildAvatarId, prettyName, getAvatarCategoryUrls } from "./lib/avatars";
import { bootstrapFromSupabase, clearSessionData, markSessionStart, readBootstrapCache, refreshBootstrap, patchBootstrapCacheUser, getEmailFilters, setEmailFilters as setEmailFiltersCache, listNotifications, markNotificationRead, markAllNotificationsRead, markNotificationSeen, archiveNotification, snoozeNotification, logNotificationEvent, getPoppedIds, markPopped, type EmailFilters, type AppNotification, type MaintenanceInfo } from "./lib/bootstrap";
import MaintenanceScreen from "./components/MaintenanceScreen";


// Lazy-loaded heavy auth-only libs — kept out of the public first-load chunk.
const ReCAPTCHA = lazy(() => import("react-google-recaptcha"));
const QRCodeSVG = lazy(() => import("qrcode.react").then((m) => ({ default: m.QRCodeSVG })));


const SESSION_CONFIG_KEY_FOR = (role: "admin" | "user") =>
  role === "admin" ? "admin_session_config" : "session_config";

// --- Worker URL Types & Helpers ---
const WORKER_URLS_KEY = "cloudflare_worker_urls";

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
  try {
    const stored = localStorage.getItem(WORKER_URLS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
    const cached = readBootstrapCache();
    if (Array.isArray(cached?.workerUrls) && cached.workerUrls.length > 0) return cached.workerUrls;
  } catch {}
  return [];
}

function storeWorkerUrls(urls: string[]) {
  try {
    localStorage.setItem(WORKER_URLS_KEY, JSON.stringify(urls));
  } catch {}
}

function getSessionToken(): string | null {
  try {
    return localStorage.getItem("session_token");
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

function isPublicIpv4Like(ip: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const parts = ip.split(".").map(Number);
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

async function fetchBrowserPublicIp(): Promise<Pick<LoginLocationPayload, "publicIp" | "publicIpSource">> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch("https://ipwho.is/", {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return {};
    const data = await response.json();
    const ip = typeof data?.ip === "string" ? data.ip.trim() : "";
    if (!isPublicIpv4Like(ip)) return {};
    return { publicIp: ip, publicIpSource: "ipwho.is" };
  } catch (error) {
    console.warn("[IP] Browser public IP lookup failed:", error);
    return {};
  } finally {
    window.clearTimeout(timeout);
  }
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

// --- API Helper (routes ALL calls through Cloudflare Workers) ---

async function apiCall(functionName: string, body: any) {
  let workerUrls = getStoredWorkerUrls();
  const mustUseWorker = functionName === "manage-app" && body?.action === "login";
  if (mustUseWorker && workerUrls.length === 0) {
    try {
      const bootstrap = await bootstrapFromSupabase();
      if (Array.isArray(bootstrap.workerUrls) && bootstrap.workerUrls.length > 0) {
        storeWorkerUrls(bootstrap.workerUrls);
        workerUrls = bootstrap.workerUrls;
      }
    } catch (err) {
      console.warn("[apiCall] login worker bootstrap failed:", err);
    }
  }
  
  const token = getSessionToken();
  const pendingToken = (() => { try { return localStorage.getItem("pending_admin_token"); } catch { return null; } })();
  const pendingActions = new Set(["request_admin_otp", "verify_otp", "verify_totp", "update_totp", "finalize_admin_session"]);

  // Try each worker URL with random load balancing
  if (workerUrls.length > 0) {
    const shuffled = shuffleArray(workerUrls);
    for (const cfUrl of shuffled) {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (token) headers["X-Session-Token"] = token;
        if (pendingToken && functionName === "manage-app" && pendingActions.has(body?.action)) headers["X-Pending-Token"] = pendingToken;

        const res = await fetch(`${cfUrl}/api/fn/${functionName}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (res.status === 404 || res.status === 405 || res.status === 502) {
          console.warn(`[apiCall] ${cfUrl} returned ${res.status}, trying next worker`);
          continue;
        }

        const text = await res.text();
        let data: any;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(`Request failed (${res.status}). Server returned non-JSON response.`);
        }

        if (!res.ok) {
          throw new Error(data?.error || `Request failed with status ${res.status}`);
        }

        if (data.sessionToken) {
          localStorage.setItem("session_token", data.sessionToken);
        }
        return data;
      } catch (err: any) {
        // If it's a business logic error (not a network/worker error), throw immediately
        if (err.message && !err.message.includes("Failed to fetch") && !err.message.includes("trying next worker") && !err.message.includes("NetworkError") && !err.message.includes("502")) {
          throw err;
        }
        console.warn(`[apiCall] ${cfUrl} failed:`, err);
        continue;
      }
    }
  }

  if (mustUseWorker) {
    throw new Error("Secure login route is unavailable. Please refresh once and try again.");
  }

  // Fallback: call Supabase edge function directly
  console.log(`[apiCall] All workers failed or none configured, falling back to direct Supabase for ${functionName}`);
  const { createClient } = await import("@supabase/supabase-js");
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const headers: Record<string, string> = {};
  if (token) headers["X-Session-Token"] = token;
  if (pendingToken && functionName === "manage-app" && pendingActions.has(body?.action)) headers["X-Pending-Token"] = pendingToken;
  
  const res = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${supabaseKey}`,
      "apikey": supabaseKey,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Direct Supabase call failed (${res.status})`);
  }
  if (!res.ok) {
    throw new Error(data?.error || `Request failed with status ${res.status}`);
  }
  if (data.sessionToken) {
    localStorage.setItem("session_token", data.sessionToken);
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
      richColors
      closeButton
      expand={false}
      visibleToasts={2}
      duration={2500}
      offset={isMobile ? "calc(env(safe-area-inset-bottom) + 5.5rem)" : "5rem"}
      toastOptions={{ className: "pointer-events-auto" }}
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
      const stored = localStorage.getItem("user");
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  };

  const hydrateFromServer = async () => {
    const token = getSessionToken();
    if (!token) {
      try { localStorage.removeItem("user"); } catch {}
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const res = await apiCall("manage-app", { action: "me" });
      if (res?.success && res.user) {
        const merged = { ...(readCached() || {}), ...res.user };
        try { localStorage.setItem("user", JSON.stringify(merged)); } catch {}
        setUser(merged);
      } else {
        throw new Error(res?.error || "Session invalid");
      }
    } catch {
      // Session revoked, expired, or account missing → force logout
      try {
        localStorage.removeItem("session_token");
        localStorage.removeItem("user");
        localStorage.removeItem("admin_auth");
        localStorage.removeItem("pending_admin_token");
      } catch {}
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const checkAuth = () => {
    // Fast path: reflect localStorage synchronously (used after login/logout).
    setUser(readCached());
    setLoading(false);
  };

  useEffect(() => {
    // Initial paint from cache so UI is not blocked, then verify against DB.
    setUser(readCached());
    void hydrateFromServer();
  }, []);

  return <AuthContext.Provider value={{ user, loading, checkAuth }}>{children}</AuthContext.Provider>;
};

const useAuth = () => useContext(AuthContext)!;

// --- Session Timeout Guard ---
// Reads admin-configured absolute session timeout (minutes) from app_settings.
// When elapsed, forces full logout: user must click their profile and re-enter password.
function useSessionTimeoutGuard(role: "admin" | "user") {
  const navigate = useNavigate();
  const { checkAuth } = useAuth();
  useEffect(() => {
    let timer: any;
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

      let started = Number(localStorage.getItem("session_started_at") || "0");
      if (!started) { markSessionStart(); started = Date.now(); }
      const expiresAt = started + minutes * 60_000;
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) { doLogout(); return; }
      timer = setTimeout(doLogout, remaining);
    })();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);
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
        !n.read && !n.archived &&
        (!n.snoozed_until || new Date(n.snoozed_until) < new Date())
      );
      if (fresh.length) {
        // pin/critical first, then newest
        fresh.sort((a, b) => {
          const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
          if (pa !== pb) return pb - pa;
          const cra = a.priority === "critical" ? 1 : 0, crb = b.priority === "critical" ? 1 : 0;
          if (cra !== crb) return crb - cra;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
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
                {current.pinned && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-amber-300/90 font-medium uppercase tracking-wider">
                    <Pin className="w-3 h-3" /> Pinned
                  </span>
                )}
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
                {current.action_url && current.action_label ? (
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
type Tab = "all" | "unread" | "pinned" | "archived";

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
      if (tab === "pinned" && !n.pinned) return false;
      if (tab === "archived" && !n.archived) return false;
      if (tab !== "archived" && n.archived) return false;
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

  const handleArchive = async (id: string) => {
    await archiveNotification(id);
    onChange();
    if (selected === id) setSelected(null);
  };

  const handleSnooze = async (id: string, hours: number) => {
    const until = new Date(Date.now() + hours * 3600_000).toISOString();
    await snoozeNotification(id, until);
    onChange();
    toast.success(`Snoozed for ${hours}h`);
  };

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
          {!detail && items.filter((n) => !n.read && !n.archived).length > 0 && (
            <span className="text-[10.5px] font-medium text-rose-300/90 tracking-wider uppercase">
              {items.filter((n) => !n.read && !n.archived).length} new
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
            {(["all", "unread", "pinned", "archived"] as Tab[]).map((t) => (
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
                          {n.pinned && <Pin className="inline w-3 h-3 mr-1 text-amber-300/80 -mt-0.5" />}
                          {n.title}
                        </p>
                        <span className="text-[10.5px] text-zinc-500 font-light tabular-nums flex-shrink-0" title={new Date(n.created_at).toLocaleString()}>
                          {formatRelative(n.created_at)}
                        </span>
                      </div>
                      <p className="text-zinc-500 text-[12px] mt-1 leading-relaxed line-clamp-2 font-light">{n.body}</p>
                    </div>
                    {!n.read && (
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.7)] mt-1.5 flex-shrink-0" />
                    )}
                  </button>
                  {!n.archived && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 hidden group-hover:flex gap-1">
                      <button onClick={(e) => { e.stopPropagation(); handleSnooze(n.id, 24); }} className="p-1.5 rounded-md bg-black/40 text-zinc-400 hover:text-white" title="Snooze 24h"><Clock className="w-3.5 h-3.5" /></button>
                      <button onClick={(e) => { e.stopPropagation(); handleArchive(n.id); }} className="p-1.5 rounded-md bg-black/40 text-zinc-400 hover:text-white" title="Archive"><Archive className="w-3.5 h-3.5" /></button>
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
            {detail.action_url && detail.action_label && (
              <a href={detail.action_url} target="_blank" rel="noopener noreferrer"
                onClick={() => logNotificationEvent(detail.id, "clicked", { url: detail.action_url }).catch(() => {})}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-semibold bg-white text-black hover:bg-zinc-100 transition-colors">
                {detail.action_label} <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            {detail.action2_url && detail.action2_label && (
              <a href={detail.action2_url} target="_blank" rel="noopener noreferrer"
                onClick={() => logNotificationEvent(detail.id, "clicked", { url: detail.action2_url, secondary: true }).catch(() => {})}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium bg-white/[0.06] text-white hover:bg-white/[0.12] border border-white/10 transition-colors">
                {detail.action2_label}
              </a>
            )}
          </div>
          <div className="mt-6 pt-4 border-t border-white/[0.05] flex gap-2">
            <button onClick={() => handleSnooze(detail.id, 24)} className="flex-1 py-2 rounded-lg text-[12px] text-zinc-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 transition-colors inline-flex items-center justify-center gap-1.5">
              <Clock className="w-3.5 h-3.5" /> Snooze 24h
            </button>
            <button onClick={() => handleArchive(detail.id)} className="flex-1 py-2 rounded-lg text-[12px] text-zinc-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 transition-colors inline-flex items-center justify-center gap-1.5">
              <Archive className="w-3.5 h-3.5" /> Archive
            </button>
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
      className="relative w-full max-w-[560px] flex flex-col rounded-3xl overflow-hidden"
      style={{ ...surfaceStyle, maxHeight: "min(80vh, 780px)" }}
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
    { label: "Pinned", rows: [] },
    { label: "Today", rows: [] },
    { label: "Yesterday", rows: [] },
    { label: "This week", rows: [] },
    { label: "Earlier", rows: [] },
  ];
  for (const n of list) {
    const t = new Date(n.created_at).getTime();
    if (n.pinned) buckets[0].rows.push(n);
    else if (t >= startToday) buckets[1].rows.push(n);
    else if (t >= startYest) buckets[2].rows.push(n);
    else if (t >= startWeek) buckets[3].rows.push(n);
    else buckets[4].rows.push(n);
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

  const active = items.filter((n) => !n.archived);
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
      const started = Number(localStorage.getItem("session_started_at") || "0");
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
  id: string; subject: string; from: string; to?: string; date: string; otp: string | null; preview: string; html: string; account_label?: string | null;
}
interface UserData {
  id: string; username: string; name: string; role: "admin" | "user"; totpSecret?: string; mustChangePassword?: boolean; assignedAccounts?: string[] | null; profileAvatar?: string | null; profilePrefs?: UserProfilePrefs;
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
        className={(className || "") + " text-slate-900 placeholder:text-slate-400"}
        autoFocus={autoFocus} required={required} />
      <button type="button" onClick={() => setShow(!show)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors p-1">
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
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
  const seed = `${profile.id || ""}:${profile.username || ""}:${profile.name || ""}`;
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
      <div className={`${className} rounded-xl sm:rounded-2xl ${fallbackColor} flex items-center justify-center shadow-lg shadow-black/30 ring-1 ring-white/10 overflow-hidden`}>
        <span className="text-white text-xl sm:text-3xl font-black drop-shadow-md">{(name || "?").charAt(0).toUpperCase()}</span>
      </div>
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
const RE_SIGNIN = /(sign[\s-]?in code|new sign[\s-]?in|new device|temporary access code|verification code|is using your account|access your account|otp)/i;
const RE_PASSWORD_RESET = /(password (was |has been )?(changed|reset|updated)|reset your password|new password)/i;
const RE_ACCOUNT_UPDATE = /(account (information|info|details) (was |has been )?(changed|updated)|changes to your account|email (address )?(was |has been )?(changed|updated)|new email address|membership (was |has been )?(cancell?ed|updated|paused)|account (was |has been )?(cancell?ed|deleted|closed|paused|on hold)|we[’']re sorry to see you go|payment method (was |has been )?(updated|changed|declined)|update your account|make (changes|any changes) to your account)/i;

function classifyEmail(e: Email): EmailCategory {
  const s = (e.subject || "").toLowerCase();
  if (RE_ACCOUNT_UPDATE.test(s)) return "account_update";
  if (RE_PASSWORD_RESET.test(s)) return "password_reset";
  if (e.otp || RE_SIGNIN.test(s)) return "signin";
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
              <p className="text-slate-500 text-xs">Verify you're human</p>
            </div>
          </div>
        </div>
        <div className="flex justify-center px-6 pb-4 min-h-[78px]">
          <Suspense fallback={<div className="h-[78px] w-[304px] rounded-lg bg-slate-100 animate-pulse" />}>
            <ReCAPTCHA sitekey={siteKey} onChange={(token) => { if (token) onVerify(token); }} />
          </Suspense>
        </div>

        <div className="flex border-t border-slate-100">
          <button onClick={onCancel}
            className="flex-1 py-4 text-sm font-bold text-slate-500 hover:bg-slate-50 transition-colors">
            Cancel
          </button>
          <div className="w-px bg-slate-100" />
          <button onClick={onCancel}
            className="flex-1 py-4 text-sm font-bold text-red-600 hover:bg-red-50 transition-colors">
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
  const [siteKey, setSiteKey] = useState<string | null>(
    cachedBootstrap?.recaptcha?.enabled === true && cachedBootstrap?.recaptcha?.siteKey
      ? cachedBootstrap.recaptcha.siteKey
      : null
  );
  const [showCaptcha, setShowCaptcha] = useState(false);
  const navigate = useNavigate();
  const { checkAuth } = useAuth();

  useEffect(() => {
    let cancelled = false;
    // Always fetch fresh on mount so after logout / avatar change the profile
    // grid reflects the latest data instead of the stale module singleton.
    refreshBootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        setProfiles((bootstrap.users || []).filter((u: UserData) => u.role === "user"));
        if (bootstrap.recaptcha?.enabled === true && bootstrap.recaptcha?.siteKey) {
          setSiteKey(bootstrap.recaptcha.siteKey);
        } else {
          setSiteKey(null);
        }
        setError("");
        setFromCache(false);
      })
      .catch((err) => {
        console.error("Failed to load profiles:", err);
        if (!cancelled && profiles.length === 0) {
          setError("Failed to load profiles. Please try again.");
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

      localStorage.setItem("user", JSON.stringify(data.user));
      markSessionStart();
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
                  className="w-full bg-[#1f1f1f] border border-neutral-800 text-white text-sm rounded-md pl-10 pr-10 py-2.5 outline-none focus:border-neutral-500 placeholder:text-neutral-500"
                />
                {profileSearch && (
                  <button
                    onClick={() => setProfileSearch("")}
                    className="absolute right-5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white p-1"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            )}

            {displayProfiles.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-neutral-500 text-sm">
                  {loading ? "Loading profiles…" : profileSearch ? `No profiles match "${profileSearch}"` : "No profiles yet. Ask admin to create users."}
                </p>
              </div>
            ) : (
              <div className="w-full max-w-5xl mx-auto rounded-2xl border border-white/[0.06] bg-white/[0.015] p-3 sm:p-5">
                <div
                  className="w-full overflow-y-scroll overscroll-contain pr-2 sm:pr-3 py-2 sm:py-3 max-h-[58vh] sm:max-h-[62vh] scroll-smooth [scrollbar-width:thin] [scrollbar-color:#e50914_rgba(255,255,255,0.04)] [&::-webkit-scrollbar]:w-[10px] [&::-webkit-scrollbar-track]:bg-white/[0.03] [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gradient-to-b [&::-webkit-scrollbar-thumb]:from-[#e50914] [&::-webkit-scrollbar-thumb]:to-[#7a0006] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb:hover]:from-[#ff1a25] [&::-webkit-scrollbar-thumb:hover]:to-[#a30009]"
                >
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-x-4 gap-y-7 sm:gap-x-6 sm:gap-y-9 mx-auto pb-4">
                    {displayProfiles.map((profile, i) => (
                      <button
                        key={profile.id}
                        type="button"
                        onClick={() => setSelectedProfile(profile)}
                        className="flex flex-col items-center gap-2 sm:gap-3 group focus:outline-none min-w-0"
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
                    ))}
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
          <CaptchaModal siteKey={siteKey} onVerify={() => { setShowCaptcha(false); executeLogin(); }} onCancel={() => setShowCaptcha(false)} />
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
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const navigate = useNavigate();
  const { checkAuth } = useAuth();

  useEffect(() => {
    (async () => {
      try {
        const bootstrap = await bootstrapFromSupabase();
        if (bootstrap.recaptcha?.enabled === true && bootstrap.recaptcha?.siteKey) {
          setSiteKey(bootstrap.recaptcha.siteKey);
        }
      } catch {}
    })();
  }, []);

  const initiateLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (siteKey) {
      setShowCaptcha(true);
    } else {
      void executeLogin();
    }
  };

  const executeLogin = async () => {
    setLoading(true);
    setError("");
    try {
      if (!checkRateLimit(`admin_${username}`)) throw new Error("Too many attempts. Wait 1 minute.");

      const clientGeo = await requireLoginLocation();
      const data: any = await apiCall("manage-app", { action: "login", username, password, clientGeo });

      if (data.user.role !== "admin") throw new Error("Access denied");
      if (data.pendingToken) localStorage.setItem("pending_admin_token", data.pendingToken);

      if (data.workerUrls && Array.isArray(data.workerUrls) && data.workerUrls.length > 0) {
        storeWorkerUrls(data.workerUrls);
      }

      localStorage.setItem("user", JSON.stringify({ ...data.user, pending: true }));
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
          <button type="submit" disabled={loading}
            className="w-full bg-red-600 text-white font-bold py-4 rounded-2xl hover:bg-red-700 transition-all active:scale-95 disabled:opacity-50">
            {loading ? "Authenticating..." : "Admin Sign In"}
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
          <CaptchaModal siteKey={siteKey} onVerify={() => { setShowCaptcha(false); executeLogin(); }} onCancel={() => setShowCaptcha(false)} />
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

  useEffect(() => {
    const pending = (() => { try { return localStorage.getItem("pending_admin_token"); } catch { return null; } })();
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

  const verifyTelegramOtp = async () => {
    setLoading(true);
    try {
      await apiCall("manage-app", { action: "verify_otp", user_id: user.id, otp });
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

  const verifyTotp = async () => {
    setLoading(true);
    try {
      await apiCall("manage-app", { action: "verify_totp", user_id: user.id, code: totp });
      const finalData = await apiCall("manage-app", { action: "finalize_admin_session", user_id: user.id });
      if (finalData.workerUrls && Array.isArray(finalData.workerUrls) && finalData.workerUrls.length > 0) {
        storeWorkerUrls(finalData.workerUrls);
      }
      if (finalData.sessionToken) localStorage.setItem("session_token", finalData.sessionToken);
      localStorage.removeItem("pending_admin_token");
      localStorage.setItem("admin_auth", "true");
      localStorage.setItem("user", JSON.stringify(finalData.user));
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
        <p className="text-slate-400 text-center text-sm mb-8">
          {step === 1 ? "OTP sent to Telegram" : "Enter Google Authenticator code"}
        </p>

        {step === 1 ? (
          <div className="space-y-6">
            <input type="text" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full bg-slate-950 border border-slate-800 text-white text-center tracking-[0.75em] font-mono text-2xl rounded-2xl py-5 focus:ring-2 focus:ring-red-500 outline-none placeholder:tracking-normal placeholder:text-sm placeholder:text-slate-600"
              placeholder="••••••" maxLength={6} />
            <button onClick={verifyTelegramOtp} disabled={loading || otp.length < 6}
              className="w-full bg-gradient-to-r from-red-600 to-red-700 text-white font-bold py-4 rounded-2xl hover:from-red-500 hover:to-red-600 shadow-lg shadow-red-900/20 transition-all active:scale-[0.98] disabled:opacity-50">
              {loading ? "Verifying..." : "Verify Telegram OTP"}
            </button>
            {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-4 rounded-xl text-center">{error}</div>}
          </div>
        ) : (
          <div className="space-y-6">
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
                    <button onClick={() => { navigator.clipboard.writeText(secretKey); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      className="text-slate-400 hover:text-white transition-colors flex-shrink-0 ml-2">
                      {copied ? <CheckCircle2 className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <input type="text" value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full bg-slate-950 border border-slate-800 text-white text-center tracking-[0.75em] font-mono text-2xl rounded-2xl py-5 focus:ring-2 focus:ring-red-500 outline-none placeholder:tracking-normal placeholder:text-sm placeholder:text-slate-600"
              placeholder="••••••" maxLength={6} />
            <button onClick={verifyTotp} disabled={loading || totp.length < 6}
              className="w-full bg-gradient-to-r from-red-600 to-red-700 text-white font-bold py-4 rounded-2xl hover:from-red-500 hover:to-red-600 shadow-lg shadow-red-900/20 transition-all active:scale-[0.98] disabled:opacity-50">
              {loading ? "Verifying..." : "Verify & Enter Admin"}
            </button>
            {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-4 rounded-xl text-center">{error}</div>}
          </div>
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
  const [riskFilter, setRiskFilter] = useState<string>("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res: any = await apiCall("manage-app", { action: "list_login_events", limit: 300, search: search || undefined, risk: riskFilter || undefined });
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
  const riskColor = (r: string) => r === "critical" ? "bg-red-600 text-white" : r === "high" ? "bg-orange-500 text-white" : r === "medium" ? "bg-amber-400 text-slate-900" : "bg-emerald-500 text-white";

  return (
    <section className="bg-white p-4 sm:p-6 rounded-2xl border shadow-sm">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h2 className="font-black text-base sm:text-lg flex items-center gap-2 mr-auto">
          <div className="bg-red-50 p-1.5 rounded-lg"><ShieldCheck className="w-4 h-4 text-red-600" /></div>
          Login Events <span className="text-xs font-normal text-slate-500">({events.length})</span>
        </h2>
        <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === "Enter" && load()}
          placeholder="Search user/IP/city/ISP…" className="border rounded-lg px-3 py-1.5 text-sm w-48" />
        <select value={riskFilter} onChange={e => { setRiskFilter(e.target.value); }} className="border rounded-lg px-2 py-1.5 text-sm">
          <option value="">All risks</option><option value="safe">Safe</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
        </select>
        <button onClick={load} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-semibold">Refresh</button>
        <button onClick={exportCsv} className="px-3 py-1.5 bg-slate-900 text-white hover:bg-slate-800 rounded-lg text-sm font-semibold">CSV</button>
        <button onClick={exportJson} className="px-3 py-1.5 bg-slate-700 text-white hover:bg-slate-800 rounded-lg text-sm font-semibold">JSON</button>
      </div>
      {loading ? (
        <div className="py-12 text-center text-slate-500 text-sm">Loading…</div>
      ) : events.length === 0 ? (
        <div className="py-12 text-center text-slate-500 text-sm">No login events yet.</div>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-xs sm:text-sm min-w-[900px]">
            <thead className="bg-slate-50 text-left text-slate-600 uppercase text-[10px] tracking-wider">
              <tr>
                <th className="p-2">Time</th><th className="p-2">User</th><th className="p-2">Risk</th>
                <th className="p-2">Device</th><th className="p-2">Browser · OS</th>
                <th className="p-2">IP</th><th className="p-2">ISP</th><th className="p-2">Location</th>
                <th className="p-2">Flags</th><th className="p-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.map(e => (
                <>
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="p-2 whitespace-nowrap text-slate-600">{new Date(e.created_at).toLocaleString()}</td>
                    <td className="p-2 font-semibold">{e.username}<div className="text-[10px] text-slate-400">{e.role}</div></td>
                    <td className="p-2"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${riskColor(e.risk_score || "safe")}`}>{(e.risk_score || "safe").toUpperCase()}</span>{e.is_new_device && <div className="text-[10px] text-orange-600 mt-1">🆕 new device</div>}</td>
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
                      {e.impossible_travel && <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px]">IMP-TRAVEL</span>}
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
                    <tr><td colSpan={10} className="p-2 bg-slate-50"><pre className="text-[10px] overflow-x-auto max-h-96">{JSON.stringify(e, null, 2)}</pre></td></tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AdminPanel() {
  const [activeTab, setActiveTab] = useState<"users" | "security" | "emails" | "settings" | "notifications" | "inbox" | "logins">("users");
  const [users, setUsers] = useState<UserData[]>([]);
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
  const [captchaEnabled, setCaptchaEnabled] = useState(false);
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
  const prevSavedVersionToRef = useRef<string>("");


  // Notifications tab
  const [adminNotifs, setAdminNotifs] = useState<any[]>([]);
  const [notifTitle, setNotifTitle] = useState("");
  const [notifBody, setNotifBody] = useState("");
  const [notifDescription, setNotifDescription] = useState("");
  const [notifImageUrl, setNotifImageUrl] = useState("");
  const [notifCategory, setNotifCategory] = useState<"announcement" | "update" | "security" | "maintenance" | "promo" | "billing">("announcement");
  const [notifPriority, setNotifPriority] = useState<"low" | "normal" | "high" | "critical">("normal");
  const [notifActionUrl, setNotifActionUrl] = useState("");
  const [notifActionLabel, setNotifActionLabel] = useState("");
  const [notifPinned, setNotifPinned] = useState(false);
  const [notifAudience, setNotifAudience] = useState<"all" | "user">("all");
  const [notifTargetUser, setNotifTargetUser] = useState<string>("");
  const [notifExpiresDays, setNotifExpiresDays] = useState<string>("");
  const [sendingNotif, setSendingNotif] = useState(false);

  // Inbox tab
  const [inboxMode, setInboxMode] = useState<"all" | "label" | "days">("days");
  const [inboxLabel, setInboxLabel] = useState("");
  const [inboxDays, setInboxDays] = useState("30");
  const [inboxConfirm, setInboxConfirm] = useState("");
  const [clearingInbox, setClearingInbox] = useState(false);

  const [primaryCfInput, setPrimaryCfInput] = useState("");
  const [editingAccountUrls, setEditingAccountUrls] = useState<number | null>(null);
  const [editCfUrls, setEditCfUrls] = useState<string[]>([]);
  const [editCfInput, setEditCfInput] = useState("");
  const navigate = useNavigate();
  const { user: currentUser, checkAuth } = useAuth();

  const [stats, setStats] = useState({ totalUsers: 0, totalEmails: 0 });

  const getAvailableAccounts = (): string[] => {
    const labels = ["Primary"];
    emailAccounts.forEach(acc => {
      if (acc.label && !labels.includes(acc.label)) labels.push(acc.label);
    });
    return labels;
  };

  useEffect(() => {
    (async () => {
      try {
        const usersData = await apiCall("manage-app", { action: "list" });
        const usersList = usersData.users || [];
        setUsers(usersList);
        setStats(prev => ({ ...prev, totalUsers: usersList.length }));
      } catch { }

      try {
        const recaptcha = await apiCall("manage-app", { action: "get_settings", key: "recaptcha" });
        if (recaptcha.value) {
          setSiteKey(recaptcha.value.siteKey || "");
          setSecretKeyVal(recaptcha.value.secretKey || "");
          setCaptchaEnabled(recaptcha.value.enabled === true);
        }
      } catch { }

      try {
        const config = await apiCall("manage-app", { action: "get_settings", key: "config" });
        if (config.value) {
          const c = config.value as any;
          setServerConfig({
            TELEGRAM_BOT_TOKEN: c.TELEGRAM_BOT_TOKEN || "",
            TELEGRAM_CHAT_ID: c.TELEGRAM_CHAT_ID || "",
            IMAP_HOST: c.IMAP_HOST || "",
            IMAP_PORT: c.IMAP_PORT || "",
            IMAP_USER: c.IMAP_USER || "",
            IMAP_PASSWORD: c.IMAP_PASSWORD || "",
          });
        }
      } catch { }

      try {
        const pcf = await apiCall("manage-app", { action: "get_settings", key: "primary_cloudflare_urls" });
        if (pcf.value && Array.isArray(pcf.value)) {
          setPrimaryCfUrls(pcf.value);
        }
      } catch { }

      try {
        const filters = await apiCall("manage-app", { action: "get_settings", key: "email_filters" });
        if (filters.value) {
          setShowSignInCodes(filters.value.showSignInCodes !== false);
          setShowPasswordResets(filters.value.showPasswordResets === true);
          setShowAccountUpdates(filters.value.showAccountUpdates === true);
          setEmailFiltersCache(filters.value);
        }
      } catch { }

      try {
        const accounts = await apiCall("manage-app", { action: "get_settings", key: "email_accounts" });
        if (accounts.value && Array.isArray(accounts.value)) {
          const migrated = accounts.value.map((acc: any) => {
            if (acc.cloudflareUrls && Array.isArray(acc.cloudflareUrls)) return acc;
            const urls: string[] = [];
            if (acc.cloudflareUrl && acc.cloudflareUrl.trim()) urls.push(acc.cloudflareUrl.trim());
            const { cloudflareUrl, ...rest } = acc;
            return { ...rest, cloudflareUrls: urls };
          });
          setEmailAccounts(migrated);
        }
      } catch { }

      try {
        const sc = await apiCall("manage-app", { action: "get_settings", key: "session_config" });
        const m = Number(sc?.value?.timeoutMinutes);
        if (Number.isFinite(m) && m >= 0) setSessionTimeoutMin(String(m));
      } catch { }

      try {
        const sc = await apiCall("manage-app", { action: "get_settings", key: "admin_session_config" });
        const m = Number(sc?.value?.timeoutMinutes);
        if (Number.isFinite(m) && m >= 0) setAdminSessionTimeoutMin(String(m));
      } catch { }

      try {
        const ipw = await apiCall("manage-app", { action: "get_settings", key: "ipwho_alert" });
        setIpwhoAlertEnabled(ipw?.value?.enabled === true);
      } catch { }

      try {
        const mnt = await apiCall("manage-app", { action: "get_settings", key: "maintenance" });
        if (mnt?.value) {
          setMaintenanceEnabled(mnt.value.enabled === true);
          setMaintenanceTitle(mnt.value.title || "");
          setMaintenanceMessage(mnt.value.message || "");
          setMaintenanceVersionFrom(mnt.value.versionFrom || "");
          setMaintenanceVersionTo(mnt.value.versionTo || "");
          prevSavedVersionToRef.current = mnt.value.versionTo || "";
          // Convert stored ISO to local "YYYY-MM-DDTHH:mm" for the datetime-local input.
          const toLocalInput = (iso: string) => {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return "";
            const pad = (n: number) => String(n).padStart(2, "0");
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
          };
          if (mnt.value.startsAt) setMaintenanceStartsAt(toLocalInput(mnt.value.startsAt));
          if (mnt.value.endsAt) setMaintenanceEndsAt(toLocalInput(mnt.value.endsAt));
        }
      } catch { }



      try {
        const nl = await apiCall("manage-app", { action: "admin_list_notifications" });
        if (Array.isArray(nl?.notifications)) setAdminNotifs(nl.notifications);
      } catch { }
    })();
  }, []);


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
    const prevTo = prevSavedVersionToRef.current || "";
    let nextVersionTo = maintenanceVersionTo.trim();
    let autoBumped = false;
    if (!nextVersionTo || nextVersionTo === prevTo) {
      nextVersionTo = bumpPatch(prevTo || "2.4.3"); // 2.4.3 -> bump -> 2.4.4 on first save
      autoBumped = true;
    }
    const nextVersionFrom = maintenanceVersionFrom.trim() || prevTo || "2.4.4";

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
      // Persist worker URLs to localStorage for bootstrap
      storeWorkerUrls(primaryCfUrls);
      toast.success("Server configuration saved!");
    } catch (err) {
      toast.error("Failed to save: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSavingConfig(false);
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
        action_url: notifActionUrl.trim() || null,
        action_label: notifActionLabel.trim() || null,
        pinned: notifPinned,
        audience: notifAudience,
        target_user_id: notifAudience === "user" ? notifTargetUser : null,
        expiresInDays: notifExpiresDays ? Number(notifExpiresDays) : null,
      });
      toast.success("🔔 Notification sent");
      setNotifTitle(""); setNotifBody(""); setNotifDescription(""); setNotifImageUrl("");
      setNotifActionUrl(""); setNotifActionLabel(""); setNotifPinned(false);
      setNotifExpiresDays("");
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
      const data = await apiCall("manage-app", { action: "impersonate", target_user_id: targetUser.id });
      const adminUser = localStorage.getItem("user");
      const adminToken = localStorage.getItem("session_token");
      const adminAuth = localStorage.getItem("admin_auth");
      localStorage.setItem("admin_backup", JSON.stringify({ user: adminUser, token: adminToken, adminAuth }));
      localStorage.setItem("user", JSON.stringify(data.user));
      if (data.sessionToken) localStorage.setItem("session_token", data.sessionToken);
      markSessionStart();
      localStorage.removeItem("admin_auth");
      toast.success(`Viewing as ${targetUser.name}`);
      window.location.href = "/viewer";
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to impersonate user");
    }
  };

  const createUser = async () => {
    if (!newUsername || !newPassword || !newName) { toast.error("Please fill all fields"); return; }
    try {
      await apiCall("manage-app", {
        action: "create", username: newUsername, password: newPassword, name: newName, role: "user",
        assigned_accounts: newUserAccounts.length > 0 ? newUserAccounts : null,
      });
      setNewUsername(""); setNewPassword(""); setNewName(""); setNewUserAccounts([]);
      toast.success("User created!");
      const data = await apiCall("manage-app", { action: "list" });
      setUsers(data.users || []);
    } catch (err) {
      toast.error("Failed: " + (err instanceof Error ? err.message : String(err)));
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
      setEditingUserAccounts(null);
      const data = await apiCall("manage-app", { action: "list" });
      setUsers(data.users || []);
      toast.success("User accounts updated!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  };

  const tabs = [
    { id: "users" as const, label: "Users", icon: Users },
    { id: "logins" as const, label: "Login Events", icon: ShieldCheck },
    { id: "notifications" as const, label: "Notifications", icon: Bell },
    { id: "inbox" as const, label: "Inbox", icon: Mail },
    { id: "security" as const, label: "Security", icon: ShieldCheck },
    { id: "emails" as const, label: "Email Accounts", icon: Server },
    { id: "settings" as const, label: "Settings", icon: Settings },
  ];


  return (
    <div className="admin-panel min-h-[100dvh] bg-slate-50 overflow-x-hidden text-slate-900">
      <header className="bg-white border-b px-3 sm:px-6 py-3 sm:py-4 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto flex justify-between items-center gap-2">
          <h1 className="text-sm sm:text-xl font-black flex items-center gap-2 min-w-0 truncate">
            <div className="bg-red-600 p-1.5 sm:p-2 rounded-xl">
              <Settings className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
            </div>
            <span className="hidden sm:inline">Admin Control Panel</span>
            <span className="sm:hidden">Admin</span>
          </h1>
          <button onClick={() => { localStorage.clear(); navigate("/"); }} className="p-2 hover:bg-slate-100 rounded-full transition-colors" title="Logout">
            <LogOut className="w-5 h-5 text-slate-400" />
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
                  <p className="text-[10px] text-slate-400 mt-1">Leave empty = access all accounts</p>
                </div>

                <button onClick={createUser}
                  className="w-full bg-slate-900 text-white font-bold py-3 rounded-xl hover:bg-slate-800 transition-all text-sm">
                  Create User
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
                        <div className={`w-10 h-10 rounded-xl ${u.role === "admin" ? "bg-red-500" : "bg-blue-500"} flex items-center justify-center`}>
                          <span className="text-white font-black text-sm">{u.name.charAt(0).toUpperCase()}</span>
                        </div>
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
                            <p className="text-[10px] text-slate-400 mt-0.5">All accounts</p>
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
          </div>
        )}

        {activeTab === "logins" && (
          <LoginEventsPanel />
        )}

        {activeTab === "notifications" && (
          <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_1fr] gap-4 sm:gap-6">
            {/* --- Composer --- */}
            <section className="bg-white p-5 sm:p-6 rounded-2xl border shadow-sm">
              <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                <div className="bg-red-50 p-1.5 rounded-lg"><Bell className="w-4 h-4 text-red-600" /></div>
                Compose Notification
              </h2>
              <div className="space-y-3">
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Title</label>
                  <input value={notifTitle} onChange={(e) => setNotifTitle(e.target.value)} placeholder="e.g. New content available"
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Short body (list preview)</label>
                  <textarea value={notifBody} onChange={(e) => setNotifBody(e.target.value)} placeholder="One or two lines shown in the list" rows={2}
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Long description (detail view)</label>
                  <textarea value={notifDescription} onChange={(e) => setNotifDescription(e.target.value)} placeholder="Full description shown when the user opens it" rows={4}
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Hero image URL (https)</label>
                  <input value={notifImageUrl} onChange={(e) => setNotifImageUrl(e.target.value)} placeholder="https://…/image.jpg"
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                  <p className="text-[10.5px] text-slate-400 mt-1">Paste any https image URL. Cloudflare R2 uploader coming next once credentials are added.</p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Category</label>
                    <div className="flex flex-wrap gap-1.5">
                      {(["announcement","update","security","maintenance","promo","billing"] as const).map((c) => (
                        <button key={c} type="button" onClick={() => setNotifCategory(c)}
                          className={`px-2.5 py-1 rounded-full text-[11px] font-medium capitalize border transition-colors ${notifCategory === c ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"}`}>
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">Priority</label>
                    <div className="flex flex-wrap gap-1.5">
                      {(["low","normal","high","critical"] as const).map((p) => {
                        const dot = p === "critical" ? "bg-rose-500" : p === "high" ? "bg-amber-500" : p === "normal" ? "bg-sky-500" : "bg-zinc-400";
                        return (
                          <button key={p} type="button" onClick={() => setNotifPriority(p)}
                            className={`px-2.5 py-1 rounded-full text-[11px] font-medium capitalize border inline-flex items-center gap-1.5 transition-colors ${notifPriority === p ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${dot}`} /> {p}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input value={notifActionLabel} onChange={(e) => setNotifActionLabel(e.target.value)} placeholder="CTA label (e.g. Watch now)"
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                  <input value={notifActionUrl} onChange={(e) => setNotifActionUrl(e.target.value)} placeholder="CTA URL (https://…)"
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                </div>

                <div className="flex flex-wrap gap-4 items-center text-sm">
                  <label className="flex items-center gap-2 text-slate-800">
                    <input type="checkbox" checked={notifPinned} onChange={(e) => setNotifPinned(e.target.checked)} />
                    <Pin className="w-3.5 h-3.5" /> Pin to top
                  </label>
                  <label className="flex items-center gap-2 text-slate-800">
                    <input type="radio" checked={notifAudience === "all"} onChange={() => setNotifAudience("all")} /> All users
                  </label>
                  <label className="flex items-center gap-2 text-slate-800">
                    <input type="radio" checked={notifAudience === "user"} onChange={() => setNotifAudience("user")} /> Specific user
                  </label>
                </div>
                {notifAudience === "user" && (
                  <select value={notifTargetUser} onChange={(e) => setNotifTargetUser(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900">
                    <option value="">— select user —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.username}</option>)}
                  </select>
                )}
                <input value={notifExpiresDays} onChange={(e) => setNotifExpiresDays(e.target.value)} placeholder="Expires in (days, optional)" type="number" min="1"
                  className="w-full px-3 py-2 border rounded-lg text-sm text-slate-900" />
                <button onClick={sendNotification} disabled={sendingNotif}
                  className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white font-bold py-2.5 rounded-lg text-sm flex items-center justify-center gap-2">
                  <Send className="w-4 h-4" /> {sendingNotif ? "Sending…" : "Send Notification"}
                </button>
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
                <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
                  <div className="bg-slate-100 p-1.5 rounded-lg"><MessageSquare className="w-4 h-4 text-slate-700" /></div>
                  Past Notifications
                </h2>
                <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                  {adminNotifs.length === 0 && <p className="text-sm text-slate-500">No notifications yet.</p>}
                  {adminNotifs.map((n) => (
                    <div key={n.id} className="border rounded-lg p-3 flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          {n.pinned && <Pin className="w-3 h-3 text-amber-500" />}
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-700 capitalize">{n.category || "announcement"}</span>
                          <span className={`w-1.5 h-1.5 rounded-full ${n.priority === "critical" ? "bg-rose-500" : n.priority === "high" ? "bg-amber-500" : n.priority === "normal" ? "bg-sky-500" : "bg-zinc-400"}`} />
                        </div>
                        <p className="font-bold text-sm text-slate-900 truncate">{n.title}</p>
                        <p className="text-xs text-slate-600 line-clamp-2">{n.body}</p>
                        <p className="text-[11px] text-slate-400 mt-1">
                          {n.audience === "all" ? "All users" : "Specific"} • Delivered {n.seenCount || 0} · Read {n.readCount || 0} · Clicked {n.clickCount || 0} / {n.totalRecipients || 0}
                        </p>
                      </div>
                      <button onClick={() => deleteNotification(n.id)} className="text-red-600 hover:text-red-700 text-xs font-bold flex-shrink-0">Delete</button>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
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

                    {[
                      {
                        step: "1",
                        title: "Cloudflare Account Banao",
                        points: [
                          "Browser me jaao → dash.cloudflare.com",
                          "Sign Up karo (free hai)",
                          "Email verify karo aur login karo",
                        ],
                      },
                      {
                        step: "2",
                        title: "Worker Create Karo",
                        points: [
                          "Left menu me 'Workers & Pages' pe click karo",
                          "'Create' button dabao",
                          "'Create Worker' select karo",
                          "Worker ka naam do (e.g. email-worker)",
                          "'Deploy' pe click karo",
                        ],
                      },
                      {
                        step: "3",
                        title: "Worker Code Paste Karo",
                        points: [
                          "Deploy ke baad 'Edit Code' pe click karo",
                          "Pura existing code select karke DELETE karo",
                          "Apne project ka cloudflare-worker/worker.js file ka code copy karke PASTE karo",
                          "'Save and Deploy' pe click karo",
                        ],
                      },
                      {
                        step: "4",
                        title: "KV Storage Banao",
                        points: [
                          "Left menu → 'Workers & Pages' → 'KV' pe jaao",
                          "'Create a namespace' pe click karo",
                          "Naam do: EMAIL_CACHE",
                          "'Add' pe click karo",
                          "Wapas worker pe jaao → 'Settings' tab → 'Bindings'",
                          "'Add' → 'KV Namespace' select karo",
                          "Variable name: EMAIL_CACHE, namespace: jo abhi banaya",
                          "'Save' karo",
                        ],
                      },
                      {
                        step: "5",
                        title: "3 Secrets Set Karo (IMPORTANT!)",
                        points: [
                          "Worker → 'Settings' tab → 'Variables and Secrets'",
                          "'Add' pe click karo aur ye 3 secrets ek-ek karke add karo:",
                          "🔑 SUPABASE_URL → apna Supabase project URL",
                          "🔑 SUPABASE_KEY → apna Supabase anon key",
                          "🔑 SESSION_SECRET → apna Supabase service_role key",
                          "'Save and Deploy' pe click karo",
                        ],
                        warning: "⚠️ Bina SESSION_SECRET ke worker kaam nahi karega!",
                      },
                      {
                        step: "6",
                        title: "Worker URL Copy Karo",
                        points: [
                          "Worker page pe jaao — top pe URL dikhega:",
                          "e.g. https://email-worker.yourname.workers.dev",
                          "Ye URL copy karo",
                          "Is app me Settings → Worker URLs me paste karo",
                          "✅ Done! Ab emails worker se aayenge",
                        ],
                      },
                    ].map((s) => (
                      <details key={s.step} className="bg-white rounded-lg border border-blue-100 overflow-hidden">
                        <summary className="flex items-center gap-2 p-2.5 cursor-pointer active:bg-blue-50 transition-colors">
                          <span className="bg-blue-600 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0">{s.step}</span>
                          <span className="text-xs font-bold text-slate-800">{s.title}</span>
                        </summary>
                        <div className="px-2.5 pb-2.5">
                          <ul className="space-y-1">
                            {s.points.map((p, i) => (
                              <li key={i} className="text-[11px] text-slate-700 flex gap-1.5">
                                <span className="text-blue-400 mt-0.5 flex-shrink-0">•</span>
                                <span>{p}</span>
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
                        <span className="text-xs font-bold text-yellow-800">🔄 Naya Email Account Add Karna?</span>
                      </summary>
                      <div className="px-2.5 pb-2.5">
                        <ol className="text-[11px] text-yellow-900 space-y-1.5 ml-4 list-decimal">
                          <li>Cloudflare me ek naya Worker banao (Step 2-6 repeat karo, alag naam do)</li>
                          <li>Same 3 secrets set karo naye worker pe</li>
                          <li>Is app me "Email Accounts" tab pe jaao</li>
                          <li>Naya account add karo IMAP details ke saath</li>
                          <li>Us account me naye worker ka URL add karo</li>
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
                  {(() => {
                    const [d = "", t = ""] = (maintenanceStartsAt || "").split("T");
                    const time = t.slice(0, 5);
                    const today = new Date();
                    const pad = (n: number) => String(n).padStart(2, "0");
                    const fallbackDate = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
                    return (
                      <div className="flex gap-2">
                        <input
                          type="date"
                          value={d}
                          onChange={(e) => setMaintenanceStartsAt(e.target.value ? `${e.target.value}T${time || "00:00"}` : "")}
                          className="flex-1 min-w-0 bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm"
                        />
                        <input
                          type="time"
                          value={time}
                          onChange={(e) => setMaintenanceStartsAt(`${d || fallbackDate}T${e.target.value || "00:00"}`)}
                          className="w-[130px] bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm"
                        />
                      </div>
                    );
                  })()}
                  <p className="text-[10.5px] text-slate-500 mt-1 ml-1">
                    {maintenanceStartsAt
                      ? `Site locks at ${new Date(maintenanceStartsAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", hour12: true, day: "numeric", month: "short" })}`
                      : "Leave empty to start immediately when enabled."}
                  </p>
                </div>
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Back online at (date + time)</label>
                  {(() => {
                    const [d = "", t = ""] = (maintenanceEndsAt || "").split("T");
                    const time = t.slice(0, 5);
                    const today = new Date();
                    const pad = (n: number) => String(n).padStart(2, "0");
                    const fallbackDate = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
                    return (
                      <div className="flex gap-2">
                        <input
                          type="date"
                          value={d}
                          onChange={(e) => setMaintenanceEndsAt(e.target.value ? `${e.target.value}T${time || "00:00"}` : "")}
                          className="flex-1 min-w-0 bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm"
                        />
                        <input
                          type="time"
                          value={time}
                          onChange={(e) => setMaintenanceEndsAt(`${d || fallbackDate}T${e.target.value || "00:00"}`)}
                          className="w-[130px] bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm"
                        />
                      </div>
                    );
                  })()}
                  <p className="text-[10.5px] text-slate-500 mt-1 ml-1">
                    {maintenanceEndsAt
                      ? `Site auto-unlocks at ${new Date(maintenanceEndsAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", hour12: true, day: "numeric", month: "short" })}`
                      : "Leave empty for open-ended maintenance."}
                  </p>
                </div>
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Current version</label>
                  <input type="text" value={maintenanceVersionFrom} onChange={(e) => setMaintenanceVersionFrom(e.target.value)}
                    placeholder="e.g. 2.4.1"
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm font-mono" />
                </div>
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-400 uppercase mb-1 ml-1 tracking-wider">Upgrading to (upgrade-only)</label>
                  <input type="text" value={maintenanceVersionTo} onChange={(e) => setMaintenanceVersionTo(e.target.value)}
                    placeholder="e.g. 2.5.0"
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-amber-500 text-sm font-mono" />
                  <p className="text-[10.5px] text-slate-500 mt-1 ml-1">Downgrades are blocked by the server.</p>
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
      const stored = JSON.parse(localStorage.getItem("user") || "{}");
      stored.mustChangePassword = false;
      localStorage.setItem("user", JSON.stringify(stored));
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
  const user = JSON.parse(localStorage.getItem("user") || "{}");
  const cacheKey = `cached_emails_v1:${user.id || "anon"}`;
  const [profilePrefs, setProfilePrefs] = useState<UserProfilePrefs>(() => user.profilePrefs || {});
  const saveProfilePrefsLocally = useCallback((nextPrefs: UserProfilePrefs) => {
    setProfilePrefs(nextPrefs);
    try {
      const stored = JSON.parse(localStorage.getItem("user") || "{}");
      stored.profilePrefs = nextPrefs;
      stored.profileAvatar = nextPrefs.avatarId || null;
      localStorage.setItem("user", JSON.stringify(stored));
    } catch {}
  }, []);
  const readLocalCachedEmails = useCallback((): Email[] => {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? filterVisibleEmails(parsed as Email[], profilePrefs) : [];
    } catch {
      return [];
    }
  }, [cacheKey, profilePrefs]);
  const [emails, setEmailsRaw] = useState<Email[]>(() => {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return filterVisibleEmails(parsed as Email[], user.profilePrefs || {});
      }
    } catch {}
    return [];
  });
  const setEmails = useCallback((next: Email[]) => {
    const visible = filterVisibleEmails(next, profilePrefs);
    setEmailsRaw(visible);
    try { localStorage.setItem(cacheKey, JSON.stringify(visible.slice(0, 200))); } catch {}
  }, [cacheKey, profilePrefs]);
  const showLocalCacheNow = useCallback(() => {
    const cached = readLocalCachedEmails();
    if (cached.length > 0) {
      cached.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setEmailsRaw(cached);
      setError(null);
      setLastUpdated(new Date());
    }
    return cached.length;
  }, [readLocalCachedEmails]);
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [otpCopied, setOtpCopied] = useState(false);
  const navigate = useNavigate();
  const [showChangePassword, setShowChangePassword] = useState(!!user.mustChangePassword);
  const [showProfile, setShowProfile] = useState(false);
  const [forcedPasswordChange] = useState(!!user.mustChangePassword);
  const isImpersonating = !!localStorage.getItem("admin_backup");

  const [refreshing, setRefreshing] = useState(false);
  const [resolvedWorkerUrls, setResolvedWorkerUrls] = useState<string[]>(() => getStoredWorkerUrls());
  const [workerUrlMap, setWorkerUrlMap] = useState<WorkerUrlMap>({ primary: [], byAccount: {} });
  const [workerUrlsLoading, setWorkerUrlsLoading] = useState(true);
  const workerUrlLoaded = React.useRef(false);

  const backToAdmin = () => {
    try {
      const backup = JSON.parse(localStorage.getItem("admin_backup") || "{}");
      if (backup.user) localStorage.setItem("user", backup.user);
      if (backup.token) localStorage.setItem("session_token", backup.token);
      if (backup.adminAuth) localStorage.setItem("admin_auth", backup.adminAuth);
      localStorage.removeItem("admin_backup");
      navigate("/admin/dashboard");
      window.location.reload();
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

  const fetchFromWorkers = useCallback(async (path: string, method: string, body?: any, urlOverride?: string[]): Promise<Response | null> => {
    const token = getSessionToken();
    const urls = shuffleArray(urlOverride || resolvedWorkerUrls);
    for (const cfUrl of urls) {
      try {
        const headers: Record<string, string> = {};
        if (token) headers["X-Session-Token"] = token;
        if (body) headers["Content-Type"] = "application/json";
        const res = await fetch(`${cfUrl}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (res.status === 404 || res.status === 405 || res.status === 502) {
          console.warn(`[worker] ${cfUrl} returned ${res.status}, trying next`);
          continue;
        }
        return res;
      } catch (err) {
        console.warn(`[worker] ${cfUrl} unreachable, trying next:`, err);
        continue;
      }
    }
    return null;
  }, [resolvedWorkerUrls]);

  const loadCachedEmails = useCallback(async () => {
    try {
      let emailData: any = null;

      // Try workers first
      if (resolvedWorkerUrls.length > 0) {
        const cacheUrls = workerUrlMap.primary.length > 0 ? workerUrlMap.primary : resolvedWorkerUrls;
        const workerRes = await fetchFromWorkers("/api/emails", "GET", undefined, cacheUrls);
        if (workerRes && workerRes.ok) {
          emailData = await workerRes.json();
          // If Worker KV has an old empty cache, immediately read the DB cache instead.
          if (Array.isArray(emailData) && emailData.length === 0) emailData = null;
        } else if (workerRes && !workerRes.ok) {
          const errData = await workerRes.json().catch(() => ({}));
          console.warn("[loadCachedEmails] Worker returned error:", errData?.error);
        }
      }

      // Fallback: fetch directly from Supabase edge function
      if (!emailData) {
        console.log("[loadCachedEmails] Workers unavailable, falling back to direct Supabase");
        const token = getSessionToken();
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${supabaseKey}`,
          "apikey": supabaseKey,
        };
        if (token) headers["X-Session-Token"] = token;

        const bodyPayload: any = { mode: "cache" };

        const res = await fetch(`${supabaseUrl}/functions/v1/fetch-emails`, {
          method: "POST", headers, body: JSON.stringify(bodyPayload),
        });
        if (res.ok) {
          emailData = await res.json();
        } else {
          const errData = await res.json().catch(() => ({}));
          setError(errData?.error || `Failed to load emails (${res.status})`);
          return 0;
        }
      }

      const emailList = (Array.isArray(emailData) ? emailData : []) as Email[];
      emailList.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setEmails(emailList);
      setError(null);
      setLastUpdated(new Date());
      return filterVisibleEmails(emailList, profilePrefs).length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load emails";
      setError(msg);
      return 0;
    }
  }, [fetchFromWorkers, profilePrefs, resolvedWorkerUrls.length, workerUrlsLoading, workerUrlMap.primary, setEmails]);

  const syncViaWorker = useCallback(async () => {
    const { primary, byAccount } = workerUrlMap;
    const accountLabelsWithWorkers = Object.keys(byAccount);
    const hasAnyWorker = resolvedWorkerUrls.length > 0;

    // Direct Supabase sync fallback
    const syncDirectSupabase = async (accountLabels?: string[]) => {
      const token = getSessionToken();
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey}`,
        "apikey": supabaseKey,
      };
      if (token) headers["X-Session-Token"] = token;
        const body: any = { mode: "sync_async", source: "user_refresh" };
      if (accountLabels) body.accountLabels = accountLabels;
      const res = await fetch(`${supabaseUrl}/functions/v1/fetch-emails`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Sync failed (${res.status})`);
      }
    };

    if (!hasAnyWorker) {
      // No workers at all — sync directly via Supabase
      console.log("[sync] No workers configured, syncing directly via Supabase");
      await syncDirectSupabase();
      return;
    }

    const syncPromises: Promise<void>[] = [];

    // Per-account syncs through their dedicated workers
    for (const label of accountLabelsWithWorkers) {
      const accountWorkerUrls = byAccount[label];
      syncPromises.push((async () => {
        const urlsToTry = [...accountWorkerUrls, ...primary];
        const res = await fetchFromWorkers("/api/emails/sync", "POST", { mode: "sync_async", source: "user_refresh", accountLabels: [label] }, urlsToTry);
        if (!res || !res.ok) {
          console.warn(`[sync] Workers failed for "${label}", falling back to Supabase`);
          await syncDirectSupabase([label]);
        } else {
          console.log(`[sync] Account "${label}" synced via dedicated worker`);
        }
      })());
    }

    // Remaining accounts sync through primary workers (with Supabase fallback)
    if (primary.length > 0) {
      syncPromises.push((async () => {
        const res = await fetchFromWorkers("/api/emails/sync", "POST", { mode: "sync_async", source: "user_refresh" }, primary);
        if (!res || !res.ok) {
          console.warn("[sync] Primary workers failed, falling back to Supabase");
          await syncDirectSupabase();
        }
      })());
    } else if (accountLabelsWithWorkers.length === 0) {
      const res = await fetchFromWorkers("/api/emails/sync", "POST", { mode: "sync_async", source: "user_refresh" });
      if (!res || !res.ok) {
        console.warn("[sync] All workers failed, falling back to Supabase");
        await syncDirectSupabase();
      }
    }

    await Promise.allSettled(syncPromises);
  }, [fetchFromWorkers, resolvedWorkerUrls.length, workerUrlMap]);

  const fetchEmails = async () => {
    if (refreshing) return;
    setRefreshing(true);
    const before = showLocalCacheNow() || emails.length;
    const toastId = toast.loading("Checking Netflix mail…");
    try {
      // Refresh must never blank or block: DB cache first, then slow IMAP sync in background.
      const cachedCount = await loadCachedEmails();
      setRefreshing(false);
      const baseline = Math.max(before, cachedCount);

      syncViaWorker()
        .then(() => new Promise(resolve => setTimeout(resolve, 4000)))
        .then(() => loadCachedEmails())
        .then((after) => {
          const newCount = after - baseline;
          if (newCount > 0) {
            toast.success(`📬 ${newCount} new email${newCount === 1 ? "" : "s"} arrived`, {
              id: toastId,
              duration: 3500,
              style: {
                background: "linear-gradient(135deg, #7c1d6f 0%, #c026d3 50%, #e11d48 100%)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.15)",
                boxShadow: "0 10px 30px -10px rgba(225,29,72,0.55)",
                fontWeight: 700,
              },
            });
          } else {
            toast.success("✓ Inbox already up to date", { id: toastId, duration: 2200 });
          }
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : "Sync failed";
          toast.error(msg, {
            id: toastId,
            duration: 4000,
            icon: "⚠️",
            style: {
              background: "#1f0a12",
              color: "#fff",
              border: "1px solid #e11d48",
              boxShadow: "0 10px 30px -10px rgba(225,29,72,0.55)",
              fontWeight: 700,
            },
          });
        })
        .finally(() => setRefreshing(false));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load";
      toast.error(msg);
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
    try { localStorage.setItem(cacheKey, JSON.stringify([])); } catch {}

    try {
      await apiCall("manage-app", { action: "update_profile_prefs", profile_prefs: nextPrefs });
      toast.success("Old emails deleted for this profile");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save delete setting");
    }
  };

  // Load cached emails immediately on mount — local first, no blocking blank screen.
  useEffect(() => {
    let cancelled = false;
    showLocalCacheNow();
    setLoading(false);

    loadCachedEmails().finally(() => {
      if (!cancelled) setLoading(false);
    });

    const pollInterval = setInterval(() => {
      void loadCachedEmails();
    }, 15000);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void loadCachedEmails();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      cancelled = true;
      clearInterval(pollInterval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadCachedEmails]);

  // Background sync on first mount (after worker discovery) — so newly arrived
  // emails show up without user clicking Refresh
  const initialSyncFired = useRef(false);
  useEffect(() => {
    if (workerUrlsLoading || initialSyncFired.current) return;
    initialSyncFired.current = true;
    syncViaWorker()
      .then(() => new Promise(resolve => setTimeout(resolve, 4000)))
      .then(() => loadCachedEmails())
      .catch(() => {});
  }, [workerUrlsLoading, syncViaWorker, loadCachedEmails]);


  const copyOtp = (otp: string) => {
    navigator.clipboard.writeText(otp);
    setOtpCopied(true);
    setTimeout(() => setOtpCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
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
              <h1 className="font-bold text-sm sm:text-lg tracking-tight leading-tight text-red-600">Netflix Mail</h1>
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
              localStorage.clear(); navigate("/");
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
                      srcDoc={`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:8px;font-family:sans-serif;font-size:14px;color:#334155;overflow-x:hidden;word-break:break-word}img{max-width:100%!important;height:auto!important}table{max-width:100%!important;width:100%!important}td,th{max-width:100%!important;overflow:hidden}a{color:#e11d48}*{box-sizing:border-box}</style></head><body>${selectedEmail.html}</body></html>`}
                      sandbox="allow-same-origin"
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

function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const cached = useMemo(() => readBootstrapCache(), []);
  const [maint, setMaint] = useState<MaintenanceInfo>(
    cached?.maintenance || { enabled: false }
  );
  const [bypass, setBypass] = useState<boolean>(() => {
    try { return sessionStorage.getItem(MAINT_BYPASS_KEY) === "1"; } catch { return false; }
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const bs = await refreshBootstrap();
        if (!cancelled) setMaint(bs.maintenance || { enabled: false });
      } catch {}
    };
    load();
    const interval = setInterval(load, 30000);
    const onChange = () => load();
    window.addEventListener("maintenance:changed", onChange);
    window.addEventListener("focus", onChange);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("maintenance:changed", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, []);

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

  const isAdmin = user?.role === "admin";

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
        onAdminBypass={() => {
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
            </Routes>
          </MaintenanceGate>
        </ErrorBoundary>
      </AuthProvider>
    </Router>
  );
}


const ProtectedRoute = ({ children, role }: { children: React.ReactNode; role: "admin" | "user" }) => {
  const { user, loading } = useAuth();
  useSessionTimeoutGuard(role);
  if (loading) return <div className="min-h-screen bg-slate-950 flex items-center justify-center"><div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" /></div>;
  if (!user) return <Navigate to={role === "admin" ? "/admin" : "/"} />;
  if (role === "admin" && user.role !== "admin") return <Navigate to="/" />;
  // Note: allow admin accounts to freely browse the user viewer too — do not auto-redirect back to admin panel.
  return <><SessionCountdown role={role} />{children}</>;
};
