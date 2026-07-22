import React, { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, Tv, Link as LinkIcon, Copy, RefreshCw, Loader2, ShieldCheck, Clock, Trash2, X, ChevronRight } from "lucide-react";

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

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 p-6 shadow-xl shadow-emerald-900/20 text-white">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-white/20 flex items-center justify-center"><LinkIcon className="w-6 h-6" /></div>
          <div>
            <h2 className="text-xl sm:text-2xl font-black tracking-tight">Direct Netflix Link</h2>
            <p className="text-white/85 text-xs mt-0.5">One-tap sign-in via a secure nftoken URL.</p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-bold text-slate-900 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-emerald-600" /> Choose Netflix account</h3>
          <button onClick={loadAccounts} className="p-1.5 rounded-full hover:bg-slate-100" title="Refresh">
            <RefreshCw className={`w-3.5 h-3.5 text-slate-500 ${loadingAccounts ? "animate-spin" : ""}`} />
          </button>
        </div>

        {loadingAccounts ? (
          <div className="text-sm text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : notConfigured ? (
          <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">{notConfigured}</div>
        ) : (
          <>
            <div className="grid gap-2">
              {accounts.map(a => (
                <label key={a.account_key} className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${selectedKey === a.account_key ? "border-emerald-500 bg-emerald-50" : "border-slate-200 hover:border-slate-300"}`}>
                  <input type="radio" name="lnk-acc" checked={selectedKey === a.account_key} onChange={() => setSelectedKey(a.account_key)} className="accent-emerald-600" />
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-slate-900 truncate">{a.login_email_masked}</div>
                    <div className="text-[11px] text-slate-500">{a.label}</div>
                  </div>
                </label>
              ))}
            </div>
            <button onClick={generate} disabled={!selectedKey || busy}
              className="w-full h-11 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-white font-black text-sm shadow-md shadow-emerald-900/20 disabled:opacity-60 active:scale-[0.99] flex items-center justify-center gap-2">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LinkIcon className="w-4 h-4" />}
              {busy ? "Generating…" : "Generate Direct Link"}
            </button>
          </>
        )}
      </div>

      <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-slate-900 flex items-center gap-2"><Clock className="w-4 h-4 text-slate-500" /> Your recent links</h3>
          <button onClick={loadLinks} className="p-1.5 rounded-full hover:bg-slate-100" title="Refresh"><RefreshCw className="w-3.5 h-3.5 text-slate-500" /></button>
        </div>
        {links.length === 0 ? (
          <div className="text-sm text-slate-400 py-6 text-center">No links yet — generate one above.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {links.map(l => {
              const expired = new Date(l.expires_at).getTime() <= Date.now() || l.status !== "active";
              return (
                <li key={l.id} className="py-3 flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${expired ? "bg-slate-300" : "bg-emerald-500"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-slate-500 truncate">{l.login_email_masked || l.login_email}</div>
                    <div className="text-[11px] text-slate-400">Exp: <b>{fmtIST(l.expires_at)}</b> IST · {expired ? <span className="text-slate-400">expired</span> : <span className="text-emerald-600">{remaining(l.expires_at)}</span>}</div>
                  </div>
                  {!expired && (
                    <>
                      <button onClick={() => copy(l.link_url)} className="p-2 rounded-lg hover:bg-slate-100" title="Copy link"><Copy className="w-4 h-4 text-slate-600" /></button>
                      <a href={l.link_url} target="_blank" rel="noopener noreferrer"
                        className="px-3 h-8 rounded-lg bg-slate-900 text-white text-[11px] font-bold flex items-center hover:bg-slate-800">Open</a>
                      <button onClick={() => revoke(l.id)} className="p-2 rounded-lg hover:bg-red-50" title="Revoke"><Trash2 className="w-4 h-4 text-red-500" /></button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
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
