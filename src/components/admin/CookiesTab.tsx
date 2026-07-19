import { useEffect, useRef, useState } from "react";
import { Cookie, Trash2, ExternalLink, Save, Copy, ChevronDown, Check, Mail, Search } from "lucide-react";

import { notify } from "../toast/notify";

type EmailAccountConfig = {
  label: string;
  host: string;
  port: string;
  user: string;
  password: string;
  cloudflareUrls: string[];
  recipientFilters?: string[];
};

type NetflixCookieEntry = {
  id: string;
  accountLabel: string;
  name: string;
  cookies: string;
  updatedAt: number;
};

type Props = {
  emailAccounts: EmailAccountConfig[];
  netflixCookies: NetflixCookieEntry[];
  ckLoaded: boolean;
  loadNetflixCookies: () => Promise<void> | void;
  ckSelectedAccount: string;
  setCkSelectedAccount: (v: string) => void;
  ckCookieInput: string;
  setCkCookieInput: (v: string) => void;
  ckSaving: boolean;
  saveNetflixCookie: () => Promise<void> | void;
  deleteNetflixCookie: (id: string) => Promise<void> | void;
  openNetflixWithCookies: (entry: NetflixCookieEntry) => Promise<void> | void;
  accountValidationEmail: (acc: EmailAccountConfig) => string;
};

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function CookiesTab(p: Props) {
  useEffect(() => {
    if (!p.ckLoaded) p.loadNetflixCookies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedAcc = p.emailAccounts.find(a => a.label === p.ckSelectedAccount);
  const validationEmail = selectedAcc ? p.accountValidationEmail(selectedAcc) : "";
  const existingForAccount = p.ckSelectedAccount
    ? p.netflixCookies.find(c => c.accountLabel === p.ckSelectedAccount) || null
    : null;

  // Custom dropdown state
  const [ddOpen, setDdOpen] = useState(false);
  const [ddSearch, setDdSearch] = useState("");
  const ddRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ddOpen) return;
    const onClick = (e: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setDdOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDdOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onClick); document.removeEventListener("keydown", onKey); };
  }, [ddOpen]);

  const filteredAccounts = p.emailAccounts.filter(acc => {
    if (!ddSearch.trim()) return true;
    const q = ddSearch.toLowerCase();
    return acc.label.toLowerCase().includes(q) || (acc.user || "").toLowerCase().includes(q);
  });

  const initials = (s: string) => s.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
  const avatarBg = (s: string) => {
    const palette = ["bg-rose-500", "bg-amber-500", "bg-emerald-500", "bg-sky-500", "bg-violet-500", "bg-fuchsia-500", "bg-indigo-500", "bg-teal-500"];
    let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff;
    return palette[Math.abs(h) % palette.length];
  };

  const copyCookies = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify.success("Cookies copied to clipboard");
    } catch {
      notify.error("Copy failed");
    }
  };


  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Header */}
      <div className="px-1">
        <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-950 flex items-center gap-2.5">
          <span className="inline-flex w-9 h-9 rounded-xl bg-slate-900 text-white items-center justify-center shadow-sm">
            <Cookie className="w-5 h-5" />
          </span>
          Cookies
        </h2>
        <p className="text-sm text-slate-500 mt-1.5 ml-[46px]">
          Save <b className="text-slate-800">Netflix session cookies</b> per account. One cookie set per account — re-saving replaces the old one.
        </p>
      </div>

      {/* Step 1 — Select Account */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sm:p-6">
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex w-6 h-6 rounded-full bg-slate-900 text-white items-center justify-center text-[11px] font-black">1</span>
          <h3 className="text-base font-black text-slate-950">Select Account</h3>
        </div>

        {p.emailAccounts.length === 0 ? (
          <p className="text-sm text-slate-500">No email accounts configured. Add one in the Email Accounts section first.</p>
        ) : (
          <>
            <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1.5 block">Account</label>

            <div ref={ddRef} className="relative">
              <button
                type="button"
                onClick={() => { setDdOpen(o => !o); setDdSearch(""); }}
                className={`group w-full flex items-center gap-3 px-3 py-2.5 bg-white border rounded-xl text-left transition-all ${ddOpen ? "border-slate-900 ring-2 ring-slate-900/10 shadow-sm" : "border-slate-300 hover:border-slate-400"}`}
              >
                {selectedAcc ? (
                  <>
                    <span className={`inline-flex w-9 h-9 rounded-lg items-center justify-center text-white text-[12px] font-black shadow-sm ${avatarBg(selectedAcc.label)}`}>
                      {initials(selectedAcc.label)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-bold text-slate-900 truncate leading-tight">{selectedAcc.label}</span>
                      <span className="block text-[11px] text-slate-500 truncate leading-tight mt-0.5">{p.accountValidationEmail(selectedAcc) || "no email"}</span>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="inline-flex w-9 h-9 rounded-lg items-center justify-center bg-slate-100 text-slate-400">
                      <Mail className="w-4 h-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-slate-400 leading-tight">Choose an account</span>
                      <span className="block text-[11px] text-slate-400 leading-tight mt-0.5">{p.emailAccounts.length} available</span>
                    </span>
                  </>
                )}
                <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${ddOpen ? "rotate-180 text-slate-900" : ""}`} />
              </button>

              {ddOpen && (
                <div className="absolute z-50 left-0 right-0 mt-2 bg-white border border-slate-200 rounded-2xl shadow-2xl shadow-slate-900/10 overflow-hidden">
                  {p.emailAccounts.length > 6 && (
                    <div className="p-2 border-b border-slate-100 bg-slate-50/50">
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                          autoFocus
                          value={ddSearch}
                          onChange={(e) => setDdSearch(e.target.value)}
                          placeholder="Search accounts…"
                          className="w-full pl-8 pr-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:border-slate-900"
                        />
                      </div>
                    </div>
                  )}
                  <ul className="max-h-72 overflow-y-auto py-1">
                    {filteredAccounts.length === 0 ? (
                      <li className="px-3 py-6 text-center text-xs text-slate-400">No matches</li>
                    ) : filteredAccounts.map((acc) => {
                      const email = p.accountValidationEmail(acc);
                      const isSel = acc.label === p.ckSelectedAccount;
                      const hasCookies = p.netflixCookies.some(c => c.accountLabel === acc.label);
                      return (
                        <li key={acc.label}>
                          <button
                            type="button"
                            onClick={() => { p.setCkSelectedAccount(acc.label); setDdOpen(false); }}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${isSel ? "bg-slate-900/[0.04]" : "hover:bg-slate-50"}`}
                          >
                            <span className={`inline-flex w-9 h-9 rounded-lg items-center justify-center text-white text-[12px] font-black shadow-sm shrink-0 ${avatarBg(acc.label)}`}>
                              {initials(acc.label)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="text-sm font-bold text-slate-900 truncate leading-tight">{acc.label}</span>
                                {hasCookies && (
                                  <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-full">
                                    <span className="w-1 h-1 bg-emerald-500 rounded-full" />Saved
                                  </span>
                                )}
                              </span>
                              <span className="block text-[11px] text-slate-500 truncate leading-tight mt-0.5">{email || "no email"}</span>
                            </span>
                            {isSel && <Check className="w-4 h-4 text-slate-900 shrink-0" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>

            {selectedAcc && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Validation email</p>
                  <p className="text-sm font-semibold text-slate-900 truncate">{validationEmail || <span className="text-slate-400">— none —</span>}</p>
                </div>
              </div>
            )}

          </>
        )}
      </section>

      {/* Step 2 — Paste cookies */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sm:p-6">
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex w-6 h-6 rounded-full bg-slate-900 text-white items-center justify-center text-[11px] font-black">2</span>
          <h3 className="text-base font-black text-slate-950">
            {existingForAccount ? "Update Cookies" : "Save Cookies"}
          </h3>
        </div>

        <p className="text-[12px] text-slate-500 mb-4 leading-relaxed">
          Login to Netflix in your normal browser, export cookies with an extension like <b>Cookie-Editor</b> (JSON), and paste the exported text below.
          {existingForAccount && <> Saving will <b className="text-slate-800">replace</b> the existing cookies for this account.</>}
        </p>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1.5 block">Netflix Cookies</label>
            <textarea
              value={p.ckCookieInput}
              onChange={(e) => p.setCkCookieInput(e.target.value)}
              placeholder='Paste cookies here (JSON array from Cookie-Editor, or raw document.cookie string)'
              rows={8}
              maxLength={200_000}
              className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-[12px] font-mono text-slate-900 focus:outline-none focus:border-slate-900 transition-all resize-y"
            />
            <p className="text-[11px] text-slate-400 mt-1">{p.ckCookieInput.length.toLocaleString()} chars</p>
          </div>

          <button
            onClick={() => p.saveNetflixCookie()}
            disabled={p.ckSaving || !p.ckSelectedAccount || !p.ckCookieInput.trim()}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <Save className="w-4 h-4" />
            {p.ckSaving ? "Saving…" : existingForAccount ? "Update Cookies" : "Save Cookies"}
          </button>
        </div>
      </section>

      {/* Step 3 — Saved cookies list */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex w-6 h-6 rounded-full bg-slate-900 text-white items-center justify-center text-[11px] font-black">3</span>
            <h3 className="text-base font-black text-slate-950">Saved Cookies</h3>
          </div>
          <span className="text-[11px] font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
            {p.netflixCookies.length} account{p.netflixCookies.length === 1 ? "" : "s"}
          </span>
        </div>

        {!p.ckLoaded ? (
          <p className="text-sm text-slate-400 text-center py-6">Loading…</p>
        ) : p.netflixCookies.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">No cookies saved yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {p.netflixCookies.map((entry) => (
              <li key={entry.id} className="py-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-slate-900 truncate">{entry.accountLabel}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Updated {formatRelative(entry.updatedAt)} · {entry.cookies.length.toLocaleString()} chars
                  </p>
                </div>
                <button
                  onClick={() => p.openNetflixWithCookies(entry)}
                  title="Copy cookies and open Netflix in a new tab"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-[11px] font-bold transition-all"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open
                </button>
                <button
                  onClick={() => copyCookies(entry.cookies)}
                  title="Copy cookies to clipboard"
                  className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-all"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete cookies for "${entry.accountLabel}"?`)) p.deleteNetflixCookie(entry.id);
                  }}
                  title="Delete cookies"
                  className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default CookiesTab;
