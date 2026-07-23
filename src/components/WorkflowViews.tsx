import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, Tv, Link as LinkIcon, Copy, RefreshCw, Loader2, ShieldCheck, Clock, Trash2, X, ChevronRight, LayoutGrid, Sparkles, Check, LogOut } from "lucide-react";

type ApiCall = (fn: string, body: any) => Promise<any>;
type Notify = { success: (m: string) => void; error: (m: string) => void };

export type WorkflowView = "gmail" | "tv" | "link";
export type UserFeatures = { gmail: boolean; tv: boolean; link: boolean };

export function resolveFeatures(user: any): UserFeatures {
  const f = user?.features;
  if (f && typeof f === "object") {
    return { gmail: f.gmail !== false, tv: f.tv !== false, link: f.link === true };
  }
  return {
    gmail: user?.feature_gmail !== false,
    tv: user?.feature_tv !== false,
    link: user?.feature_link === true,
  };
}

export function countEnabled(f: UserFeatures) {
  return (f.gmail ? 1 : 0) + (f.tv ? 1 : 0) + (f.link ? 1 : 0);
}

const VIEW_KEY = "nf.view.v1";
const VIEW_FEATURES_KEY = "nf.view.features.v1";
const VIEW_REQUEST_KEY = "nf.view.request.v1";

export function requestWorkflowView(view: WorkflowView) {
  try { sessionStorage.setItem(VIEW_REQUEST_KEY, view); } catch {}
}

export function useWorkflowView(user: any, features: UserFeatures) {
  const featureSignature = `${features.gmail ? "1" : "0"}${features.tv ? "1" : "0"}${features.link ? "1" : "0"}`;
  const pickDefault = (): WorkflowView | null => {
    if (features.gmail) return "gmail";
    if (features.tv) return "tv";
    if (features.link) return "link";
    return null;
  };
  const [view, setView] = useState<WorkflowView | null>(() => {
    try {
      const requested = sessionStorage.getItem(VIEW_REQUEST_KEY) as WorkflowView | null;
      if (requested && features[requested]) {
        sessionStorage.removeItem(VIEW_REQUEST_KEY);
        return requested;
      }
      const storedSig = sessionStorage.getItem(VIEW_FEATURES_KEY);
      const stored = sessionStorage.getItem(VIEW_KEY) as WorkflowView | null;
      if (storedSig === featureSignature && stored && features[stored]) return stored;
    } catch {}
    // Show the welcome/chooser whenever the user has 2+ workflows enabled.
    // With just 1 workflow, we auto-open it (no need to ask).
    if (countEnabled(features) < 2) return pickDefault();
    return null;
  });
  useEffect(() => {
    if (view) { try { sessionStorage.setItem(VIEW_KEY, view); sessionStorage.setItem(VIEW_FEATURES_KEY, featureSignature); } catch {} }
  }, [view, featureSignature]);
  useEffect(() => {
    if (view && !features[view]) setView(null);
    try {
      const storedSig = sessionStorage.getItem(VIEW_FEATURES_KEY);
      if (storedSig && storedSig !== featureSignature && countEnabled(features) >= 2) {
        sessionStorage.removeItem(VIEW_KEY);
        setView(null);
      }
    } catch {}
  }, [features, view, featureSignature]);
  const setChoice = useCallback((v: WorkflowView) => setView(v), []);
  const clearChoice = useCallback(() => setView(null), []);
  return { view, setChoice, clearChoice };
}

// ---------------- Chooser (premium white welcome) ----------------

