import { useEffect } from "react";
import { Cookie, Trash2, ExternalLink, Save, Copy } from "lucide-react";
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
  ckSessionName: string;
  setCkSessionName: (v: string) => void;
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
  const savedForAccount = p.ckSelectedAccount
    ? p.netflixCookies.filter(c => c.accountLabel === p.ckSelectedAccount)
    : p.netflixCookies;

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
          Save <b className="text-slate-800">Netflix session cookies</b> per account. Paste cookies from a browser extension after logging in manually.
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
            <select
              value={p.ckSelectedAccount}
              onChange={(e) => p.setCkSelectedAccount(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-xl text-sm text-slate-900 focus:outline-none focus:border-slate-900 transition-all"
            >
              <option value="">— Choose an account —</option>
              {p.emailAccounts.map((acc) => {
                const email = p.accountValidationEmail(acc);
                return (
                  <option key={acc.label} value={acc.label}>
                    {acc.label}{email ? ` — ${email}` : ""}
                  </option>
                );
              })}
            </select>

            {selectedAcc && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Validation email</p>
                  <p className="text-sm font-semibold text-slate-900 truncate">{validationEmail || <span className="text-slate-400">— none —</span>}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {(selectedAcc.recipientFilters || []).length > 0
                      ? "Using recipient filter"
                      : "No recipient filter — using primary email"}
                  </p>
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
          <h3 className="text-base font-black text-slate-950">Save Session</h3>
        </div>

        <p className="text-[12px] text-slate-500 mb-4 leading-relaxed">
          Login to Netflix in your normal browser, export cookies with an extension like <b>Cookie-Editor</b> (JSON), and paste the exported text below.
        </p>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-1.5 block">Session Name</label>
            <input
              value={p.ckSessionName}
              onChange={(e) => p.setCkSessionName(e.target.value)}
              placeholder="e.g. Primary, Backup, Family"
              maxLength={60}
              className="w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-xl text-sm text-slate-900 focus:outline-none focus:border-slate-900 transition-all"
            />
          </div>

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
            disabled={p.ckSaving || !p.ckSelectedAccount || !p.ckSessionName.trim() || !p.ckCookieInput.trim()}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <Save className="w-4 h-4" />
            {p.ckSaving ? "Saving…" : "Save Session"}
          </button>
        </div>
      </section>

      {/* Step 3 — Saved sessions list */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex w-6 h-6 rounded-full bg-slate-900 text-white items-center justify-center text-[11px] font-black">3</span>
            <h3 className="text-base font-black text-slate-950">Saved Sessions</h3>
          </div>
          <span className="text-[11px] font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
            {savedForAccount.length} {p.ckSelectedAccount ? "for this account" : "total"}
          </span>
        </div>

        {!p.ckLoaded ? (
          <p className="text-sm text-slate-400 text-center py-6">Loading…</p>
        ) : savedForAccount.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">
            {p.ckSelectedAccount ? "No saved sessions for this account yet." : "No sessions saved yet."}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {savedForAccount.map((entry) => (
              <li key={entry.id} className="py-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-bold text-slate-900 truncate">{entry.name}</p>
                    <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">{entry.accountLabel}</span>
                  </div>
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
                    if (confirm(`Delete session "${entry.name}"?`)) p.deleteNetflixCookie(entry.id);
                  }}
                  title="Delete session"
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
