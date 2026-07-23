import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, Tv, Link as LinkIcon, Copy, RefreshCw, Loader2, ShieldCheck, Clock, Trash2, X, ChevronRight, LayoutGrid, Sparkles, Check, LogOut, CalendarClock } from "lucide-react";

type ApiCall = (fn: string, body: any) => Promise<any>;
type Notify = { success: (m: string) => void; error: (m: string) => void };

export type WorkflowView = "gmail" | "tv" | "link";
export type UserFeatures = { gmail: boolean; tv: boolean; link: boolean };

export function resolveFeatures(user: any): UserFeatures {
  const f = user?.features;
  if (f && typeof f === "object") {
    return { gmail: f.gmail !== false, tv: f.tv !== false, link: f.link === true };
  }
  return { gmail: true, tv: true, link: false };
}

export function countEnabled(f: UserFeatures) {
  return (f.gmail ? 1 : 0) + (f.tv ? 1 : 0) + (f.link ? 1 : 0);
}

const VIEW_KEY = "nf.view.v1";

export function useWorkflowView(user: any, features: UserFeatures) {
  const [view, setView] = useState<WorkflowView | null>(() => {
    try {
      const stored = sessionStorage.getItem(VIEW_KEY) as WorkflowView | null;
      if (stored && features[stored]) return stored;
    } catch {}
    const n = countEnabled(features);
    if (n <= 1) {
      if (features.gmail) return "gmail";
      if (features.tv) return "tv";
      if (features.link) return "link";
      return null;
    }
    return null;
  });
  useEffect(() => {
    if (view) { try { sessionStorage.setItem(VIEW_KEY, view); } catch {} }
  }, [view]);
  useEffect(() => {
    if (view && !features[view]) setView(null);
  }, [features, view]);
  const setChoice = useCallback((v: WorkflowView) => setView(v), []);
  const clearChoice = useCallback(() => setView(null), []);
  return { view, setChoice, clearChoice };
}

// ---------------- Chooser ----------------