export function WorkflowChooser({ features, user, onPick, onLogout }: {
  features: UserFeatures;
  user?: { name?: string | null; username?: string | null } | null;
  onPick: (v: WorkflowView) => void;
  onLogout?: () => void;
}) {
  const items: { key: WorkflowView; title: string; sub: string; Icon: any; accent: string; tint: string }[] = [];
  if (features.gmail) items.push({ key: "gmail", title: "Gmail Inbox",   sub: "Read Netflix sign-in codes straight from your inbox",  Icon: Mail,    accent: "from-rose-500 to-red-600",       tint: "bg-rose-50 text-rose-600" });
  if (features.tv)    items.push({ key: "tv",    title: "TV Auto-Login", sub: "Enter the 8-digit code shown on your Netflix TV",      Icon: Tv,      accent: "from-indigo-500 to-violet-600",  tint: "bg-indigo-50 text-indigo-600" });
  if (features.link)  items.push({ key: "link",  title: "Direct Link",   sub: "Generate a secure one-tap Netflix sign-in link",       Icon: LinkIcon, accent: "from-emerald-500 to-teal-600",  tint: "bg-emerald-50 text-emerald-600" });

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-[80] bg-gradient-to-br from-slate-50 via-white to-slate-100 flex flex-col"
    >
      <header className="flex items-center justify-between px-4 sm:px-8 h-16 border-b border-slate-200/70 bg-white/70 backdrop-blur">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-red-600 to-rose-500 flex items-center justify-center text-white font-black shadow-sm">N</div>
          <div className="min-w-0">
            <div className="text-sm font-black text-slate-900 leading-tight truncate">Netflix Mail</div>
            <div className="text-[11px] text-slate-500 truncate">{user?.name || user?.username || "Signed in"}</div>
          </div>
        </div>
        {onLogout && (
          <button onClick={onLogout}
            className="flex items-center gap-1.5 h-9 px-3.5 rounded-full bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 active:scale-95 transition-transform shadow-sm">
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
        )}
      </header>

      <div className="flex-1 flex items-center justify-center px-4 py-10 sm:py-14">
        <div className="w-full max-w-5xl">
          <div className="text-center mb-10 sm:mb-14">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white border border-slate-200 shadow-sm text-[10px] font-bold uppercase tracking-[0.24em] text-slate-500">
              <Sparkles className="w-3 h-3 text-amber-500" /> Welcome back
            </div>
            <h2 className="mt-4 text-3xl sm:text-5xl font-black tracking-tight text-slate-900">How would you like to sign in?</h2>
            <p className="mt-3 text-sm sm:text-base text-slate-500 max-w-xl mx-auto">Three dedicated experiences for the same account. Pick one to get started — you can switch anytime from the header.</p>
          </div>

          <div className="grid gap-4 sm:gap-5 sm:grid-cols-3">
            {items.map(({ key, title, sub, Icon, accent, tint }, i) => (
              <motion.button key={key}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 + i * 0.06, type: "spring", stiffness: 240, damping: 22 }}
                whileHover={{ y: -4 }} whileTap={{ scale: 0.98 }}
                onClick={() => onPick(key)}
                className="group relative overflow-hidden rounded-2xl bg-white border border-slate-200 hover:border-slate-300 hover:shadow-[0_20px_50px_-20px_rgba(2,6,23,0.18)] transition-all p-6 text-left focus:outline-none focus:ring-2 focus:ring-slate-900/20"
              >
                <div className={`w-12 h-12 rounded-2xl ${tint} flex items-center justify-center mb-6`}>
                  <Icon className="w-5.5 h-5.5" />
                </div>
                <div className="font-black text-lg text-slate-900 tracking-tight">{title}</div>
                <div className="text-[12.5px] text-slate-500 mt-1 leading-relaxed">{sub}</div>
                <div className="mt-6 inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-widest text-slate-900">
                  Continue <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </div>
                <div aria-hidden className={`pointer-events-none absolute inset-x-0 -bottom-0.5 h-1 bg-gradient-to-r ${accent} opacity-0 group-hover:opacity-100 transition-opacity`} />
              </motion.button>
            ))}
          </div>

          <p className="mt-10 text-center text-[11px] text-slate-400">
            Your workflow choice is remembered on this device.
          </p>
        </div>
      </div>
    </motion.div>
  );
}

// ---------------- View Switcher (header pill) ----------------

