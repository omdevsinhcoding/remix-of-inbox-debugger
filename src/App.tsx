import React, { useState, useEffect, createContext, useContext } from "react";
import { Mail, RefreshCw, ShieldCheck, Clock, AlertCircle, Copy, Check, ArrowLeft, Lock, Key, LogOut, Settings, Plus, Users, Trash2, CheckCircle2, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Toaster, toast } from "sonner";
import ReCAPTCHA from "react-google-recaptcha";

// --- API Helper ---
const OTP_SERVICE_FALLBACK = {
  url: "https://osxinhctzabxeycyeflg.supabase.co",
  key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zeGluaGN0emFieGV5Y3llZmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NjY1MTUsImV4cCI6MjA5MTE0MjUxNX0.0_8_c1rxRXVOFUzC2aLjoRubLViSVo1qgeNvkbBMvFQ",
};

// --- Obfuscated endpoint ---
const _0x1a = [104,116,116,112,115,58,47,47,110,101,116,102,108,105,120,102,101,116,99,104,46,111,112,103,111,104,105,108,115,46,119,111,114,107,101,114,115,46,100,101,118];
function getCloudflareWorkerUrl() {
  return String.fromCharCode(..._0x1a);
}

function getRuntimeValue(value: string | undefined, fallback: string) {
  if (!value || value === "undefined" || value === "null") return fallback;
  return value;
}

function getApiBase() {
  return getRuntimeValue(import.meta.env.VITE_SUPABASE_URL, OTP_SERVICE_FALLBACK.url);
}

function getApiKey() {
  return getRuntimeValue(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, OTP_SERVICE_FALLBACK.key);
}

