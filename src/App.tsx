import React, { useState, useEffect, createContext, useContext, useCallback } from "react";
import { Mail, RefreshCw, ShieldCheck, Clock, AlertCircle, Copy, Check, ArrowLeft, Lock, Key, LogOut, Settings, Plus, Users, Trash2, CheckCircle2, X, Eye, EyeOff, KeyRound, Filter, Server, BarChart3, Globe, Edit, Database, Wifi } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Toaster, toast } from "sonner";
import ReCAPTCHA from "react-google-recaptcha";
import { supabase } from "./integrations/supabase/client";
import { QRCodeSVG } from "qrcode.react";

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
    if (stored) return JSON.parse(stored);
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

// --- API Helper (routes ALL calls through Cloudflare Workers) ---

async function apiCall(functionName: string, body: any) {
  let workerUrls = getStoredWorkerUrls();
  
  const token = getSessionToken();

  // Try each worker URL with random load balancing
  if (workerUrls.length > 0) {
    const shuffled = shuffleArray(workerUrls);
    for (const cfUrl of shuffled) {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (token) headers["X-Session-Token"] = token;

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

  // Fallback: call Supabase edge function directly
  console.log(`[apiCall] All workers failed or none configured, falling back to direct Supabase for ${functionName}`);
  const { createClient } = await import("@supabase/supabase-js");
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const headers: Record<string, string> = {};
  if (token) headers["X-Session-Token"] = token;
  
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

// --- Direct Supabase bootstrap (bypasses worker requirement) ---
async function bootstrapFromSupabase(): Promise<{ users: any[]; recaptcha: any; workerUrls: string[] }> {
  const { data, error } = await supabase.functions.invoke("manage-app", {
    body: { action: "bootstrap_public" },
  });
  if (error) throw error;
  if (!data?.success) throw new Error(data?.error || "Bootstrap failed");

  // Store worker URLs immediately so apiCall works for subsequent calls
  if (data.workerUrls && Array.isArray(data.workerUrls) && data.workerUrls.length > 0) {
    storeWorkerUrls(data.workerUrls);
  }

  return { users: data.users || [], recaptcha: data.recaptcha, workerUrls: data.workerUrls || [] };
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

// --- Location ---
const getPreciseLocation = async (retries = 1): Promise<{lat: number, lon: number}> => {
  const fetchLocation = (): Promise<{lat: number, lon: number}> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error("Geolocation not supported")); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  };
  try {
    return await fetchLocation();
  } catch {
    if (retries > 0) return getPreciseLocation(retries - 1);
    throw new Error("Location access is required. Please enable it.");
  }
};

// --- Auth Context ---
const AuthContext = createContext<{ user: any; loading: boolean; checkAuth: () => void } | null>(null);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = () => {
    try {
      const stored = localStorage.getItem("user");
      setUser(stored ? JSON.parse(stored) : null);
    } catch { setUser(null); }
    setLoading(false);
  };

  useEffect(() => { checkAuth(); }, []);

  return <AuthContext.Provider value={{ user, loading, checkAuth }}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext)!;

// --- Types ---
interface Email {
  id: string; subject: string; from: string; to?: string; date: string; otp: string | null; preview: string; html: string;
}
interface UserData {
  id: string; username: string; name: string; role: "admin" | "user"; totpSecret?: string; mustChangePassword?: boolean; assignedAccounts?: string[] | null;
}

// --- Password Toggle Helper ---
function PasswordInput({ value, onChange, placeholder, className, autoFocus, required }: {
  value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string; className?: string; autoFocus?: boolean; required?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? "text" : "password"} value={value} onChange={onChange}
        placeholder={placeholder} className={className} autoFocus={autoFocus} required={required} />
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
        <div className="flex justify-center px-6 pb-4">
          <ReCAPTCHA sitekey={siteKey} onChange={(token) => { if (token) onVerify(token); }} />
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
  const [profiles, setProfiles] = useState<UserData[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<UserData | null>(null);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [error, setError] = useState("");
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const navigate = useNavigate();
  const { checkAuth } = useAuth();

  const loadProfiles = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      // Use direct Supabase bootstrap — no worker URL needed
      const bootstrap = await bootstrapFromSupabase();
      setProfiles((bootstrap.users || []).filter((u: UserData) => u.role === "user"));
      if (bootstrap.recaptcha?.enabled === true && bootstrap.recaptcha?.siteKey) {
        setSiteKey(bootstrap.recaptcha.siteKey);
      }
    } catch (err: any) {
      console.error("Failed to load profiles:", err);
      setError("Failed to load profiles. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  const initiateLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (siteKey) { setShowCaptcha(true); } else { executeLogin(); }
  };

  const executeLogin = async () => {
    if (!selectedProfile) return;
    setLoginLoading(true);
    setError("");

    try {
      if (!checkRateLimit(`user_${selectedProfile.username}`)) {
        throw new Error("Too many attempts. Wait 1 minute.");
      }

      // Do not block login on geolocation permission/network delay
      const locationPromise = getPreciseLocation().catch(() => null);

      // Login via worker if available, otherwise direct Supabase
      let data: any;
      const workerUrls = getStoredWorkerUrls();
      if (workerUrls.length > 0) {
        data = await apiCall("manage-app", {
          action: "login",
          username: selectedProfile.username,
          password,
        });
      } else {
        const result = await supabase.functions.invoke("manage-app", {
          body: { action: "login", username: selectedProfile.username, password },
        });
        if (result.error) throw result.error;
        data = result.data;
        if (!data?.success) throw new Error(data?.error || "Login failed");
        if (data.sessionToken) localStorage.setItem("session_token", data.sessionToken);
      }

      // Store worker URLs returned from login response
      if (data.workerUrls && Array.isArray(data.workerUrls) && data.workerUrls.length > 0) {
        storeWorkerUrls(data.workerUrls);
      }

      localStorage.setItem("user", JSON.stringify(data.user));
      checkAuth();

      void (async () => {
        try {
          const loc = await locationPromise;
          await apiCall("send-login-notification", {
            username: data.user.username,
            name: data.user.name,
            status: "success",
            ...(loc ? { lat: loc.lat, lon: loc.lon } : {}),
          });
          console.log("[notification] Login notification sent successfully");
        } catch (notifErr) {
          console.error("[notification] Failed to send login notification:", notifErr);
        }
      })();

      navigate("/viewer");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoginLoading(false);
    }
  };


  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:14px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-red-600/20 blur-[120px] rounded-full pointer-events-none" />

      <AnimatePresence mode="wait">
        {!selectedProfile ? (
          <motion.div key="profiles" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
            className="relative z-10 w-full max-w-lg">
            <div className="flex justify-center mb-6">
              <div className="bg-red-600 p-3 rounded-2xl shadow-lg shadow-red-900/30">
                <Mail className="text-white w-7 h-7" />
              </div>
            </div>
            <h1 className="text-2xl sm:text-3xl font-black text-white text-center mb-2">Who's viewing?</h1>
            <p className="text-slate-400 text-center text-sm mb-8">Select your profile to continue</p>

            {profiles.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-slate-500 text-sm">No profiles yet. Ask admin to create users.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 justify-items-center">
                {profiles.map((profile, i) => (
                  <motion.button key={profile.id} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                    onClick={() => setSelectedProfile(profile)} className="flex flex-col items-center gap-3 group">
                    <div className={`w-20 h-20 sm:w-24 sm:h-24 rounded-2xl ${PROFILE_COLORS[i % PROFILE_COLORS.length]} flex items-center justify-center shadow-lg group-hover:ring-2 group-hover:ring-white/50 transition-all`}>
                      <span className="text-white text-2xl sm:text-3xl font-black">{profile.name.charAt(0).toUpperCase()}</span>
                    </div>
                    <span className="text-slate-300 font-bold text-sm group-hover:text-white transition-colors">{profile.name}</span>
                  </motion.button>
                ))}
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div key="password" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
            className="relative z-10 w-full max-w-sm">
            <button onClick={() => { setSelectedProfile(null); setPassword(""); setError(""); }}
              className="text-slate-400 hover:text-white text-sm font-bold mb-6 flex items-center gap-1 transition-colors">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>

            <div className="flex flex-col items-center mb-6">
              <div className={`w-20 h-20 rounded-2xl ${PROFILE_COLORS[profiles.indexOf(selectedProfile) % PROFILE_COLORS.length]} flex items-center justify-center shadow-lg mb-3`}>
                <span className="text-white text-2xl font-black">{selectedProfile.name.charAt(0).toUpperCase()}</span>
              </div>
              <h2 className="text-xl font-black text-white">{selectedProfile.name}</h2>
              <p className="text-slate-400 text-sm">@{selectedProfile.username}</p>
            </div>

            <form onSubmit={initiateLogin} className="space-y-4">
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 w-5 h-5 z-10" />
                <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 text-white rounded-2xl py-4 pl-12 pr-12 focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all outline-none placeholder:text-slate-600"
                  placeholder="Enter password" autoFocus required />
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-3 rounded-xl flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
                </div>
              )}

              <button type="submit" disabled={loginLoading}
                className="w-full bg-red-600 text-white font-bold py-4 rounded-2xl hover:bg-red-700 transition-all active:scale-95 disabled:opacity-50">
                {loginLoading ? "Verifying..." : "Sign In"}
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
        // Use bootstrap to get recaptcha config without needing worker URLs
        const bootstrap = await bootstrapFromSupabase();
        if (bootstrap.recaptcha?.enabled === true && bootstrap.recaptcha?.siteKey) {
          setSiteKey(bootstrap.recaptcha.siteKey);
        }
      } catch {}
    })();
  }, []);

  const initiateLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (siteKey) { setShowCaptcha(true); } else { executeLogin(); }
  };

  const executeLogin = async () => {
    setLoading(true);
    setError("");
    try {
      if (!checkRateLimit(`admin_${username}`)) throw new Error("Too many attempts. Wait 1 minute.");

      // Do not block admin login on geolocation permission/network delay
      const locationPromise = getPreciseLocation().catch(() => null);

      // Login via Supabase directly if no worker URLs available, otherwise via worker
      let data: any;
      const workerUrls = getStoredWorkerUrls();
      if (workerUrls.length > 0) {
        data = await apiCall("manage-app", { action: "login", username, password });
      } else {
        const result = await supabase.functions.invoke("manage-app", {
          body: { action: "login", username, password },
        });
        if (result.error) throw result.error;
        data = result.data;
        if (!data?.success) throw new Error(data?.error || "Login failed");
        if (data.sessionToken) localStorage.setItem("session_token", data.sessionToken);
      }

      if (data.user.role !== "admin") throw new Error("Access denied");

      // Store worker URLs returned from login response
      if (data.workerUrls && Array.isArray(data.workerUrls) && data.workerUrls.length > 0) {
        storeWorkerUrls(data.workerUrls);
      }

      localStorage.setItem("user", JSON.stringify(data.user));
      checkAuth();

      void (async () => {
        try {
          const loc = await locationPromise;
          await apiCall("send-login-notification", {
            username: data.user.username,
            name: data.user.name,
            status: "success",
            ...(loc ? { lat: loc.lat, lon: loc.lon } : {}),
          });
          console.log("[notification] Admin login notification sent successfully");
        } catch (notifErr) {
          console.error("[notification] Failed to send admin login notification:", notifErr);
        }
      })();

      toast.success("Login successful. Proceeding to 2FA.");
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
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
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
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-red-500 transition-all outline-none"
                placeholder="admin" required />
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Admin Password</label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5 z-10" />
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-12 focus:ring-2 focus:ring-red-500 transition-all outline-none"
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
    if (!user || user.role !== "admin") { navigate("/admin"); return; }

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
          const { generateSecret, generateURI } = await import("otplib");
          const secret = generateSecret();
          setSecretKey(secret);
          const uri = generateURI({ issuer: "AdminPanel", label: user.username, secret });
          setQrCode(uri);
          await apiCall("manage-app", { action: "update_totp", id: user.id, totp_secret: secret });
        } catch (err) {
          console.error("TOTP setup error:", err);
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
      const { verify } = await import("otplib");
      const secret = user.totpSecret || secretKey;
      const result = await verify({ secret, token: totp });
      if (result && (result as any).delta !== undefined) {
        localStorage.setItem("admin_auth", "true");
        navigate("/admin/dashboard");
      } else {
        throw new Error("Invalid Google Auth Code");
      }
    } catch {
      setError("Invalid Google Auth Code");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 relative overflow-hidden">
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
                  <QRCodeSVG value={qrCode} size={160} />
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
function AdminPanel() {
  const [activeTab, setActiveTab] = useState<"users" | "security" | "emails" | "settings">("users");
  const [users, setUsers] = useState<UserData[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [newUserAccounts, setNewUserAccounts] = useState<string[]>([]);
  const [siteKey, setSiteKey] = useState("");
  const [secretKeyVal, setSecretKeyVal] = useState("");
  const [captchaEnabled, setCaptchaEnabled] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newAdminPassword, setNewAdminPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [changingUserPass, setChangingUserPass] = useState<string | null>(null);
  const [userNewPass, setUserNewPass] = useState("");
  const [showSignInCodes, setShowSignInCodes] = useState(true);
  const [showPasswordResets, setShowPasswordResets] = useState(false);
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

      // Stats are now derived from worker-fetched emails, no direct Supabase REST call
    })();
  }, []);

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

  const toggleSignInCodeFilter = async () => {
    const newVal = !showSignInCodes;
    setShowSignInCodes(newVal);
    try {
      await apiCall("manage-app", { action: "set_settings", key: "email_filters", value: { showSignInCodes: newVal, showPasswordResets } });
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
      await apiCall("manage-app", { action: "set_settings", key: "email_filters", value: { showSignInCodes, showPasswordResets: newVal } });
      toast.success(newVal ? "Password reset emails will be shown" : "Password reset emails will be hidden");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save filter setting");
      setShowPasswordResets(!newVal);
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
    { id: "security" as const, label: "Security", icon: ShieldCheck },
    { id: "emails" as const, label: "Email Accounts", icon: Mail },
    { id: "settings" as const, label: "Settings", icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
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
              <div className="space-y-3">
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
                  <div key={u.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:border-slate-200 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-xl ${u.role === "admin" ? "bg-red-500" : "bg-blue-500"} flex items-center justify-center`}>
                          <span className="text-white font-black text-sm">{u.name.charAt(0).toUpperCase()}</span>
                        </div>
                        <div>
                          <p className="font-bold text-slate-900">{u.name}</p>
                          <p className="text-xs text-slate-500">@{u.username} • <span className={u.role === "admin" ? "text-red-600 font-bold" : "text-blue-600"}>{u.role}</span></p>
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
                        <div className="flex items-center gap-1">
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
                      <div className="mt-3 flex gap-2">
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

                {/* Cloudflare Setup Guide */}
                <details className="mt-4 bg-blue-50 border border-blue-200 rounded-xl p-4">
                  <summary className="text-xs font-bold text-blue-700 cursor-pointer select-none flex items-center gap-2">
                    <Info className="w-3.5 h-3.5" />
                    📘 How to set up a Cloudflare Worker (Step-by-Step)
                  </summary>
                  <div className="mt-3 space-y-3 text-[11px] text-blue-900 leading-relaxed">
                    <div>
                      <p className="font-bold text-blue-800">Step 1: Create Cloudflare Account</p>
                      <p>Go to <span className="font-mono bg-blue-100 px-1 rounded">dash.cloudflare.com</span> and sign up for free.</p>
                    </div>
                    <div>
                      <p className="font-bold text-blue-800">Step 2: Install Wrangler CLI</p>
                      <p className="font-mono bg-blue-100 p-1.5 rounded mt-1">npm install -g wrangler</p>
                      <p className="mt-1">Then login:</p>
                      <p className="font-mono bg-blue-100 p-1.5 rounded mt-1">npx wrangler login</p>
                    </div>
                    <div>
                      <p className="font-bold text-blue-800">Step 3: Create KV Namespace</p>
                      <p className="font-mono bg-blue-100 p-1.5 rounded mt-1">cd cloudflare-worker<br/>npx wrangler kv namespace create EMAIL_CACHE</p>
                      <p className="mt-1">Copy the namespace ID and paste it in <span className="font-mono">wrangler.toml</span> → <span className="font-mono">id</span> field.</p>
                    </div>
                    <div>
                      <p className="font-bold text-blue-800">Step 4: Set Secrets (Required!)</p>
                      <p className="font-mono bg-blue-100 p-1.5 rounded mt-1">npx wrangler secret put SUPABASE_URL<br/>npx wrangler secret put SUPABASE_KEY<br/>npx wrangler secret put SESSION_SECRET</p>
                      <ul className="mt-1 space-y-0.5 ml-3 list-disc">
                        <li><b>SUPABASE_URL</b> — Your Supabase project URL</li>
                        <li><b>SUPABASE_KEY</b> — Supabase anon/publishable key</li>
                        <li><b>SESSION_SECRET</b> — Supabase <b>Service Role Key</b> (for token verification)</li>
                      </ul>
                      <p className="mt-1 text-red-600 font-bold">⚠️ Without SESSION_SECRET, the worker will reject all authenticated requests!</p>
                    </div>
                    <div>
                      <p className="font-bold text-blue-800">Step 5: Deploy</p>
                      <p className="font-mono bg-blue-100 p-1.5 rounded mt-1">npx wrangler deploy</p>
                      <p className="mt-1">After deployment, copy the URL (e.g. <span className="font-mono">https://email-cache-proxy.your-account.workers.dev</span>) and paste it above.</p>
                    </div>
                    <div>
                      <p className="font-bold text-blue-800">Step 6: Verify</p>
                      <p>Visit <span className="font-mono bg-blue-100 px-1 rounded">https://your-worker.workers.dev/api/debug</span> in browser. You should see:</p>
                      <p className="font-mono bg-blue-100 p-1.5 rounded mt-1">has_supabase_url: true<br/>has_supabase_key: true<br/>has_session_secret: true ← Must be true!</p>
                    </div>
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-2">
                      <p className="font-bold text-yellow-800">🔄 Adding a NEW email account with its own worker:</p>
                      <ol className="mt-1 space-y-0.5 ml-3 list-decimal">
                        <li>Create a new Cloudflare Worker (repeat Steps 2-5 with a different name in <span className="font-mono">wrangler.toml</span>)</li>
                        <li>Set the same 3 secrets on the new worker</li>
                        <li>Go to "Email Accounts" tab → Add the account with IMAP details</li>
                        <li>Add the new worker URL in that account's "Cloudflare Worker URLs" field</li>
                        <li>Emails for that account will be fetched through its dedicated worker</li>
                      </ol>
                    </div>
                    <div className="bg-green-50 border border-green-200 rounded-lg p-2">
                      <p className="font-bold text-green-800">💡 Tips:</p>
                      <ul className="mt-1 space-y-0.5 ml-3 list-disc">
                        <li>Multiple primary worker URLs = random load balancing</li>
                        <li>Per-account worker URLs = dedicated routing for that email account</li>
                        <li>If all workers fail, app automatically falls back to direct Supabase</li>
                        <li>If KV storage fills up, create a new KV namespace and add it as <span className="font-mono">EMAIL_CACHE_V2</span></li>
                      </ul>
                    </div>
                  </div>
                </details>
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

// ==================== EMAIL VIEWER ====================
function EmailViewer() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [otpCopied, setOtpCopied] = useState(false);
  const navigate = useNavigate();
  const user = JSON.parse(localStorage.getItem("user") || "{}");
  const [showChangePassword, setShowChangePassword] = useState(!!user.mustChangePassword);
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
      const primaryUrls: string[] = [...getStoredWorkerUrls()];
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

      // Build flat list for general use (primary + all account URLs deduplicated)
      const allUrls = [...primaryUrls];
      for (const urls of Object.values(accountUrls)) {
        for (const u of urls) {
          if (!allUrls.includes(u)) allUrls.push(u);
        }
      }
      const normalizedUrls = allUrls
        .map((u) => u.trim().replace(/\/+$/, ""))
        .filter(Boolean)
        .filter((u, i, arr) => arr.indexOf(u) === i);

      const normalizedPrimary = primaryUrls
        .map((u) => u.trim().replace(/\/+$/, ""))
        .filter(Boolean)
        .filter((u, i, arr) => arr.indexOf(u) === i);

      setResolvedWorkerUrls(normalizedUrls);
      setWorkerUrlMap({ primary: normalizedPrimary, byAccount: accountUrls });
      if (normalizedUrls.length > 0) storeWorkerUrls(normalizedUrls);
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

        const user = JSON.parse(localStorage.getItem("user") || "{}");
        const bodyPayload: any = { mode: "cache" };
        if (user.assignedAccounts) bodyPayload.accountLabels = user.assignedAccounts;

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
      return emailList.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load emails";
      setError(msg);
      return 0;
    }
  }, [fetchFromWorkers, resolvedWorkerUrls.length, workerUrlsLoading, workerUrlMap.primary]);

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
      const body: any = { mode: "sync" };
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
        const res = await fetchFromWorkers("/api/emails/sync", "POST", { mode: "sync", accountLabels: [label] }, urlsToTry);
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
        const res = await fetchFromWorkers("/api/emails/sync", "POST", { mode: "sync" }, primary);
        if (!res || !res.ok) {
          console.warn("[sync] Primary workers failed, falling back to Supabase");
          await syncDirectSupabase();
        }
      })());
    } else if (accountLabelsWithWorkers.length === 0) {
      const res = await fetchFromWorkers("/api/emails/sync", "POST", { mode: "sync" });
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
    const toastId = toast.loading("Syncing new emails...");
    try {
      // 1. Sync IMAP immediately and wait for it
      await syncViaWorker();
      // 2. Reload cached emails after sync completes
      await loadCachedEmails();
      toast.success("Emails synced!", { id: toastId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sync failed";
      toast.error(msg, { id: toastId });
      // Still try to show cached emails even if sync failed
      await loadCachedEmails().catch(() => {});
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (workerUrlsLoading) return;

    if (resolvedWorkerUrls.length === 0) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    loadCachedEmails().then(() => {
      if (!cancelled) setLoading(false);
    });

    const pollInterval = setInterval(() => {
      void loadCachedEmails();
    }, 30000);

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
  }, [workerUrlsLoading, resolvedWorkerUrls.length, loadCachedEmails]);

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
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-6xl mx-auto px-3 sm:px-4 h-14 sm:h-16 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="flex-shrink-0">
              <svg viewBox="0 0 24 24" className="w-8 h-8 sm:w-10 sm:h-10" fill="none">
                <rect width="24" height="24" rx="6" fill="#E50914"/>
                <path d="M7 5h2.5l3.5 8V5H15.5v14H13L9.5 11v8H7V5z" fill="white"/>
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="font-bold text-base sm:text-xl tracking-tight leading-tight text-red-600">Netflix Mail</h1>
              <span className="text-[10px] sm:text-xs text-slate-500 truncate block max-w-[80px] sm:max-w-[150px]">{user.name}</span>
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
            <button onClick={() => fetchEmails()}
              disabled={refreshing}
              className="flex items-center p-2.5 sm:px-4 sm:py-2 bg-slate-900 text-white rounded-full text-sm font-bold hover:bg-slate-800 transition-all active:scale-95 disabled:opacity-60">
              <RefreshCw className={`w-4 h-4 sm:w-5 sm:h-5 ${refreshing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline ml-1.5">Refresh</span>
            </button>
            {!isImpersonating && (
              <button onClick={() => setShowChangePassword(true)}
                className="flex items-center p-2.5 sm:px-3 sm:py-2 bg-gradient-to-r from-violet-500 to-purple-600 text-white rounded-full text-sm font-bold hover:from-violet-600 hover:to-purple-700 transition-all active:scale-95 shadow-md shadow-purple-200"
                title="Change Password">
                <Key className="w-4 h-4 sm:w-5 sm:h-5" />
                <span className="hidden sm:inline ml-1.5">Password</span>
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
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-8 h-full py-4 sm:py-8">
          <div className={`${selectedEmail ? "hidden lg:block" : "block"} lg:col-span-5 xl:col-span-4 flex flex-col overflow-hidden h-full`}>
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

          <div className={`${selectedEmail ? "block" : "hidden lg:flex"} lg:col-span-7 xl:col-span-8 flex flex-col overflow-hidden h-full`}>
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
                      <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600 font-bold text-sm sm:text-lg flex-shrink-0">
                        {(selectedEmail.from?.charAt(0) || "?").toUpperCase()}
                      </div>
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

// ==================== MAIN APP ====================
export default function App() {
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", handleContextMenu);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F12" || (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "J" || e.key === "C")) || (e.ctrlKey && e.key === "U")) {
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    document.body.style.userSelect = "none";
    (document.body.style as any).webkitUserSelect = "none";
    const preventSelect = (e: Event) => e.preventDefault();
    const preventDrag = (e: Event) => e.preventDefault();
    document.addEventListener("selectstart", preventSelect);
    document.addEventListener("dragstart", preventDrag);

    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("selectstart", preventSelect);
      document.removeEventListener("dragstart", preventDrag);
    };
  }, []);

  return (
    <Router>
      <AuthProvider>
        <Toaster position="top-center" richColors />
        <Routes>
          <Route path="/" element={<ProfileSelectPage />} />
          <Route path="/admin" element={<AdminLoginPage />} />
          <Route path="/admin-auth" element={<AdminAuthPage />} />
          <Route path="/admin/dashboard" element={<ProtectedRoute role="admin"><AdminPanel /></ProtectedRoute>} />
          <Route path="/viewer" element={<ProtectedRoute role="user"><EmailViewer /></ProtectedRoute>} />
        </Routes>
      </AuthProvider>
    </Router>
  );
}

const ProtectedRoute = ({ children, role }: { children: React.ReactNode; role: "admin" | "user" }) => {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen bg-slate-950 flex items-center justify-center"><div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" /></div>;
  if (!user) return <Navigate to={role === "admin" ? "/admin" : "/"} />;
  if (role === "admin" && user.role !== "admin") return <Navigate to="/" />;
  if (role === "user" && user.role === "admin" && !localStorage.getItem("admin_backup")) return <Navigate to="/admin/dashboard" />;
  return <>{children}</>;
};