export function ViewSwitcher({ features, view, onChange }: { features: UserFeatures; view: WorkflowView | null; onChange: (v: WorkflowView) => void }) {
  if (countEnabled(features) < 2) return null;
  const btn = (k: WorkflowView, Icon: any, label: string) => features[k] ? (
    <button key={k}
      onClick={() => onChange(k)}
      className={`flex items-center gap-1 px-2.5 h-8 rounded-full text-[11px] font-bold transition-all ${view === k ? "bg-slate-900 text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
      title={label}>
      <Icon className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  ) : null;
  return (
    <div className="flex items-center gap-1 bg-slate-100/70 rounded-full p-0.5">
      {btn("gmail", Mail, "Gmail")}
      {btn("link", LinkIcon, "Link")}
      {btn("tv", Tv, "TV")}
    </div>
  );
}

// ---------------- Direct Link View ----------------

type LinkRow = {
  id: string; account_key: string; login_email: string; login_email_masked?: string;
  link_url: string; expires_at: string; created_at: string; revoked_at: string | null; status: string;
};

function fmtIST(iso: string) {
  try { return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); }
  catch { return iso; }
}
function remaining(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function DirectLinkView({ apiCall, notify }: { apiCall: ApiCall; notify: Notify }) {
  type LinkAccount = { account_key: string; login_email_masked: string; label: string };
  const [step, setStep] = useState<"select" | "link">("select");
  const [accounts, setAccounts] = useState<LinkAccount[]>([]);
  const [notConfigured, setNotConfigured] = useState<string | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [chosen, setChosen] = useState<LinkAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [defaultTtl, setDefaultTtl] = useState<number>(60);
  const [, tick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const applyAccounts = useCallback((list: LinkAccount[]) => {
    setAccounts(list);
    if (list.length === 1) {
      setChosen(prev => prev || list[0]);
      setStep(prev => (prev === "select" ? "link" : prev));
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      const cached: any = readAccountsCache("link");
      if (cached) {
        const cachedAccounts = Array.isArray(cached?.accounts) ? cached.accounts : [];
        const cachedTtl = Number(cached?.defaults?.ttl_minutes);
        if (Number.isFinite(cachedTtl) && cachedTtl > 0) setDefaultTtl(Math.floor(cachedTtl));
        applyAccounts(cachedAccounts);
        setNotConfigured(cached?.not_configured ? (cached.message || "Not configured") : null);
        setLoadingAccounts(false);
      }
      const res: any = await apiCall("manage-app", { action: "link_list_accounts" });
      const acc = Array.isArray(res?.accounts) ? res.accounts : [];
      const ttl = Number(res?.defaults?.ttl_minutes);
      if (Number.isFinite(ttl) && ttl > 0) setDefaultTtl(Math.floor(ttl));
      applyAccounts(acc);
      writeAccountsCache("link", res);
      setNotConfigured(res?.not_configured ? (res.message || "Not configured") : null);
    } catch (e: any) {
      setNotConfigured(e?.message || "Failed to load accounts");
    } finally {
      setLoadingAccounts(false);
    }
  }, [applyAccounts]);

  const loadLinks = useCallback(async () => {
    try {
      const res: any = await apiCall("manage-app", { action: "link_list" });
      const ttl = Number(res?.defaults?.ttl_minutes);
      if (Number.isFinite(ttl) && ttl > 0) setDefaultTtl(Math.floor(ttl));
      setLinks(Array.isArray(res?.links) ? res.links : []);
    } catch {}
  }, []);

  useEffect(() => { loadAccounts(); loadLinks(); }, [loadAccounts, loadLinks]);

  const ttlLabel = useMemo(() => defaultTtl < 60 ? `${defaultTtl} min` : defaultTtl < 1440 ? `${Math.round(defaultTtl / 60)} hour${Math.round(defaultTtl / 60) === 1 ? "" : "s"}` : `${Math.round(defaultTtl / 1440)} day${Math.round(defaultTtl / 1440) === 1 ? "" : "s"}`, [defaultTtl]);

  const generate = useCallback(async () => {
    if (!chosen || busy) return;
    setBusy(true);
    try {
      const res: any = await apiCall("manage-app", { action: "link_generate", account_key: chosen.account_key });
      if (res?.link?.link_url) {
        notify.success("Direct Link ready");
        try { await navigator.clipboard.writeText(res.link.link_url); } catch {}
      }
      await loadLinks();
    } catch (e: any) {
      notify.error(e?.message || "Failed to generate link");
    } finally {
      setBusy(false);
    }
  }, [chosen, busy, loadLinks, notify]);

  const revoke = useCallback(async (id: string) => {
    try {
      await apiCall("manage-app", { action: "link_revoke", id });
      await loadLinks();
    } catch (e: any) { notify.error(e?.message || "Failed to revoke"); }
  }, [loadLinks, notify]);

  const copy = useCallback(async (url: string) => {
    try { await navigator.clipboard.writeText(url); notify.success("Link copied"); } catch { notify.error("Copy failed"); }
  }, [notify]);

  const activeLink = (() => {
    if (!chosen) return null;
    // Recomputed every render (including per-second tick) so expiry flips the UI instantly.
    return links.find(l => l.account_key === chosen.account_key && l.status === "active" && new Date(l.expires_at).getTime() > Date.now()) || null;
  })();

  // Auto-generate a fresh link when the active one expires (and the user is on the link step).
  const autoGenRef = useRef<string | null>(null);
  useEffect(() => {
    if (step !== "link" || !chosen || busy) return;
    if (activeLink) { autoGenRef.current = null; return; }
    // Guard so we don't loop if the API keeps failing.
    const key = chosen.account_key;
    if (autoGenRef.current === key) return;
    // Only auto-generate if we've already loaded (avoid triggering on very first mount before links load)
    if (links.length === 0 && loadingAccounts) return;
    autoGenRef.current = key;
    generate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLink, step, chosen, busy]);

  return (
    <div className="min-h-[calc(100vh-4rem)] px-3 sm:px-6 py-8 sm:py-12 xl:py-16 bg-gradient-to-b from-white via-rose-50/40 to-white">
      <div className="max-w-2xl xl:max-w-4xl 2xl:max-w-5xl mx-auto">
        {/* Hero */}
        <div className="text-center mb-8 xl:mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-rose-50 border border-rose-100 text-[10px] xl:text-xs font-bold uppercase tracking-[0.22em] text-rose-600">
            <LinkIcon className="w-3 h-3" /> Netflix · Direct Link
          </div>
          <h1 className="mt-3 text-3xl sm:text-4xl xl:text-5xl 2xl:text-6xl font-black text-slate-900 tracking-tight">
            {step === "select" ? "Choose your account" : "Your one-tap sign-in link"}
          </h1>
          <p className="mt-2 text-sm xl:text-base 2xl:text-lg text-slate-500 max-w-xl mx-auto">
            {step === "select"
              ? "Pick the Netflix account you want a secure one-tap sign-in link for."
              : "Generate a fresh secure link, copy it, or open it on any device."}
          </p>
          {accounts.length > 1 && (
          <div className="mt-5 inline-flex items-center gap-3 text-[11px] xl:text-xs font-bold uppercase tracking-widest">
            <span className={`inline-flex items-center gap-1.5 ${step === "select" ? "text-rose-600" : "text-emerald-600"}`}>
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] ${step === "select" ? "bg-rose-600 text-white" : "bg-emerald-500 text-white"}`}>1</span>
              Account
            </span>
            <span className="w-10 h-px bg-slate-200" />
            <span className={`inline-flex items-center gap-1.5 ${step === "link" ? "text-rose-600" : "text-slate-400"}`}>
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] ${step === "link" ? "bg-rose-600 text-white" : "bg-slate-200 text-slate-500"}`}>2</span>
              Link
            </span>
          </div>
          )}
        </div>

        {/* Card */}
        <div className="relative rounded-3xl bg-white border border-slate-200 shadow-[0_25px_60px_-25px_rgba(2,6,23,0.15)] overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 w-64 h-64 xl:w-96 xl:h-96 rounded-full bg-rose-500/[0.06] blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-16 w-72 h-72 xl:w-[26rem] xl:h-[26rem] rounded-full bg-rose-500/[0.04] blur-3xl" />

          <div className="relative p-6 sm:p-10 xl:p-14">
            {step === "select" ? (
              <div>
                {loadingAccounts ? (
                  <div className="py-12 flex flex-col items-center justify-center gap-2 text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin text-rose-500" />
                    <div className="text-xs">Loading your accounts…</div>
                  </div>
                ) : notConfigured ? (
                  <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-6 text-center">
                    <div className="text-sm font-bold text-amber-800">Direct Link not enabled yet</div>
                    <div className="text-[12px] text-amber-700/90 mt-1 leading-relaxed">{notConfigured}</div>
                  </div>
                ) : accounts.length === 0 ? (
                  <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-6 text-center">
                    <div className="text-sm font-bold text-amber-800">No accounts available</div>
                    <div className="text-[12px] text-amber-700/90 mt-1 leading-relaxed">Admin hasn't linked a Netflix account with cookies yet.</div>
                  </div>
                ) : (
                  <div className="grid gap-2.5 max-h-[360px] xl:max-h-[520px] overflow-y-auto pr-1">
                    {accounts.map((acc) => {
                      const selected = chosen?.account_key === acc.account_key;
                      return (
                        <button key={acc.account_key}
                          onClick={() => setChosen(acc)}
                          className={`group w-full flex items-center gap-3 rounded-2xl border-2 px-4 py-3.5 xl:py-4 text-left transition-all active:scale-[0.99] ${
                            selected
                              ? "bg-rose-50 border-rose-500 shadow-[0_10px_30px_-12px_rgba(229,9,20,0.35)]"
                              : "bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                          }`}>
                          <div className={`shrink-0 w-11 h-11 xl:w-12 xl:h-12 rounded-xl flex items-center justify-center ${selected ? "bg-rose-100 text-rose-600" : "bg-slate-100 text-slate-500"}`}>
                            <Mail className="w-5 h-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm xl:text-base font-bold text-slate-900 truncate tracking-tight">{acc.login_email_masked}</div>
                            {acc.label && (
                              <div className="mt-1 text-[11px] inline-block px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 font-semibold">{acc.label}</div>
                            )}
                          </div>
                          <div className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${selected ? "border-rose-500 bg-rose-500" : "border-slate-300"}`}>
                            {selected && <span className="w-2 h-2 rounded-full bg-white" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                <button onClick={() => { if (chosen) setStep("link"); }}
                  disabled={!chosen}
                  className={`mt-6 w-full h-12 xl:h-14 rounded-xl xl:rounded-2xl font-black text-sm xl:text-base tracking-wide transition-all active:scale-[0.98] ${
                    chosen
                      ? "bg-gradient-to-r from-rose-600 to-red-600 text-white shadow-lg shadow-rose-600/25 hover:shadow-rose-600/40 hover:brightness-110"
                      : "bg-slate-100 text-slate-400 cursor-not-allowed"
                  }`}>
                  Continue →
                </button>
                <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
                  <ShieldCheck className="w-3 h-3" />
                  <span>Account selection is required to continue</span>
                </div>
              </div>
            ) : (
              <div>
                {chosen && accounts.length > 1 && (
                  <div className="flex items-center justify-between gap-2 rounded-2xl bg-slate-50 border border-slate-200 px-4 py-3">
                    <div className="min-w-0 flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-lg bg-white border border-slate-200 flex items-center justify-center">
                        <Mail className="w-4 h-4 text-slate-500" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-slate-900 truncate">{chosen.login_email_masked}</div>
                        {chosen.label && <div className="text-[11px] text-slate-500 truncate">{chosen.label}</div>}
                      </div>
                    </div>
                    <button onClick={() => { setStep("select"); }}
                      disabled={busy}
                      className="text-[11px] font-bold text-rose-600 hover:text-rose-700 transition disabled:opacity-40 disabled:cursor-not-allowed">
                      Change
                    </button>
                  </div>
                )}

                <div className="mt-6 rounded-2xl border border-rose-100 bg-rose-50/60 p-4 xl:p-5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-black text-slate-900">Expiry set by admin</div>
                    <div className="text-[12px] text-slate-500 mt-0.5">Each link stays valid for <b className="text-rose-600">{ttlLabel}</b>.</div>
                  </div>
                  <Clock className="w-5 h-5 text-rose-600 shrink-0" />
                </div>

                {/* Your link */}
                <AnimatePresence mode="wait">
                  {activeLink ? (
                    <motion.div key="have" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.28 }}
                      className="mt-6 rounded-2xl border-2 border-rose-200 bg-gradient-to-br from-rose-50 to-white p-5 xl:p-6">
                      <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest font-black text-rose-600">
                        <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" /> Your link is ready
                      </div>
                      <div className="mt-3 rounded-xl bg-white border border-slate-200 px-3 py-2.5 text-[12px] font-mono text-slate-700 break-all">
                        {activeLink.link_url}
                      </div>
                      <div className="mt-2 text-[11px] text-slate-500">
                        Expires <b className="text-slate-700">{fmtIST(activeLink.expires_at)}</b> · <span className="text-rose-600 font-bold">{remaining(activeLink.expires_at)}</span> left
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-2">
                        <button onClick={() => copy(activeLink.link_url)} className="h-11 rounded-xl bg-white border-2 border-slate-200 text-slate-800 text-sm font-bold hover:bg-slate-50 flex items-center justify-center gap-1.5">
                          <Copy className="w-4 h-4" /> Copy
                        </button>
                        <a href={activeLink.link_url} target="_blank" rel="noopener noreferrer" className="h-11 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 flex items-center justify-center gap-1.5">
                          Open ↗
                        </a>
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div key="none" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.28 }}
                      className="mt-6 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/50 p-6 text-center">
                      <div className="text-sm font-bold text-slate-700">No active link yet</div>
                      <div className="text-[12px] text-slate-500 mt-1">Tap generate to mint a fresh secure Netflix sign-in link.</div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <button onClick={generate} disabled={busy}
                  className="mt-6 w-full h-12 xl:h-14 rounded-xl xl:rounded-2xl bg-gradient-to-r from-rose-600 to-red-600 text-white font-black text-sm xl:text-base shadow-lg shadow-rose-600/25 hover:shadow-rose-600/40 hover:brightness-110 disabled:opacity-60 active:scale-[0.98] flex items-center justify-center gap-2 transition-all">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {busy ? "Generating link…" : activeLink ? "Generate a new link" : "Generate Direct Link"}
                </button>
                <p className="mt-3 text-[11px] text-slate-400 text-center flex items-center justify-center gap-1">
                  <ShieldCheck className="w-3 h-3" /> Links auto-expire · single-use recommended
                </p>
              </div>
            )}
          </div>
        </div>

        {/* History */}
        {links.length > 0 && (
          <div className="mt-6 rounded-3xl bg-white border border-slate-200 shadow-sm p-5 xl:p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-900 flex items-center gap-2 text-sm"><Clock className="w-4 h-4 text-slate-500" /> Recent links</h3>
              <button onClick={loadLinks} className="p-1.5 rounded-full hover:bg-slate-100" title="Refresh"><RefreshCw className="w-3.5 h-3.5 text-slate-500" /></button>
            </div>
            <ul className="divide-y divide-slate-100">
              {links.map(l => {
                const expired = new Date(l.expires_at).getTime() <= Date.now() || l.status !== "active";
                return (
                  <li key={l.id} className="py-3 flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${expired ? "bg-slate-300" : "bg-rose-500"}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-slate-600 truncate font-semibold">{l.login_email_masked || l.login_email}</div>
                      <div className="text-[11px] text-slate-400">Exp: <b>{fmtIST(l.expires_at)}</b> · {expired ? <span className="text-slate-400">expired</span> : <span className="text-rose-600">{remaining(l.expires_at)}</span>}</div>
                    </div>
                    {!expired && (
                      <>
                        <button onClick={() => copy(l.link_url)} className="p-2 rounded-lg hover:bg-slate-100" title="Copy link"><Copy className="w-4 h-4 text-slate-600" /></button>
                        <a href={l.link_url} target="_blank" rel="noopener noreferrer" className="px-3 h-8 rounded-lg bg-slate-900 text-white text-[11px] font-bold flex items-center hover:bg-slate-800">Open</a>
                        <button onClick={() => revoke(l.id)} className="p-2 rounded-lg hover:bg-red-50" title="Revoke"><Trash2 className="w-4 h-4 text-red-500" /></button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}


// ---------------- TV-Only View ----------------

export function TvOnlyView({ onEnter }: { onEnter: () => void }) {
  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6">
      <div className="rounded-2xl bg-gradient-to-br from-indigo-600 via-violet-600 to-purple-700 p-8 shadow-2xl shadow-violet-900/30 text-white text-center">
        <div className="w-16 h-16 rounded-2xl bg-white/15 flex items-center justify-center mx-auto mb-5"><Tv className="w-8 h-8" /></div>
        <h2 className="text-2xl sm:text-3xl font-black tracking-tight">TV Sign-in</h2>
        <p className="text-white/85 text-sm mt-2 max-w-md mx-auto">Enter the 8-digit code shown on your Netflix TV screen and we'll sign you in automatically.</p>
        <button onClick={onEnter}
          className="mt-6 inline-flex items-center gap-2 px-6 h-12 rounded-full bg-white text-indigo-700 font-black text-sm shadow-lg hover:scale-[1.02] active:scale-95 transition-transform">
          <Tv className="w-4 h-4" /> Enter TV code
        </button>
      </div>
    </div>
  );
}

// ---------------- Account prefetch cache (speeds up TV/Link pages) ----------------

const TV_ACCOUNTS_CACHE_KEY = "nf.tv.accounts.v1";
const LINK_ACCOUNTS_CACHE_KEY = "nf.link.accounts.v1";
const ACCOUNTS_TTL_MS = 5 * 60 * 1000; // 5 min

type CachedAccounts<T> = { at: number; data: T };

export function readAccountsCache<T = any>(key: "tv" | "link"): T | null {
  try {
    const raw = sessionStorage.getItem(key === "tv" ? TV_ACCOUNTS_CACHE_KEY : LINK_ACCOUNTS_CACHE_KEY);
    if (!raw) return null;
    const parsed: CachedAccounts<T> = JSON.parse(raw);
    if (Date.now() - parsed.at > ACCOUNTS_TTL_MS) return null;
    return parsed.data;
  } catch { return null; }
}
export function writeAccountsCache<T = any>(key: "tv" | "link", data: T) {
  try {
    sessionStorage.setItem(key === "tv" ? TV_ACCOUNTS_CACHE_KEY : LINK_ACCOUNTS_CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {}
}

// Fire-and-forget prefetch — call as soon as we know features. Cached result populates
// the TV / Link pages instantly on switch.
export function prefetchWorkflowAccounts(apiCall: ApiCall, features: UserFeatures) {
  if (features.tv && !readAccountsCache("tv")) {
    apiCall("manage-app", { action: "tv_list_accounts" })
      .then((res: any) => { if (res?.success) writeAccountsCache("tv", res); })
      .catch(() => {});
  }
  if (features.link && !readAccountsCache("link")) {
    apiCall("manage-app", { action: "link_list_accounts" })
      .then((res: any) => { writeAccountsCache("link", res); })
      .catch(() => {});
  }
}

// ---------------- Universal Workflow Switcher (header button + cinematic popup) ----------------

const WORKFLOW_META: Record<WorkflowView, { title: string; sub: string; Icon: any; accent: string; ring: string; halo: string }> = {
  gmail: { title: "Gmail Inbox",   sub: "Read Netflix sign-in codes from your inbox",  Icon: Mail,    accent: "from-rose-500 to-red-600",         ring: "ring-rose-400/50",    halo: "bg-rose-500/25" },
  link:  { title: "Direct Link",   sub: "Generate a one-tap Netflix login link",       Icon: LinkIcon, accent: "from-emerald-500 to-teal-600",    ring: "ring-emerald-400/50", halo: "bg-emerald-500/25" },
  tv:    { title: "TV Auto-Login", sub: "Enter the 8-digit code shown on your TV",     Icon: Tv,       accent: "from-indigo-500 to-violet-600",   ring: "ring-violet-400/50",  halo: "bg-violet-500/25" },
};

export function WorkflowSwitcher({ features, view, onChange, compact = false }: {
  features: UserFeatures;
  view: WorkflowView | null;
  onChange: (v: WorkflowView) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const enabled = useMemo<WorkflowView[]>(() => {
    const out: WorkflowView[] = [];
    if (features.gmail) out.push("gmail");
    if (features.link) out.push("link");
    if (features.tv) out.push("tv");
    return out;
  }, [features]);

  if (enabled.length < 2) return null;
  const activeMeta = view ? WORKFLOW_META[view] : WORKFLOW_META[enabled[0]];
  const ActiveIcon = activeMeta.Icon;

  const size = compact ? "w-9 h-9" : "w-10 h-10";

  const pick = (v: WorkflowView) => {
    if (v !== view) onChange(v);
    // small delay lets the check animation play before dismiss
    setTimeout(() => setOpen(false), 180);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Switch workflow"
        title="Switch workflow"
        className={`relative ${size} rounded-full bg-gradient-to-br ${activeMeta.accent} text-white shadow-md hover:scale-105 active:scale-95 transition-transform focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-900/30 flex items-center justify-center`}
      >
        <ActiveIcon className={compact ? "w-4 h-4" : "w-4.5 h-4.5"} />
        <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-white flex items-center justify-center shadow ring-1 ring-slate-200">
          <LayoutGrid className="w-2 h-2 text-slate-700" />
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="ws-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[95] bg-black/70 backdrop-blur-md flex items-center justify-center p-4"
            onClick={() => setOpen(false)}
          >
            <motion.div
              key="ws-card"
              initial={{ opacity: 0, y: 24, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 260, damping: 24 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-2xl rounded-3xl border border-white/10 bg-gradient-to-b from-[#141414] via-[#0f0f10] to-[#080809] shadow-[0_30px_100px_-20px_rgba(0,0,0,0.7)] overflow-hidden"
            >
              <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 w-72 h-72 rounded-full bg-white/10 blur-3xl" />
              <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-24 w-80 h-80 rounded-full bg-white/5 blur-3xl" />

              <div className="relative flex items-center justify-between px-5 sm:px-7 pt-5 sm:pt-6">
                <div className="flex items-center gap-2 text-white/70">
                  <Sparkles className="w-4 h-4" />
                  <span className="text-[11px] uppercase tracking-[0.24em] font-bold">Switch workflow</span>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/80"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="relative px-5 sm:px-7 pt-3 pb-6 sm:pb-8">
                <h3 className="text-white text-2xl sm:text-3xl font-black tracking-tight">Choose a workflow</h3>
                <p className="text-white/50 text-xs sm:text-sm mt-1">Same account, three dedicated experiences. Switch anytime.</p>

                <motion.div
                  layout
                  className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                >
                  {enabled.map((k, idx) => {
                    const meta = WORKFLOW_META[k];
                    const Icon = meta.Icon;
                    const selected = view === k;
                    return (
                      <motion.button
                        key={k}
                        onClick={() => pick(k)}
                        initial={{ opacity: 0, y: 14 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.05 + idx * 0.06, type: "spring", stiffness: 260, damping: 22 }}
                        whileHover={{ y: -4 }}
                        whileTap={{ scale: 0.97 }}
                        className={`group relative overflow-hidden rounded-2xl text-left p-4 sm:p-5 bg-gradient-to-br ${meta.accent} shadow-xl shadow-black/40 focus:outline-none ${selected ? `ring-2 ${meta.ring}` : ""}`}
                      >
                        <div aria-hidden className={`pointer-events-none absolute -top-16 -right-14 w-40 h-40 rounded-full blur-3xl ${meta.halo}`} />
                        <div className="relative flex items-start justify-between">
                          <div className="w-11 h-11 rounded-xl bg-white/15 backdrop-blur-sm flex items-center justify-center ring-1 ring-white/25">
                            <Icon className="w-5 h-5 text-white" />
                          </div>
                          <AnimatePresence>
                            {selected ? (
                              <motion.div
                                key="check"
                                initial={{ scale: 0, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }}
                                transition={{ type: "spring", stiffness: 400, damping: 18 }}
                                className="w-7 h-7 rounded-full bg-white text-slate-900 flex items-center justify-center shadow-lg"
                              >
                                <Check className="w-4 h-4" />
                              </motion.div>
                            ) : (
                              <ChevronRight className="w-5 h-5 text-white/80 group-hover:translate-x-0.5 transition-transform" />
                            )}
                          </AnimatePresence>
                        </div>
                        <div className="relative mt-6">
                          <div className="text-white font-black text-lg sm:text-xl tracking-tight">{meta.title}</div>
                          <div className="text-white/85 text-[11.5px] sm:text-xs mt-1 leading-relaxed">{meta.sub}</div>
                        </div>
                        <div className="relative mt-4 inline-flex items-center gap-1 text-[10px] font-bold tracking-widest uppercase text-white/85">
                          {selected ? "Active" : "Tap to switch"}
                        </div>
                      </motion.button>
                    );
                  })}
                </motion.div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