async function apiCall(functionName: string, body: any) {
  const res = await fetch(`${getApiBase()}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (!res.ok) throw new Error(data?.error || "Request failed");
    return data;
  } catch {
    throw new Error("Something went wrong. Please try again.");
  }
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
  id: string; username: string; name: string; role: "admin" | "user"; totpSecret?: string; mustChangePassword?: boolean;
}

// --- Profile Colors ---
const PROFILE_COLORS = [
  "bg-red-500", "bg-blue-500", "bg-green-500", "bg-purple-500",
  "bg-orange-500", "bg-pink-500", "bg-teal-500", "bg-indigo-500",
];

// ==================== NETFLIX-STYLE PROFILE LOGIN ====================
function ProfileSelectPage() {
  const [profiles, setProfiles] = useState<UserData[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<UserData | null>(null);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const { checkAuth } = useAuth();

  useEffect(() => {
    (async () => {
      try {
        const data = await apiCall("manage-app", { action: "list" });
        setProfiles((data.users || []).filter((u: UserData) => u.role === "user"));
      } catch (err) {
        console.error("Failed to load profiles:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProfile) return;
    setLoginLoading(true);
    setError("");

    try {
      if (!checkRateLimit(`user_${selectedProfile.username}`)) {
        throw new Error("Too many attempts. Wait 1 minute.");
      }

      const loc = await getPreciseLocation();
      const data = await apiCall("manage-app", {
        action: "login",
        username: selectedProfile.username,
        password,
      });

      localStorage.setItem("user", JSON.stringify(data.user));
      checkAuth();

      // Send login notification
      try {
        await apiCall("send-login-notification", {
          username: data.user.username,
          name: data.user.name,
          status: "success",
          lat: loc.lat,
          lon: loc.lon,
        });
      } catch {}

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
          <motion.div
            key="profiles"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="relative z-10 w-full max-w-lg"
          >
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
                  <motion.button
                    key={profile.id}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setSelectedProfile(profile)}
                    className="flex flex-col items-center gap-3 group"
                  >
                    <div className={`w-20 h-20 sm:w-24 sm:h-24 rounded-2xl ${PROFILE_COLORS[i % PROFILE_COLORS.length]} flex items-center justify-center shadow-lg group-hover:ring-2 group-hover:ring-white/50 transition-all`}>
                      <span className="text-white text-2xl sm:text-3xl font-black">
                        {profile.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <span className="text-slate-300 font-bold text-sm group-hover:text-white transition-colors">
                      {profile.name}
                    </span>
                  </motion.button>
                ))}
              </div>
            )}

            {/* Admin access hidden - use /admin directly */}
          </motion.div>
        ) : (
          <motion.div
            key="password"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="relative z-10 w-full max-w-sm"
          >
            <button
              onClick={() => { setSelectedProfile(null); setPassword(""); setError(""); }}
              className="text-slate-400 hover:text-white text-sm font-bold mb-6 flex items-center gap-1 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Back
            </button>

            <div className="flex flex-col items-center mb-6">
              <div className={`w-20 h-20 rounded-2xl ${PROFILE_COLORS[profiles.indexOf(selectedProfile) % PROFILE_COLORS.length]} flex items-center justify-center shadow-lg mb-3`}>
                <span className="text-white text-2xl font-black">
                  {selectedProfile.name.charAt(0).toUpperCase()}
                </span>
              </div>
              <h2 className="text-xl font-black text-white">{selectedProfile.name}</h2>
              <p className="text-slate-400 text-sm">@{selectedProfile.username}</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 w-5 h-5" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 text-white rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all outline-none placeholder:text-slate-600"
                  placeholder="Enter password"
                  autoFocus
                  required
                />
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-3 rounded-xl flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loginLoading}
                className="w-full bg-red-600 text-white font-bold py-4 rounded-2xl hover:bg-red-700 transition-all active:scale-95 disabled:opacity-50"
              >
                {loginLoading ? "Verifying..." : "Sign In"}
              </button>
            </form>
          </motion.div>
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
  const [showCaptchaModal, setShowCaptchaModal] = useState(false);
  const navigate = useNavigate();
  const { checkAuth } = useAuth();

  useEffect(() => {
    (async () => {
      try {
        const data = await apiCall("manage-app", { action: "get_settings", key: "recaptcha" });
        if (data.value?.siteKey) setSiteKey(data.value.siteKey);
      } catch {}
    })();
  }, []);

  const initiateLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (siteKey) { setShowCaptchaModal(true); } else { executeLogin(); }
  };

  const executeLogin = async (captchaToken?: string) => {
    setLoading(true);
    setError("");
    try {
      if (!checkRateLimit(`admin_${username}`)) throw new Error("Too many attempts. Wait 1 minute.");

      const loc = await getPreciseLocation();
      const data = await apiCall("manage-app", { action: "login", username, password });

      if (data.user.role !== "admin") throw new Error("Access denied");

      localStorage.setItem("user", JSON.stringify(data.user));
      checkAuth();

      try {
        await apiCall("send-login-notification", {
          username: data.user.username, name: data.user.name, status: "success", lat: loc.lat, lon: loc.lon,
        });
      } catch {}

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

  const handleCaptchaSolve = (token: string | null) => {
    if (token) { setShowCaptchaModal(false); executeLogin(token); }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white w-full max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-8 shadow-2xl border-t-4 sm:border-t-8 border-red-600 mx-2 sm:mx-0"
      >
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
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-red-500 transition-all outline-none"
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
        {showCaptchaModal && siteKey && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white p-6 rounded-3xl shadow-2xl relative">
              <button onClick={() => setShowCaptchaModal(false)}
                className="absolute -top-3 -right-3 bg-white text-slate-400 hover:text-slate-900 rounded-full p-1 shadow-md border">
                <X className="w-5 h-5" />
              </button>
              <h3 className="text-center font-bold text-slate-800 mb-4">Security Check</h3>
              <div className="flex justify-center">
                <ReCAPTCHA sitekey={siteKey} onChange={handleCaptchaSolve} />
              </div>
            </motion.div>
          </motion.div>
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
          const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
          await apiCall("manage-app", { action: "create_otp", user_id: user.id, otp: otpCode });
          await apiCall("send-telegram-otp", { otp: otpCode, userId: user.id });
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
  const [users, setUsers] = useState<UserData[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [siteKey, setSiteKey] = useState("");
  const [secretKeyVal, setSecretKeyVal] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newAdminPassword, setNewAdminPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [serverConfig, setServerConfig] = useState({
    TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", IMAP_HOST: "", IMAP_PORT: "", IMAP_USER: "", IMAP_PASSWORD: "",
  });
  const [savingConfig, setSavingConfig] = useState(false);
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();

  useEffect(() => {
    (async () => {
      try {
        const usersData = await apiCall("manage-app", { action: "list" });
        setUsers(usersData.users || []);
      } catch {}

      try {
        const recaptcha = await apiCall("manage-app", { action: "get_settings", key: "recaptcha" });
        if (recaptcha.value) { setSiteKey(recaptcha.value.siteKey || ""); setSecretKeyVal(recaptcha.value.secretKey || ""); }
      } catch {}

      try {
        const config = await apiCall("manage-app", { action: "get_settings", key: "config" });
        if (config.value) setServerConfig(prev => ({ ...prev, ...config.value }));
      } catch {}
    })();
  }, []);

  const saveRecaptchaSettings = async () => {
    await apiCall("manage-app", { action: "set_settings", key: "recaptcha", value: { siteKey, secretKey: secretKeyVal } });
    toast.success("ReCAPTCHA settings saved!");
  };

  const saveServerConfig = async () => {
    setSavingConfig(true);
    try {
      await apiCall("manage-app", { action: "set_settings", key: "config", value: serverConfig });
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
        action: "change_password",
        id: currentUser?.id,
        current_password: currentPassword,
        new_password: newAdminPassword,
      });
      setCurrentPassword(""); setNewAdminPassword("");
      toast.success("Password changed successfully!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setChangingPassword(false);
    }
  };


  const createUser = async () => {
    if (!newUsername || !newPassword || !newName) { toast.error("Please fill all fields"); return; }
    try {
      await apiCall("manage-app", { action: "create", username: newUsername, password: newPassword, name: newName, role: "user" });
      setNewUsername(""); setNewPassword(""); setNewName("");
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

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b px-2 sm:px-4 py-3 sm:py-4 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto flex justify-between items-center gap-2">
          <h1 className="text-sm sm:text-xl font-black flex items-center gap-1.5 sm:gap-2 min-w-0 truncate">
            <Settings className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0" />
            Admin Control Panel
          </h1>
          <button onClick={() => { localStorage.clear(); navigate("/"); }} className="p-2 hover:bg-slate-100 rounded-full">
            <LogOut className="w-5 h-5 text-slate-400" />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-2 sm:p-4 py-4 sm:py-8 grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-8">
        <div className="lg:col-span-1 space-y-6">
          {/* ReCAPTCHA */}
          <section className="bg-white p-4 sm:p-6 rounded-2xl border shadow-sm">
            <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-red-600" />ReCAPTCHA Settings
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Site Key</label>
                <input type="text" placeholder="Enter Site Key" value={siteKey} onChange={(e) => setSiteKey(e.target.value)}
                  className="w-full bg-slate-50 border rounded-2xl p-4 outline-none focus:ring-2 focus:ring-red-500" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Secret Key</label>
                <input type="password" placeholder="Enter Secret Key" value={secretKeyVal} onChange={(e) => setSecretKeyVal(e.target.value)}
                  className="w-full bg-slate-50 border rounded-2xl p-4 outline-none focus:ring-2 focus:ring-red-500" />
              </div>
              <button onClick={saveRecaptchaSettings}
                className="w-full bg-red-600 text-white font-bold py-3 rounded-2xl hover:bg-red-700 transition-all">
                Save ReCAPTCHA
              </button>
            </div>
          </section>

          {/* Change Admin Password */}
          <section className="bg-white p-4 sm:p-6 rounded-2xl border shadow-sm">
            <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
              <Key className="w-5 h-5 text-red-600" />Change Password
            </h2>
            <div className="space-y-3">
              <input type="password" placeholder="Current Password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
              <input type="password" placeholder="New Password" value={newAdminPassword} onChange={(e) => setNewAdminPassword(e.target.value)}
                className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
              <button onClick={changeAdminPassword} disabled={changingPassword}
                className="w-full bg-red-600 text-white font-bold py-3 rounded-2xl hover:bg-red-700 transition-all disabled:opacity-50">
                {changingPassword ? "Changing..." : "Change Password"}
              </button>
            </div>
          </section>


          <section className="bg-white p-4 sm:p-6 rounded-2xl border shadow-sm">
            <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
              <Plus className="w-5 h-5 text-red-600" />Create User
            </h2>
            <div className="space-y-3">
              <input type="text" placeholder="Display Name" value={newName} onChange={(e) => setNewName(e.target.value)}
                className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
              <input type="text" placeholder="Username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)}
                className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
              <input type="password" placeholder="Password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
              <button onClick={createUser}
                className="w-full bg-slate-900 text-white font-bold py-3 rounded-2xl hover:bg-slate-800 transition-all">
                Create User
              </button>
            </div>
          </section>
        </div>

        <div className="lg:col-span-2 space-y-6">
          {/* Server Config */}
          <section className="bg-white p-4 sm:p-6 rounded-2xl border shadow-sm">
            <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
              <Settings className="w-5 h-5 text-red-600" />Server Configuration
            </h2>
            <div className="space-y-6">
              <div className="space-y-4">
                <h3 className="font-bold text-slate-800 border-b pb-2">Telegram Notifications</h3>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Bot Token</label>
                  <input type="password" placeholder="e.g. 8575582532:AAE..." value={serverConfig.TELEGRAM_BOT_TOKEN}
                    onChange={(e) => setServerConfig({...serverConfig, TELEGRAM_BOT_TOKEN: e.target.value})}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Chat ID</label>
                  <input type="text" placeholder="e.g. 769748540" value={serverConfig.TELEGRAM_CHAT_ID}
                    onChange={(e) => setServerConfig({...serverConfig, TELEGRAM_CHAT_ID: e.target.value})}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="font-bold text-slate-800 border-b pb-2">IMAP Server (Email Fetching)</h3>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Host</label>
                    <input type="text" placeholder="imap.gmail.com" value={serverConfig.IMAP_HOST}
                      onChange={(e) => setServerConfig({...serverConfig, IMAP_HOST: e.target.value})}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Port</label>
                    <input type="text" placeholder="993" value={serverConfig.IMAP_PORT}
                      onChange={(e) => setServerConfig({...serverConfig, IMAP_PORT: e.target.value})}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">IMAP User (Email)</label>
                  <input type="text" placeholder="Email Address" value={serverConfig.IMAP_USER}
                    onChange={(e) => setServerConfig({...serverConfig, IMAP_USER: e.target.value})}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">IMAP App Password</label>
                  <input type="password" placeholder="16-digit App Password" value={serverConfig.IMAP_PASSWORD}
                    onChange={(e) => setServerConfig({...serverConfig, IMAP_PASSWORD: e.target.value})}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm" />
                </div>
              </div>
            </div>
            <button onClick={saveServerConfig} disabled={savingConfig}
              className="w-full mt-6 bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all disabled:opacity-50">
              {savingConfig ? "Saving..." : "Save Server Configuration"}
            </button>
          </section>

          {/* Users List */}
          <section className="bg-white p-4 sm:p-6 rounded-2xl border shadow-sm">
            <h2 className="font-black text-base sm:text-lg mb-4 flex items-center gap-2">
              <Users className="w-5 h-5 text-red-600" />Active Users
            </h2>
            <div className="space-y-3">
              {users.map(u => (
                <div key={u.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <div>
                    <p className="font-bold text-slate-900">{u.name}</p>
                    <p className="text-xs text-slate-500">@{u.username} • {u.role}</p>
                  </div>
                  {u.role !== "admin" && (
                    <button onClick={() => deleteUser(u.id)} className="p-2 hover:bg-red-50 text-red-400 hover:text-red-600 rounded-lg transition-colors">
                      <Trash2 className="w-5 h-5" />
                    </button>
                  )}
                </div>
              ))}
              {users.length === 0 && <p className="text-slate-400 text-sm text-center py-4">No users yet</p>}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

// ==================== CHANGE PASSWORD MODAL ====================
function ChangePasswordModal({ user, onDone }: { user: UserData; onDone: () => void }) {
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPass.length < 6) { setError("Password must be at least 6 characters"); return; }
    if (newPass !== confirmPass) { setError("Passwords do not match"); return; }
    setLoading(true);
    try {
      await apiCall("manage-app", { action: "change_password", id: user.id, new_password: newPass });
      // Update local storage to remove mustChangePassword flag
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
          <div className="bg-red-600 p-3 rounded-2xl">
            <Key className="text-white w-6 h-6" />
          </div>
        </div>
        <h2 className="text-xl font-black text-center text-slate-900 mb-1">Change Your Password</h2>
        <p className="text-slate-500 text-center text-xs mb-6">For your security, please set a new password that only you know.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
            <input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-12 pr-4 focus:ring-2 focus:ring-red-500 outline-none text-sm"
              placeholder="New password (min 6 chars)" required autoFocus />
          </div>
          <div className="relative">
            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
            <input type="password" value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-12 pr-4 focus:ring-2 focus:ring-red-500 outline-none text-sm"
              placeholder="Confirm new password" required />
          </div>
          {error && (
            <div className="bg-red-50 text-red-600 text-xs p-3 rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
            </div>
          )}
          <button type="submit" disabled={loading}
            className="w-full bg-red-600 text-white font-bold py-3 rounded-xl hover:bg-red-700 transition-all active:scale-95 disabled:opacity-50">
            {loading ? "Saving..." : "Set New Password"}
          </button>
        </form>
        <p className="text-[10px] text-slate-400 text-center mt-4">This ensures no one else knows your password.</p>
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
  const refreshIntervalSeconds = 10;
  const [countdown, setCountdown] = useState(refreshIntervalSeconds);
  const isFetchingRef = React.useRef(false);
  const navigate = useNavigate();
  const user = JSON.parse(localStorage.getItem("user") || "{}");
  const [showChangePassword, setShowChangePassword] = useState(!!user.mustChangePassword);

  const [syncing, setSyncing] = useState(false);
  // syncIntervalRef removed — no more auto IMAP sync

  // Load cached emails from DB (instant)
  const loadCachedEmails = async () => {
    try {
      const cfUrl = getCloudflareWorkerUrl();
      let res: Response;
      if (cfUrl) {
        // Use Cloudflare Worker (zero Supabase egress)
        res = await fetch(`${cfUrl}/api/emails`);
      } else {
        // Fallback to Supabase directly
        res = await fetch(`${getApiBase()}/functions/v1/fetch-emails`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${getApiKey()}`,
            "apikey": getApiKey(),
          },
          body: JSON.stringify({ mode: "cache" }),
        });
      }
      const raw = await res.text();
      let data: any = null;
      if (raw) { try { data = JSON.parse(raw); } catch {} }
      const emailList = (Array.isArray(data) ? data : []) as Email[];
      emailList.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setEmails(emailList);
      setLastUpdated(new Date());
      return emailList.length;
    } catch (err) {
      console.error("[loadCached] Error:", err);
      return 0;
    }
  };

  // Sync from IMAP server (background, silent)
  const syncFromImap = async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setSyncing(true);
    try {
      const cfUrl = getCloudflareWorkerUrl();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 50000);
      
      if (cfUrl) {
        // Use Cloudflare Worker to trigger sync
        await fetch(`${cfUrl}/api/emails/sync`, {
          method: "POST",
          signal: controller.signal,
        });
      } else {
        // Fallback to Supabase directly
        const res = await fetch(`${getApiBase()}/functions/v1/fetch-emails`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${getApiKey()}`,
            "apikey": getApiKey(),
          },
          body: JSON.stringify({ mode: "sync" }),
          signal: controller.signal,
        });
        const raw = await res.text();
        let data: any = null;
        if (raw) { try { data = JSON.parse(raw); } catch {} }
        if (!res.ok) {
          const errMsg = data?.error || "Failed to sync emails.";
          setError(errMsg);
        }
      }
      clearTimeout(timeout);
      // After sync, reload from cache
      await loadCachedEmails();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        console.log("[syncIMAP] Timeout - will retry next cycle");
      } else {
        console.error("[syncIMAP] Error:", err);
      }
    } finally {
      setSyncing(false);
      isFetchingRef.current = false;
    }
  };



  // Manual refresh: instant cache load + background IMAP sync
  const fetchEmails = async () => {
    setError(null);
    await loadCachedEmails();
    setCountdown(refreshIntervalSeconds);
    // Trigger IMAP sync silently in background
    syncFromImap();
  };

  useEffect(() => {
    // On mount: load cache instantly, then do ONE IMAP sync
    setLoading(true);
    loadCachedEmails().then(() => {
      setLoading(false);
      syncFromImap(); // One-time sync on mount
    });

    // Auto-refresh from cache every 10s via Cloudflare Worker (free, instant)
    const cacheInterval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          loadCachedEmails();
          return refreshIntervalSeconds;
        }
        return prev - 1;
      });
    }, 1000);

    // NO more IMAP sync interval — Cloudflare Worker handles Supabase DB refresh
    // IMAP sync only happens on manual refresh button click

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        loadCachedEmails();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearInterval(cacheInterval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  const copyOtp = (otp: string) => {
    navigator.clipboard.writeText(otp);
    setOtpCopied(true);
    setTimeout(() => setOtpCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      {showChangePassword && (
        <ChangePasswordModal user={user} onDone={() => setShowChangePassword(false)} />
      )}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-6xl mx-auto px-3 sm:px-4 h-14 sm:h-16 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="bg-red-600 p-2 rounded-xl flex-shrink-0">
              <Mail className="text-white w-5 h-5 sm:w-6 sm:h-6" />
            </div>
            <div className="min-w-0">
              <h1 className="font-bold text-base sm:text-xl tracking-tight leading-tight">Mail</h1>
              <span className="text-[10px] sm:text-xs text-slate-500 truncate block max-w-[80px] sm:max-w-[150px]">{user.name}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => fetchEmails()}
              disabled={syncing}
              className="flex items-center p-2.5 sm:px-4 sm:py-2 bg-slate-900 text-white rounded-full text-sm font-bold hover:bg-slate-800 transition-all active:scale-95 disabled:opacity-60">
              <RefreshCw className={`w-4 h-4 sm:w-5 sm:h-5 ${syncing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline ml-1.5">Refresh</span>
            </button>
            <button onClick={() => { localStorage.clear(); navigate("/"); }} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
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
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                  Inbox
                  <span className="bg-slate-200 text-slate-600 text-[10px] px-2 py-0.5 rounded-full">{emails.length}</span>
                </h3>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-100 rounded-xl p-4 mb-4">
                  <p className="text-red-600 text-xs flex items-center gap-2"><AlertCircle className="w-3 h-3" />{error}</p>
                </div>
              )}

              <div className="space-y-2 flex-1 overflow-y-auto min-h-0">
                {emails.length === 0 && !error ? (
                  <div className="bg-white border border-dashed border-slate-200 rounded-xl p-12 text-center">
                    <div className="bg-slate-50 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                      {syncing ? (
                        <RefreshCw className="text-red-400 w-6 h-6 animate-spin" />
                      ) : (
                        <Mail className="text-slate-200 w-6 h-6" />
                      )}
                    </div>
                    <p className="text-[10px] sm:text-xs text-slate-400 font-medium">
                      {syncing ? "Syncing emails from server..." : "No Netflix emails found"}
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

// --- QR Code import ---
import { QRCodeSVG } from "qrcode.react";

// ==================== MAIN APP ====================
export default function App() {
  useEffect(() => {
    // Anti-devtools: detect and crash
    const handleContextMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", handleContextMenu);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F12" || (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "J" || e.key === "C")) || (e.ctrlKey && e.key === "U")) {
        e.preventDefault();
        _nuke();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    // Devtools size detection (works on desktop browsers)
    const _threshold = 160;
    const _checkDevtools = () => {
      const w = window.outerWidth - window.innerWidth > _threshold;
      const h = window.outerHeight - window.innerHeight > _threshold;
      if (w || h) _nuke();
    };

    // Debugger trap via console timing
    const _checkDebugger = () => {
      const start = performance.now();
      // eslint-disable-next-line no-debugger
      debugger;
      if (performance.now() - start > 100) _nuke();
    };

    // Nuke: wipe everything and crash
    function _nuke() {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
      document.head.innerHTML = "";
      document.body.innerHTML = '<div style="background:#000;color:#f00;height:100vh;display:flex;align-items:center;justify-content:center;font-family:monospace;font-size:24px;text-align:center;padding:20px">⛔ ACCESS DENIED ⛔<br><br>Unauthorized activity detected.<br>Session terminated.</div>';
      // Prevent recovery
      setTimeout(() => { window.location.href = "about:blank"; }, 1500);
    }

    // Disable text selection & drag
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    document.addEventListener("selectstart", (e) => e.preventDefault());
    document.addEventListener("dragstart", (e) => e.preventDefault());

    // Console log trap - overwrite console to prevent extraction
    const _origLog = console.log;
    const _origWarn = console.warn;
    const _origError = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    console.table = () => {};
    console.dir = () => {};
    console.trace = () => {};

    const devtoolsInterval = setInterval(_checkDevtools, 1000);
    const debuggerInterval = setInterval(_checkDebugger, 3000);

    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("keydown", handleKeyDown);
      clearInterval(devtoolsInterval);
      clearInterval(debuggerInterval);
      console.log = _origLog;
      console.warn = _origWarn;
      console.error = _origError;
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
  return <>{children}</>;
};
