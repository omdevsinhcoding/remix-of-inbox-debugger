import { useEffect, useState } from "react";
import type { SyncState } from "../lib/adminSettingsCache";

// Compact dark pill that mirrors the SessionCountdown look. Pinned to the
// bottom-LEFT so it never overlaps the session countdown (bottom-right) or
// any toast stack. Auto-hides shortly after "saved".
export function AdminSyncStatus() {
  const [state, setState] = useState<SyncState>({ kind: "idle" });

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SyncState>).detail;
      if (!detail) return;
      setState(detail);
      if (detail.kind === "saved") {
        window.setTimeout(() => setState({ kind: "idle" }), 1600);
      }
    };
    window.addEventListener("admin-sync-status", handler as EventListener);
    return () => window.removeEventListener("admin-sync-status", handler as EventListener);
  }, []);

  if (state.kind === "idle") return null;

  const labels: Record<SyncState["kind"], string> = {
    idle: "",
    "loading-local": "Loading cache",
    "syncing-server": "Syncing",
    saved: "Saved",
    "stale-refetching": "Refetching",
    error: state.kind === "error" ? state.message : "Error",
  };
  const label = labels[state.kind];
  const spinning =
    state.kind === "loading-local" ||
    state.kind === "syncing-server" ||
    state.kind === "stale-refetching";

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed z-40 left-3 sm:left-4 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:bottom-4 h-7 sm:h-8 px-3 sm:px-3.5 rounded-full text-[11px] sm:text-xs font-semibold shadow-lg backdrop-blur bg-slate-900/90 text-white flex items-center gap-1.5 select-none pointer-events-none"
      style={{ maxWidth: 260 }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full bg-current"
        style={{
          opacity: spinning ? 0.5 : 0.9,
          animation: spinning ? "adminSyncPulse 1.2s ease-in-out infinite" : "none",
        }}
      />
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        Sync: {label}
      </span>
      <style>{`@keyframes adminSyncPulse { 0%,100%{opacity:.35} 50%{opacity:1} }`}</style>
    </div>
  );
}
