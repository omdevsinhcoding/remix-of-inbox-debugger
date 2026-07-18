// Netflix Auto-Login TEST page (isolated).
// Reachable only at /admin/netflix-test. Not linked from user-facing UI.
// Safe to delete along with `netflix-automation/` folder + edge function.
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../integrations/supabase/client";
import { sessionGet } from "../lib/session";

type Account = {
  label: string;
  email: string;
  session: null | {
    status: string;
    last_error: string | null;
    last_login_at: string | null;
  };
};

type LogEntry = { ts: string; level: string; message: string };

async function callFn(action: string, payload: Record<string, unknown> = {}) {
  const token = sessionGet("session_token") || "";
  const { data, error } = await supabase.functions.invoke("netflix-auto-login", {
    body: { action, ...payload },
    headers: token ? { "x-session-token": token } : {},
  });
  if (error) throw new Error(error.message);
  return data;
}

export default function NetflixAutoLoginTest() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [workerReady, setWorkerReady] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAccounts = useCallback(async () => {
    try {
      const res = await callFn("list_accounts");
      setAccounts(res?.accounts || []);
      setWorkerReady(!!res?.automation_url_configured);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { refreshAccounts(); }, [refreshAccounts]);

  // poll logs when a session is selected
  useEffect(() => {
    if (!selectedEmail) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await callFn("get_logs", { email: selectedEmail });
        if (stop) return;
        setLogs(res?.session?.logs || []);
        setStatus(res?.session?.status || "");
      } catch { /* ignore */ }
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => { stop = true; window.clearInterval(id); };
  }, [selectedEmail]);

  async function trigger(acc: Account) {
    setLoading(true);
    setError(null);
    setSelectedEmail(acc.email);
    setLogs([]);
    try {
      await callFn("trigger", { email: acc.email, accountLabel: acc.label });
      await refreshAccounts();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Netflix Auto-Login · Test</h1>
            <p className="text-sm text-slate-400">Isolated experimental feature · not exposed to users</p>
          </div>
          <a href="/admin/dashboard" className="text-sm text-slate-400 hover:text-white">← Back to Admin</a>
        </header>

        {!workerReady && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-200 text-sm">
            Worker not configured. Set <code className="px-1 rounded bg-black/40">NETFLIX_AUTOMATION_URL</code> and{" "}
            <code className="px-1 rounded bg-black/40">NETFLIX_AUTOMATION_SECRET</code> in Supabase edge function secrets,
            then start the service in <code>netflix-automation/</code>.
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-red-200 text-sm">{error}</div>
        )}

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-semibold text-slate-300 mb-3">Admin email accounts ({accounts.length})</h2>
          <div className="divide-y divide-white/5">
            {accounts.length === 0 && <div className="text-sm text-slate-500 py-4">No accounts found in app_settings.email_accounts.</div>}
            {accounts.map((a) => (
              <div key={a.email} className="flex items-center justify-between py-3">
                <div>
                  <div className="text-sm font-medium">{a.email}</div>
                  <div className="text-xs text-slate-400">Label: {a.label} · Status: {a.session?.status || "idle"}</div>
                  {a.session?.last_error && <div className="text-xs text-red-300 mt-1">{a.session.last_error}</div>}
                </div>
                <button
                  onClick={() => trigger(a)}
                  disabled={loading || !workerReady}
                  className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 text-sm font-medium"
                >
                  Run login
                </button>
              </div>
            ))}
          </div>
        </section>

        {selectedEmail && (
          <section className="rounded-2xl border border-white/10 bg-black/40 p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold">Live logs · {selectedEmail}</h2>
              <span className="text-xs px-2 py-0.5 rounded bg-slate-800">{status || "—"}</span>
            </div>
            <div className="h-80 overflow-auto font-mono text-xs bg-black/60 rounded-lg p-3 space-y-1">
              {logs.length === 0 && <div className="text-slate-500">Waiting for logs…</div>}
              {logs.map((l, i) => (
                <div key={i} className={
                  l.level === "error" ? "text-red-300" :
                  l.level === "warn" ? "text-amber-300" :
                  "text-slate-300"
                }>
                  <span className="text-slate-500">{new Date(l.ts).toLocaleTimeString()}</span>{" "}[{l.level}] {l.message}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
