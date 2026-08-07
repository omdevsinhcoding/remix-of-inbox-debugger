import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import { Code2, ArrowLeft, ExternalLink, Sparkles } from "lucide-react";
import { getDeveloperLinks, getDeveloperButtonLabel, type DeveloperLink } from "../lib/bootstrap";

/**
 * Reads the admin-configured developer links synchronously from the bootstrap
 * cache so the header pill paints on the very first frame, then re-renders when
 * the network bootstrap lands (`app:developer-links`).
 */
export function useDeveloperLinks(): { links: DeveloperLink[]; label: string } {
  const [state, setState] = useState(() => ({ links: getDeveloperLinks(), label: getDeveloperButtonLabel() }));
  useEffect(() => {
    const sync = () => setState({ links: getDeveloperLinks(), label: getDeveloperButtonLabel() });
    sync();
    window.addEventListener("app:developer-links", sync);
    return () => window.removeEventListener("app:developer-links", sync);
  }, []);
  return state;
}

function openExternal(url: string) {
  try {
    const w = window.open(url, "_blank", "noopener,noreferrer");
    if (!w) window.location.href = url;
  } catch {
    window.location.href = url;
  }
}

/**
 * Header "Developer" pill — Netflix-dark glass with an animated sheen sweep.
 * One configured link opens directly; two or more route to /developers.
 */
export function DeveloperPill({ className = "" }: { className?: string }) {
  const navigate = useNavigate();
  const { links, label } = useDeveloperLinks();

  const onClick = useCallback(() => {
    if (links.length === 1) openExternal(links[0].url);
    else navigate("/developers", { state: { from: window.location.pathname + window.location.search } });
  }, [links, navigate]);

  if (!links.length) return null;

  return (
    <motion.button
      type="button"
      onClick={onClick}
      initial={{ opacity: 0, y: -6, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.35, ease: "easeOut", delay: 0.08 }}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.96 }}
      aria-label={links.length > 1 ? "View developers" : `Open ${label}`}
      className={`group relative inline-flex items-center gap-1.5 rounded-full pl-2 pr-3 py-[5px] sm:py-[6px] text-[10px] sm:text-[11px] font-extrabold tracking-[0.16em] uppercase whitespace-nowrap overflow-hidden ${className}`}
      style={{
        background: "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0) 62%), #0b0b0b",
        border: "1px solid rgba(229,9,20,0.5)",
        color: "#ffe6e8",
        boxShadow: "0 0 0 1px rgba(0,0,0,0.6), 0 8px 22px -10px rgba(229,9,20,0.7), inset 0 0 14px rgba(229,9,20,0.14)",
      }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-[900ms] ease-out"
        style={{ background: "linear-gradient(105deg, transparent 35%, rgba(255,255,255,0.22) 50%, transparent 65%)" }}
      />
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full opacity-60 animate-pulse"
        style={{ boxShadow: "inset 0 0 18px rgba(229,9,20,0.22)" }}
      />
      <Code2 className="relative w-3 h-3 sm:w-3.5 sm:h-3.5 text-[#e50914]" style={{ filter: "drop-shadow(0 0 6px rgba(229,9,20,0.8))" }} />
      <span className="relative">{label || "Developer"}</span>
      {links.length > 1 && (
        <span className="relative ml-0.5 rounded-full bg-[#e50914]/20 border border-[#e50914]/40 px-1.5 text-[9px] leading-[14px] tracking-normal">
          {links.length}
        </span>
      )}
    </motion.button>
  );
}

/** Dedicated showcase page used when the admin configured 2+ developer links. */
export default function DevelopersPage() {
  const navigate = useNavigate();
  const { links, label } = useDeveloperLinks();

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Developers — Netflix Mail";
    return () => { document.title = prevTitle; };
  }, []);

  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen bg-[#141414] text-white px-4 py-8 sm:py-12 relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-40 h-[420px] blur-3xl opacity-70"
        style={{ background: "radial-gradient(circle at 50% 40%, rgba(229,9,20,0.28), transparent 60%)" }}
      />
      <div className="relative max-w-3xl mx-auto">
        <button
          type="button"
          onClick={goBack}
          className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-3.5 py-2 text-xs font-bold text-slate-200 hover:bg-white/[0.09] hover:border-white/25 active:scale-95 transition"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="mt-6 sm:mt-8"
        >
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e50914]/45 bg-[#e50914]/10 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.22em] text-[#ffd9dc]">
            <Sparkles className="w-3 h-3" /> {label || "Developer"}
          </span>
          <h1 className="mt-3 text-2xl sm:text-4xl font-black tracking-tight">Meet the developers</h1>
          <p className="mt-2 text-sm sm:text-base text-slate-400 max-w-xl">
            Official channels behind this project. Pick a profile to open it in a new tab.
          </p>
        </motion.div>

        {links.length === 0 ? (
          <div className="mt-10 rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-sm text-slate-400">
            No developer links published yet.
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <AnimatePresence initial={true}>
              {links.map((link, i) => (
                <motion.button
                  key={link.id || link.url}
                  type="button"
                  onClick={() => openExternal(link.url)}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: "easeOut", delay: 0.05 + i * 0.05 }}
                  whileHover={{ y: -3 }}
                  whileTap={{ scale: 0.98 }}
                  className="group relative text-left rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-4 sm:p-5 overflow-hidden hover:border-[#e50914]/50 transition-colors"
                >
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full opacity-0 group-hover:opacity-100 blur-2xl transition-opacity"
                    style={{ background: "radial-gradient(circle, rgba(229,9,20,0.45), transparent 65%)" }}
                  />
                  <div className="relative flex items-center gap-3">
                    {link.avatar ? (
                      <img src={link.avatar} alt={`${link.label} avatar`} loading="lazy"
                        className="w-11 h-11 rounded-xl object-cover border border-white/15" />
                    ) : (
                      <div className="w-11 h-11 rounded-xl grid place-items-center bg-gradient-to-br from-[#e50914] to-[#7f0a10] text-white font-black">
                        {(link.label || "D").trim().charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="font-bold truncate">{link.label}</p>
                      {link.role ? <p className="text-[11px] uppercase tracking-wider text-[#ff9ba2] font-bold truncate">{link.role}</p> : null}
                    </div>
                    <ExternalLink className="w-4 h-4 ml-auto text-slate-500 group-hover:text-white transition-colors" />
                  </div>
                  {link.description ? (
                    <p className="relative mt-3 text-xs sm:text-sm text-slate-400 line-clamp-3">{link.description}</p>
                  ) : null}
                  <p className="relative mt-2 text-[11px] text-slate-500 truncate">{link.url.replace(/^https?:\/\//, "")}</p>
                </motion.button>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
