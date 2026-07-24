import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, Tv, Link as LinkIcon, Copy, RefreshCw, Loader2, ShieldCheck, Clock, X, ChevronRight, LayoutGrid, Sparkles, Check, LogOut } from "lucide-react";

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

// No browser storage — the last chosen workflow lives on the server
// (`app_users.last_workflow_view`) so it follows the user across browsers
// and devices. A same-tab module variable carries a one-shot admin
// impersonation override across an SPA navigation without touching storage.
let __pendingWorkflowView: WorkflowView | null = null;
export function requestWorkflowView(view: WorkflowView) {
  __pendingWorkflowView = view;
}
export function consumePendingWorkflowView(): WorkflowView | null {
  const v = __pendingWorkflowView;
  __pendingWorkflowView = null;
  return v;
}

export function useWorkflowView(user: any, features: UserFeatures) {
  const pickDefault = (): WorkflowView | null => {
    if (features.gmail) return "gmail";
    if (features.tv) return "tv";
    if (features.link) return "link";
    return null;
  };
  const [view, setView] = useState<WorkflowView | null>(() => {
    const requested = consumePendingWorkflowView();
    if (requested && features[requested]) return requested;
    // With only 1 workflow enabled we auto-open it — no need to ask.
    if (countEnabled(features) < 2) return pickDefault();
    // 2+ workflows → always show the chooser. The chooser itself pre-
    // selects the DB-remembered last choice and auto-opens it after 10s.
    return null;
  });
  useEffect(() => {
    if (view && !features[view]) setView(null);
  }, [features, view]);
  const setChoice = useCallback((v: WorkflowView) => setView(v), []);
  const clearChoice = useCallback(() => setView(null), []);
  return { view, setChoice, clearChoice };
}

// ---------------- Chooser (premium white welcome) ----------------

