import { useEffect, useMemo, useState } from "react";
import Lottie from "lottie-react";
import { ArrowRight, Clock } from "lucide-react";

type Props = {
  title?: string;
  message?: string;
  eta?: string;
  isAdmin?: boolean;
  onAdminBypass?: () => void;
};

// Netflix-inspired maintenance screen
// - Deep black backdrop with animated red radial glow (Netflix signature red #E50914)
// - Giant Netflix "N" ribbon logo pulsing in the background
// - Lottie animation (fetched at runtime with graceful fallback)
// - Editorial "Coming Soon" copy card
const LOTTIE_SOURCES = [
  // A "gears / maintenance" style lottie, red palette. Fetched at runtime.
  "https://lottie.host/4d42d6b1-7f04-4a3b-9a4e-7f83aab7a3e3/2sVJ4C9tXH.json",
  "https://assets2.lottiefiles.com/packages/lf20_x62chJ.json",
];

export default function MaintenanceScreen({ title, message, eta, isAdmin, onAdminBypass }: Props) {
  const [now, setNow] = useState<Date>(new Date());
  const [lottieData, setLottieData] = useState<any | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const url of LOTTIE_SOURCES) {
        try {
          const res = await fetch(url, { cache: "force-cache" });
          if (!res.ok) continue;
          const json = await res.json();
          if (!cancelled) { setLottieData(json); return; }
        } catch { /* try next */ }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const timeStr = useMemo(
    () => now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    [now]
  );

  return (
    <div className="fixed inset-0 z-[9999] overflow-hidden bg-black text-white font-sans">
      {/* Background: pure black + animated red radial glows */}
      <div className="absolute inset-0 bg-black" />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[900px] w-[900px] -translate-x-1/2 rounded-full opacity-70 blur-3xl animate-pulse-slow"
           style={{ background: "radial-gradient(circle, rgba(229,9,20,0.55) 0%, rgba(229,9,20,0.15) 35%, transparent 70%)" }} />
      <div className="pointer-events-none absolute -bottom-60 -left-40 h-[700px] w-[700px] rounded-full opacity-50 blur-3xl"
           style={{ background: "radial-gradient(circle, rgba(229,9,20,0.35) 0%, transparent 70%)", animation: "float-a 12s ease-in-out infinite" }} />
      <div className="pointer-events-none absolute -bottom-40 -right-40 h-[600px] w-[600px] rounded-full opacity-40 blur-3xl"
           style={{ background: "radial-gradient(circle, rgba(180,0,15,0.4) 0%, transparent 70%)", animation: "float-b 14s ease-in-out infinite" }} />

      {/* Subtle film grain */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.06] mix-blend-overlay"
           style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.5'/></svg>\")" }} />

      {/* Ghost Netflix "N" watermark */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="select-none font-black leading-none tracking-tighter text-[38vw] md:text-[26vw]"
              style={{
                background: "linear-gradient(180deg, rgba(229,9,20,0.18) 0%, rgba(229,9,20,0.04) 60%, transparent 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                filter: "drop-shadow(0 0 60px rgba(229,9,20,0.35))",
                animation: "ncore 6s ease-in-out infinite",
              }}>N</span>
      </div>

      {/* Scanline sweep */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-x-0 h-[2px] opacity-60"
             style={{ background: "linear-gradient(90deg, transparent, rgba(229,9,20,0.9), transparent)", animation: "sweep 7s linear infinite" }} />
      </div>

      {/* Content */}
      <div className="relative z-10 flex min-h-full items-center justify-center px-5 py-10">
        <div className="w-full max-w-2xl">
          {/* Top bar: NETFLIX-style wordmark */}
          <div className="mb-8 flex items-center justify-center">
            <div className="flex items-baseline gap-1">
              <span className="text-[#E50914] font-black tracking-[0.02em] text-3xl md:text-4xl"
                    style={{ fontFamily: "'Bebas Neue', 'Impact', system-ui, sans-serif", letterSpacing: "0.04em", textShadow: "0 0 24px rgba(229,9,20,0.55)" }}>
                NETFLIX
              </span>
              <span className="text-white/40 text-xs uppercase tracking-[0.35em] ml-2">Mirror</span>
            </div>
          </div>

          {/* Lottie */}
          <div className="mx-auto mb-6 flex h-48 w-48 items-center justify-center md:h-56 md:w-56">
            {lottieData ? (
              <Lottie animationData={lottieData} loop autoplay style={{ width: "100%", height: "100%" }} />
            ) : (
              // Fallback: animated red ring loader
              <div className="relative h-32 w-32">
                <div className="absolute inset-0 rounded-full border-4 border-[#E50914]/20" />
                <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-[#E50914] animate-spin" />
                <div className="absolute inset-3 rounded-full border-2 border-transparent border-b-[#E50914]/70 animate-spin"
                     style={{ animationDirection: "reverse", animationDuration: "1.6s" }} />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[#E50914] text-4xl font-black" style={{ fontFamily: "'Bebas Neue', Impact, sans-serif" }}>N</span>
                </div>
              </div>
            )}
          </div>

          {/* Card */}
          <div className="relative rounded-2xl border border-white/10 bg-black/60 p-7 md:p-10 backdrop-blur-xl shadow-[0_30px_120px_-20px_rgba(229,9,20,0.35)]">
            <div className="absolute inset-x-6 -top-px h-px bg-gradient-to-r from-transparent via-[#E50914]/70 to-transparent" />

            <div className="flex items-center gap-2 mb-4">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#E50914] opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#E50914]" />
              </span>
              <span className="text-[11px] uppercase tracking-[0.35em] text-[#E50914] font-semibold">
                Now Playing · Maintenance
              </span>
            </div>

            <h1 className="text-3xl md:text-5xl font-black leading-tight tracking-tight text-white">
              {title || "We'll be right back."}
            </h1>
            <p className="mt-4 text-base md:text-lg text-white/70 leading-relaxed">
              {message || "The show is getting a quick upgrade. Grab some popcorn — we're rolling credits on the update and streaming back shortly."}
            </p>

            {/* Meta row */}
            <div className="mt-6 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-widest text-white/40">Local Time</div>
                <div className="mt-0.5 font-mono text-white/90">{timeStr}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-widest text-white/40 flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Back By
                </div>
                <div className="mt-0.5 font-mono text-white/90 truncate">{eta || "Very soon"}</div>
              </div>
            </div>

            {/* Progress bar (indeterminate) */}
            <div className="mt-6 h-1 w-full overflow-hidden rounded-full bg-white/5">
              <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-[#E50914] to-transparent"
                   style={{ animation: "loader 2.2s ease-in-out infinite" }} />
            </div>

            {isAdmin && (
              <button
                onClick={onAdminBypass}
                className="mt-7 group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#E50914] px-5 py-3 text-sm font-bold uppercase tracking-wider text-white transition hover:bg-[#f6121d] shadow-[0_10px_40px_-10px_rgba(229,9,20,0.9)]"
              >
                Enter as Admin
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            )}
          </div>

          <div className="mt-6 text-center text-[11px] uppercase tracking-[0.3em] text-white/30">
            © Netflix Mirror · Season Update in Progress
          </div>
        </div>
      </div>

      <style>{`
        @keyframes float-a { 0%,100%{transform:translate(0,0)} 50%{transform:translate(40px,-30px)} }
        @keyframes float-b { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-30px,20px)} }
        @keyframes sweep { 0%{top:-10%} 100%{top:110%} }
        @keyframes loader { 0%{transform:translateX(-100%)} 100%{transform:translateX(400%)} }
        @keyframes ncore { 0%,100%{opacity:.55; transform:scale(1)} 50%{opacity:.9; transform:scale(1.03)} }
        @keyframes pulse-slow { 0%,100%{opacity:.55} 50%{opacity:.85} }
        .animate-pulse-slow { animation: pulse-slow 4s ease-in-out infinite; }
      `}</style>
    </div>
  );
}