export function WorkflowChooser({ features, onPick }: { features: UserFeatures; onPick: (v: WorkflowView) => void }) {
  const items: { key: WorkflowView; title: string; sub: string; Icon: any; grad: string }[] = [];
  if (features.gmail) items.push({ key: "gmail", title: "Gmail Inbox", sub: "Read Netflix sign-in codes from your inbox", Icon: Mail, grad: "from-rose-500 to-red-600" });
  if (features.link) items.push({ key: "link", title: "Direct Link", sub: "Generate a one-tap Netflix login link", Icon: LinkIcon, grad: "from-emerald-500 to-teal-600" });
  if (features.tv)   items.push({ key: "tv",   title: "TV Auto-Login", sub: "Enter the 8-digit code shown on your TV", Icon: Tv,   grad: "from-indigo-500 to-violet-600" });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      className="fixed inset-0 z-[80] bg-gradient-to-br from-black via-slate-950 to-black flex items-center justify-center p-4">
      <div className="w-full max-w-3xl">
        <div className="text-center mb-8">
          <h2 className="text-white text-3xl sm:text-4xl font-black tracking-tight">How would you like to sign in?</h2>
          <p className="text-slate-400 text-sm mt-2">Pick a workflow — you can switch anytime from the header.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map(({ key, title, sub, Icon, grad }) => (
            <motion.button key={key} whileHover={{ y: -3 }} whileTap={{ scale: 0.98 }}
              onClick={() => onPick(key)}
              className={`group relative overflow-hidden rounded-2xl p-5 text-left bg-gradient-to-br ${grad} shadow-xl shadow-black/40 focus:outline-none focus:ring-2 focus:ring-white/60`}>
              <div className="flex items-start justify-between">
                <Icon className="w-8 h-8 text-white/95" />
                <ChevronRight className="w-5 h-5 text-white/80 group-hover:translate-x-0.5 transition-transform" />
              </div>
              <div className="mt-6">
                <div className="text-white font-black text-xl tracking-tight">{title}</div>
                <div className="text-white/85 text-xs mt-1 leading-relaxed">{sub}</div>
              </div>
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors pointer-events-none" />
            </motion.button>
          ))}
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
  const [accounts, setAccounts] = useState<{ account_key: string; login_email_masked: string; label: string }[]>([]);
  const [notConfigured, setNotConfigured] = useState<string | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      const res: any = await apiCall("manage-app", { action: "link_list_accounts" });
      const acc = Array.isArray(res?.accounts) ? res.accounts : [];
      setAccounts(acc);
      setSelectedKey(prev => prev && acc.find((a: any) => a.account_key === prev) ? prev : (acc[0]?.account_key || ""));
      setNotConfigured(res?.not_configured ? (res.message || "Not configured") : null);
    } catch (e: any) {
      setNotConfigured(e?.message || "Failed to load accounts");
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  const loadLinks = useCallback(async () => {
    try {
      const res: any = await apiCall("manage-app", { action: "link_list" });
      setLinks(Array.isArray(res?.links) ? res.links : []);
    } catch {}
  }, []);

  useEffect(() => { loadAccounts(); loadLinks(); }, [loadAccounts, loadLinks]);

  const generate = useCallback(async () => {
    if (!selectedKey || busy) return;
    setBusy(true);
    try {
      const res: any = await apiCall("manage-app", { action: "link_generate", account_key: selectedKey });
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
  }, [selectedKey, busy, loadLinks]);

  const revoke = useCallback(async (id: string) => {
    try {
      await apiCall("manage-app", { action: "link_revoke", id });
      await loadLinks();
    } catch (e: any) { notify.error(e?.message || "Failed to revoke"); }
  }, [loadLinks]);

  const copy = useCallback(async (url: string) => {
    try { await navigator.clipboard.writeText(url); notify.success("Link copied"); } catch { notify.error("Copy failed"); }
  }, []);

  const latest = links[0];

  return (
    <div className="min-h-[calc(100vh-4rem)] px-3 sm:px-6 py-8 sm:py-12 xl:py-16 bg-gradient-to-b from-white via-emerald-50/40 to-white">
      <div className="max-w-2xl xl:max-w-4xl 2xl:max-w-5xl mx-auto">
        {/* Hero */}
        <div className="text-center mb-8 xl:mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-100 text-[10px] xl:text-xs font-bold uppercase tracking-[0.22em] text-emerald-700">
            <LinkIcon className="w-3 h-3" /> Netflix · Direct Link
          </div>
          <h1 className="mt-3 text-3xl sm:text-4xl xl:text-5xl 2xl:text-6xl font-black text-slate-900 tracking-tight">
            One-tap Netflix login
          </h1>
          <p className="mt-2 text-sm xl:text-base 2xl:text-lg text-slate-500 max-w-xl mx-auto">
            Pick your Netflix account and we'll mint a secure sign-in link with an expiry — copy or open on any device.
          </p>
        </div>

        {/* Card */}
        <div className="relative rounded-3xl bg-white border border-slate-200 shadow-[0_25px_60px_-25px_rgba(2,6,23,0.15)] overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 w-64 h-64 xl:w-96 xl:h-96 rounded-full bg-emerald-500/[0.06] blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-16 w-72 h-72 xl:w-[26rem] xl:h-[26rem] rounded-full bg-emerald-500/[0.04] blur-3xl" />

          <div className="relative p-6 sm:p-10 xl:p-14 space-y-6">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold text-slate-900 flex items-center gap-2 text-sm xl:text-base">
                <ShieldCheck className="w-4 h-4 text-emerald-600" /> Choose Netflix account
              </h3>
              <button onClick={loadAccounts} className="p-1.5 rounded-full hover:bg-slate-100" title="Refresh">
                <RefreshCw className={`w-3.5 h-3.5 text-slate-500 ${loadingAccounts ? "animate-spin" : ""}`} />
              </button>
            </div>

            {loadingAccounts ? (
              <div className="py-8 flex flex-col items-center justify-center gap-2 text-slate-500">
                <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
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
              <>
                <div className="grid gap-2">
                  {accounts.map(a => (
                    <label key={a.account_key}
                      className={`flex items-center gap-3 p-3.5 xl:p-4 rounded-2xl border-2 cursor-pointer transition-all ${selectedKey === a.account_key ? "border-emerald-500 bg-emerald-50/70 shadow-sm" : "border-slate-200 hover:border-slate-300 bg-white"}`}>
                      <input type="radio" name="lnk-acc" checked={selectedKey === a.account_key} onChange={() => setSelectedKey(a.account_key)} className="accent-emerald-600" />
                      <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center flex-shrink-0">
                        <Mail className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold text-slate-900 truncate">{a.login_email_masked}</div>
                        <div className="text-[11px] text-slate-500 truncate">{a.label}</div>
                      </div>
                      {selectedKey === a.account_key && <Check className="w-4 h-4 text-emerald-600" />}
                    </label>
                  ))}
                </div>
                <button onClick={generate} disabled={!selectedKey || busy}
                  className="w-full h-12 xl:h-14 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-black text-sm xl:text-base shadow-lg shadow-emerald-900/20 disabled:opacity-60 active:scale-[0.99] flex items-center justify-center gap-2">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {busy ? "Generating link…" : "Generate Direct Link"}
                </button>
                <p className="text-[11px] text-slate-400 text-center flex items-center justify-center gap-1">
                  <ShieldCheck className="w-3 h-3" /> Links auto-expire · single-use recommended
                </p>
              </>
            )}

            {/* Latest link — inline highlight */}
            {latest && (
              <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-4 xl:p-5">
                <div className="flex items-start gap-3">
                  <div className={`w-2 h-2 rounded-full mt-2 ${new Date(latest.expires_at).getTime() <= Date.now() || latest.status !== "active" ? "bg-slate-300" : "bg-emerald-500 animate-pulse"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] uppercase tracking-widest font-black text-emerald-700">Latest link</div>
                    <div className="text-sm font-bold text-slate-800 truncate mt-0.5">{latest.login_email_masked || latest.login_email}</div>
                    <div className="text-[11px] text-slate-500 mt-1">
                      Expires <b>{fmtIST(latest.expires_at)}</b> · {new Date(latest.expires_at).getTime() <= Date.now() ? <span className="text-slate-400">expired</span> : <span className="text-emerald-600">{remaining(latest.expires_at)}</span>}
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button onClick={() => copy(latest.link_url)} className="flex-1 h-9 rounded-lg bg-white border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-50 flex items-center justify-center gap-1.5">
                        <Copy className="w-3.5 h-3.5" /> Copy
                      </button>
                      <a href={latest.link_url} target="_blank" rel="noopener noreferrer" className="flex-1 h-9 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 flex items-center justify-center gap-1.5">
                        Open
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* History */}
        {links.length > 1 && (
          <div className="mt-6 rounded-3xl bg-white border border-slate-200 shadow-sm p-5 xl:p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-900 flex items-center gap-2 text-sm"><Clock className="w-4 h-4 text-slate-500" /> Recent links</h3>
              <button onClick={loadLinks} className="p-1.5 rounded-full hover:bg-slate-100" title="Refresh"><RefreshCw className="w-3.5 h-3.5 text-slate-500" /></button>
            </div>
            <ul className="divide-y divide-slate-100">
              {links.slice(1).map(l => {
                const expired = new Date(l.expires_at).getTime() <= Date.now() || l.status !== "active";
                return (
                  <li key={l.id} className="py-3 flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${expired ? "bg-slate-300" : "bg-emerald-500"}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-slate-600 truncate font-semibold">{l.login_email_masked || l.login_email}</div>
                      <div className="text-[11px] text-slate-400">Exp: <b>{fmtIST(l.expires_at)}</b> · {expired ? <span className="text-slate-400">expired</span> : <span className="text-emerald-600">{remaining(l.expires_at)}</span>}</div>
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