export function WorkflowChooser({ features, user, lastView, onPick, onLogout, autoPickMs = 10000 }: {
  features: UserFeatures;
  user?: { name?: string | null; username?: string | null } | null;
  lastView?: WorkflowView | null;
  onPick: (v: WorkflowView) => void;
  onLogout?: () => void;
  autoPickMs?: number;
}) {
  const items: { key: WorkflowView; title: string; sub: string; Icon: any; accent: string; tint: string }[] = [];
  if (features.gmail) items.push({ key: "gmail", title: "Gmail Inbox",   sub: "Read Netflix sign-in codes straight from your inbox",  Icon: Mail,    accent: "from-rose-500 to-red-600",       tint: "bg-rose-50 text-rose-600" });
  if (features.tv)    items.push({ key: "tv",    title: "TV Auto-Login", sub: "Enter the 8-digit code shown on your Netflix TV",      Icon: Tv,      accent: "from-indigo-500 to-violet-600",  tint: "bg-indigo-50 text-indigo-600" });
  if (features.link)  items.push({ key: "link",  title: "Direct Link",   sub: "Generate a secure one-tap Netflix sign-in link",       Icon: LinkIcon, accent: "from-emerald-500 to-teal-600",  tint: "bg-emerald-50 text-emerald-600" });

  // The "last used" workflow is remembered server-side (app_users.last_workflow_view)
  // so it follows the user across browsers and devices. We highlight it and, if
  // the user does nothing for `autoPickMs`, we auto-open it.
  const remembered: WorkflowView | null =
    lastView && features[lastView] ? lastView : null;

  const totalSec = Math.max(1, Math.ceil(autoPickMs / 1000));
  const [secondsLeft, setSecondsLeft] = useState<number>(remembered ? totalSec : 0);
  const [cancelled, setCancelled] = useState<boolean>(!remembered);

  useEffect(() => {
    if (!remembered || cancelled) return;
    setSecondsLeft(totalSec);
    const tickId = window.setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    const fireId = window.setTimeout(() => {
      window.clearInterval(tickId);
      onPick(remembered);
    }, autoPickMs);
    const cancel = () => setCancelled(true);
    window.addEventListener("pointerdown", cancel, { once: true });
    window.addEventListener("keydown", cancel, { once: true });
    window.addEventListener("wheel", cancel, { once: true, passive: true });
    return () => {
      window.clearInterval(tickId);
      window.clearTimeout(fireId);
      window.removeEventListener("pointerdown", cancel);
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("wheel", cancel);
    };
  }, [remembered, cancelled, autoPickMs, totalSec, onPick]);

  const progress = remembered && !cancelled ? Math.max(0, Math.min(1, secondsLeft / totalSec)) : 0;

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-[80] bg-gradient-to-br from-slate-50 via-white to-slate-100 flex flex-col overflow-hidden"
    >
      <header className="shrink-0 flex items-center justify-between px-4 sm:px-8 h-16 border-b border-slate-200/70 bg-white/70 backdrop-blur">
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

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch] px-3 sm:px-6 pt-4 sm:pt-8 xl:pt-12 2xl:pt-16 pb-32 sm:pb-36">
        <div className="w-full max-w-md sm:max-w-3xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-[110rem] mx-auto min-h-full flex flex-col justify-start lg:justify-center">
          <div className="text-center mb-4 sm:mb-8 xl:mb-12 2xl:mb-16 shrink-0">
            <div className="hidden sm:inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white border border-slate-200 shadow-sm text-[10px] xl:text-xs 2xl:text-sm font-bold uppercase tracking-[0.24em] text-slate-500">
              <Sparkles className="w-3 h-3 xl:w-4 xl:h-4 text-amber-500" /> Welcome back
            </div>
            <h2 className="mt-0 sm:mt-4 text-[25px] leading-[1.08] sm:text-4xl lg:text-5xl xl:text-6xl 2xl:text-8xl font-black tracking-tight text-slate-900">How would you like to sign in?</h2>
            <p className="mt-2 sm:mt-3 text-[12.5px] sm:text-base xl:text-lg 2xl:text-2xl text-slate-500 max-w-xl xl:max-w-2xl 2xl:max-w-4xl mx-auto leading-relaxed">Three dedicated experiences for the same account. Pick one to get started.</p>
            {remembered && !cancelled && (
              <div className="mt-4 sm:mt-5 inline-flex items-center gap-2 px-3 py-1.5 xl:px-4 xl:py-2 rounded-full bg-slate-900 text-white text-[11px] xl:text-sm 2xl:text-base font-bold shadow-sm">
                <Clock className="w-3.5 h-3.5 xl:w-4 xl:h-4" />
                Opening your last choice in {secondsLeft}s — press any key to cancel
              </div>
            )}
          </div>

          <div className={`grid gap-3 sm:gap-5 xl:gap-7 2xl:gap-10 mx-auto w-full ${items.length === 1 ? "max-w-xs sm:max-w-sm" : items.length === 2 ? "grid-cols-1 sm:grid-cols-2 max-w-2xl xl:max-w-4xl 2xl:max-w-6xl" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"}`}>
            {items.map(({ key, title, sub, Icon, accent, tint }, i) => {
              const isLast = remembered === key;
              return (
                <motion.button key={key}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.05 + i * 0.06, type: "spring", stiffness: 240, damping: 22 }}
                  whileHover={{ y: -4 }} whileTap={{ scale: 0.98 }}
                  onClick={() => onPick(key)}
                  className={`group relative overflow-hidden rounded-2xl xl:rounded-3xl bg-white transition-all p-5 sm:p-6 xl:p-8 2xl:p-12 min-h-[180px] sm:min-h-[224px] xl:min-h-[280px] 2xl:min-h-[360px] flex flex-col text-left focus:outline-none focus:ring-2 focus:ring-slate-900/20 ${
                    isLast
                      ? "border-2 border-slate-900 shadow-[0_24px_60px_-20px_rgba(2,6,23,0.28)]"
                      : "border border-slate-200 hover:border-slate-300 hover:shadow-[0_20px_50px_-20px_rgba(2,6,23,0.18)]"
                  }`}
                >
                  {isLast && (
                    <div className="absolute top-3 right-3 xl:top-4 xl:right-4 inline-flex items-center gap-1 px-2 py-0.5 xl:px-2.5 xl:py-1 rounded-full bg-slate-900 text-white text-[9px] xl:text-[11px] font-black uppercase tracking-wider">
                      <Check className="w-3 h-3" /> Last used
                    </div>
                  )}
                  <div className={`w-12 h-12 xl:w-16 xl:h-16 2xl:w-20 2xl:h-20 rounded-2xl xl:rounded-3xl ${tint} flex items-center justify-center mb-5 xl:mb-7 shrink-0`}>
                    <Icon className="w-5 h-5 xl:w-7 xl:h-7 2xl:w-9 2xl:h-9" />
                  </div>
                  <div className="font-black text-lg xl:text-2xl 2xl:text-4xl text-slate-900 tracking-tight">{title}</div>
                  <div className="text-[12.5px] xl:text-sm 2xl:text-lg text-slate-500 mt-1 xl:mt-2 leading-relaxed">{sub}</div>
                  <div className="mt-auto pt-5 xl:pt-7 inline-flex items-center gap-1.5 text-[11px] xl:text-xs 2xl:text-sm font-black uppercase tracking-widest text-slate-900">
                    Continue <ChevronRight className="w-3.5 h-3.5 xl:w-4 xl:h-4 group-hover:translate-x-0.5 transition-transform" />
                  </div>
                  <div aria-hidden className={`pointer-events-none absolute inset-x-0 -bottom-0.5 h-1 bg-gradient-to-r ${accent} ${isLast ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity`} />
                  {isLast && progress > 0 && (
                    <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-slate-900/10 overflow-hidden">
                      <div
                        className={`h-full bg-gradient-to-r ${accent} transition-[width] duration-1000 ease-linear`}
                        style={{ width: `${progress * 100}%` }}
                      />
                    </div>
                  )}
                </motion.button>
              );
            })}
          </div>

          <p className="mt-4 sm:mt-8 xl:mt-12 pb-2 text-center text-[11px] xl:text-sm 2xl:text-base text-slate-400">
            Your workflow choice is remembered on your account — across every browser and device.
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

function normalizeLinks(value: any): LinkRow[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.links)) return value.links;
  return [];
}

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
        applyAccounts(cachedAccounts);
        setNotConfigured(cached?.not_configured ? (cached.message || "Not configured") : null);
        setLoadingAccounts(false);
      }
      const res: any = await apiCall("manage-app", { action: "link_list_accounts" });
      const acc = Array.isArray(res?.accounts) ? res.accounts : [];
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
      const list = normalizeLinks(res);
      setLinks(list);
      writeLinksCache(list);
    } catch {}
  }, []);

  useEffect(() => {
    // Instant paint from prefetched cache, then refresh silently in the background.
    const cachedLinks = readLinksCache();
    if (cachedLinks) setLinks(normalizeLinks(cachedLinks));
    loadAccounts();
    loadLinks();
  }, [loadAccounts, loadLinks]);

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

  const copy = useCallback(async (url: string) => {
    try { await navigator.clipboard.writeText(url); notify.success("Link copied"); } catch { notify.error("Copy failed"); }
  }, [notify]);

  const activeLink = (() => {
    if (!chosen) return null;
    // Recomputed every render (including per-second tick) so expiry flips the UI instantly.
    return links.find(l => l.account_key === chosen.account_key && l.status === "active" && new Date(l.expires_at).getTime() > Date.now()) || null;
  })();

  return (
    <div className="min-h-[calc(100vh-4rem)] px-3 sm:px-6 pt-8 sm:pt-12 xl:pt-16 pb-32 sm:pb-36 bg-gradient-to-b from-white via-rose-50/40 to-white">
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
                        Valid until <b className="text-slate-700">{fmtIST(activeLink.expires_at)}</b> · <span className="text-rose-600 font-bold">{remaining(activeLink.expires_at)}</span> left
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
                      <div className="text-sm font-bold text-slate-700">No active link</div>
                      <div className="text-[12px] text-slate-500 mt-1">If the previous link expired, generate a new one manually.</div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <button onClick={generate} disabled={busy || !chosen || !!activeLink}
                  className="mt-6 w-full h-12 xl:h-14 rounded-xl xl:rounded-2xl bg-gradient-to-r from-rose-600 to-red-600 text-white font-black text-sm xl:text-base shadow-lg shadow-rose-600/25 hover:shadow-rose-600/40 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100 active:scale-[0.98] flex items-center justify-center gap-2 transition-all">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {busy ? "Generating link…" : activeLink ? `New link in ${remaining(activeLink.expires_at)}` : "Generate Direct Link"}
                </button>
                {activeLink && (
                  <p className="mt-2 text-[11px] text-amber-700 text-center font-semibold">
                    Your current link is still active — you can generate a new one once it expires.
                  </p>
                )}
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
                      <div className="text-xs text-slate-600 truncate font-semibold">Direct link</div>
                      <div className="text-[11px] text-slate-400">Exp: <b>{fmtIST(l.expires_at)}</b> · {expired ? <span className="text-slate-400">expired</span> : <span className="text-rose-600">{remaining(l.expires_at)}</span>}</div>
                    </div>
                    {!expired && (
                      <>
                        <button onClick={() => copy(l.link_url)} className="p-2 rounded-lg hover:bg-slate-100" title="Copy link"><Copy className="w-4 h-4 text-slate-600" /></button>
                        <a href={l.link_url} target="_blank" rel="noopener noreferrer" className="px-3 h-8 rounded-lg bg-slate-900 text-white text-[11px] font-bold flex items-center hover:bg-slate-800">Open</a>
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
const LINK_LIST_CACHE_KEY = "nf.link.list.v1";
const ACCOUNTS_TTL_MS = 5 * 60 * 1000; // 5 min
const LINK_LIST_TTL_MS = 60 * 1000;    // 60s — links are short-lived, but instant paint matters

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

export function readLinksCache<T = any>(): T | null {
  try {
    const raw = sessionStorage.getItem(LINK_LIST_CACHE_KEY);
    if (!raw) return null;
    const parsed: CachedAccounts<T> = JSON.parse(raw);
    if (Date.now() - parsed.at > LINK_LIST_TTL_MS) return null;
    return parsed.data;
  } catch { return null; }
}
export function writeLinksCache<T = any>(data: T) {
  try {
    sessionStorage.setItem(LINK_LIST_CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
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
  if (features.link) {
    if (!readAccountsCache("link")) {
      apiCall("manage-app", { action: "link_list_accounts" })
        .then((res: any) => { writeAccountsCache("link", res); })
        .catch(() => {});
    }
    if (!readLinksCache()) {
      apiCall("manage-app", { action: "link_list" })
        .then((res: any) => {
          const list = Array.isArray(res?.links) ? res.links : [];
          writeLinksCache(list);
        })
        .catch(() => {});
    }
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

  const pick = (v: WorkflowView) => {
    if (v !== view) onChange(v);
    setTimeout(() => setOpen(false), 180);
  };

  const iconSize = compact ? "w-4 h-4" : "w-4 h-4 sm:w-5 sm:h-5";

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("notif:open"));
    return () => { window.dispatchEvent(new CustomEvent("notif:close")); };
  }, [open]);

  const popup = typeof document !== "undefined" ? createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="ws-backdrop"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[10020] bg-slate-950/55 backdrop-blur-md flex items-end sm:items-center justify-center px-3 sm:px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:py-4"
          onClick={() => setOpen(false)}
        >
          <motion.div
            key="ws-card"
            initial={{ opacity: 0, y: 32, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            onClick={(e) => e.stopPropagation()}
            className={`relative w-full rounded-[1.75rem] sm:rounded-3xl border border-slate-200 bg-white shadow-[0_30px_90px_-20px_rgba(15,23,42,0.45)] overflow-hidden max-h-[min(88dvh,42rem)] sm:max-h-[min(86dvh,44rem)] overflow-y-auto overscroll-contain ${enabled.length >= 3 ? "sm:max-w-3xl xl:max-w-5xl 2xl:max-w-7xl" : enabled.length === 2 ? "sm:max-w-xl xl:max-w-3xl 2xl:max-w-5xl" : "sm:max-w-sm xl:max-w-md"}`}
          >
            <div aria-hidden className="sm:hidden flex justify-center pt-2.5">
              <div className="w-10 h-1 rounded-full bg-slate-300" />
            </div>

            <div className="relative flex items-center justify-between px-4 sm:px-7 xl:px-9 pt-4 sm:pt-6">
              <div className="flex items-center gap-2 text-slate-500 min-w-0">
                <LayoutGrid className="w-4 h-4 xl:w-5 xl:h-5 shrink-0" />
                <span className="text-[10px] sm:text-[11px] xl:text-sm uppercase tracking-[0.22em] font-bold truncate">Switch workflow</span>
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="w-9 h-9 xl:w-10 xl:h-10 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-600 transition-colors shrink-0"
              >
                <X className="w-4 h-4 xl:w-5 xl:h-5" />
              </button>
            </div>

            <div className="relative px-4 sm:px-7 xl:px-9 pt-3 pb-5 sm:pb-8 xl:pb-10">
              <h3 className="text-slate-900 text-2xl sm:text-3xl xl:text-4xl 2xl:text-6xl font-black tracking-tight leading-tight">Choose a workflow</h3>
              <p className="text-slate-500 text-xs sm:text-sm xl:text-base 2xl:text-xl mt-1 leading-relaxed">Same account, dedicated experiences. Switch anytime.</p>

              <motion.div
                layout
                className={`mt-4 sm:mt-6 xl:mt-8 grid gap-3 xl:gap-5 ${enabled.length >= 3 ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" : enabled.length === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}
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
                      className={`group relative overflow-hidden rounded-2xl xl:rounded-3xl text-left p-4 sm:p-5 xl:p-7 2xl:p-9 bg-white border border-slate-200 shadow-[0_10px_30px_-12px_rgba(15,23,42,0.2)] hover:shadow-[0_18px_40px_-12px_rgba(15,23,42,0.3)] focus:outline-none transition-shadow ${selected ? `ring-2 ring-offset-2 ring-offset-white ${meta.ring}` : ""}`}
                    >
                      <div aria-hidden className={`pointer-events-none absolute -top-16 -right-14 w-40 h-40 rounded-full blur-3xl ${meta.halo}`} />
                      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent" />

                      <div className="relative flex items-start justify-between gap-3">
                        <div className={`w-11 h-11 xl:w-14 xl:h-14 2xl:w-20 2xl:h-20 rounded-xl xl:rounded-2xl bg-gradient-to-br ${meta.accent} flex items-center justify-center shadow-lg ring-1 ring-white/50 shrink-0`}>
                          <Icon className="w-5 h-5 xl:w-6 xl:h-6 2xl:w-9 2xl:h-9 text-white" />
                        </div>
                        <AnimatePresence>
                          {selected ? (
                            <motion.div
                              key="check"
                              initial={{ scale: 0, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }}
                              transition={{ type: "spring", stiffness: 400, damping: 18 }}
                              className={`w-7 h-7 xl:w-9 xl:h-9 rounded-full bg-gradient-to-br ${meta.accent} text-white flex items-center justify-center shadow-lg shrink-0`}
                            >
                              <Check className="w-4 h-4 xl:w-5 xl:h-5" />
                            </motion.div>
                          ) : (
                            <ChevronRight className="w-5 h-5 xl:w-6 xl:h-6 text-slate-400 group-hover:text-slate-700 group-hover:translate-x-0.5 transition-all shrink-0" />
                          )}
                        </AnimatePresence>
                      </div>
                      <div className="relative mt-4 xl:mt-7">
                        <div className="text-slate-900 font-black text-lg sm:text-xl xl:text-2xl 2xl:text-4xl tracking-tight leading-tight">{meta.title}</div>
                        <div className="text-slate-500 text-[12px] sm:text-xs xl:text-sm 2xl:text-lg mt-1 xl:mt-2 leading-relaxed">{meta.sub}</div>
                      </div>
                      <div className={`relative mt-4 xl:mt-6 inline-flex items-center gap-1 text-[10px] xl:text-xs 2xl:text-sm font-bold tracking-widest uppercase ${selected ? "text-slate-900" : "text-slate-400"}`}>
                        {selected ? (
                          <>
                            <span className={`w-1.5 h-1.5 xl:w-2 xl:h-2 rounded-full bg-gradient-to-br ${meta.accent}`} />
                            Active
                          </>
                        ) : "Tap to switch"}
                      </div>
                    </motion.button>
                  );
                })}
              </motion.div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Switch workflow"
        title="Switch workflow"
        className="relative flex items-center justify-center p-2.5 bg-slate-900 text-white rounded-full hover:bg-slate-800 transition-all active:scale-95"
      >
        <ActiveIcon className={iconSize} />
        <span
          aria-hidden
          className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white bg-gradient-to-br ${activeMeta.accent}`}
        />
      </button>

      {popup}
    </>
  );
}

