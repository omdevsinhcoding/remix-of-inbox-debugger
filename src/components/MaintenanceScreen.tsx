import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import Lottie from "lottie-react";
import { ArrowRight, Clock, KeyRound, Mail, Shield, Sparkles } from "lucide-react";

type Props = {
  title?: string;
  message?: string;
  eta?: string;
  isAdmin?: boolean;
  onAdminBypass?: () => void;
};

const LOTTIE_SOURCES = [
  "https://lottie.host/4d42d6b1-7f04-4a3b-9a4e-7f83aab7a3e3/2sVJ4C9tXH.json",
  "https://assets2.lottiefiles.com/packages/lf20_x62chJ.json",
];

export default function MaintenanceScreen({ title, message, eta, isAdmin, onAdminBypass }: Props) {
  const waterRef = useRef<HTMLCanvasElement | null>(null);
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
          const r = await fetch(url, { cache: "force-cache" });
          if (!r.ok) continue;
          const j = await r.json();
          if (!cancelled) { setLottieData(j); return; }
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Three.js "water ripple" shader over black/red palette
  useEffect(() => {
    const canvas = waterRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const uniforms = {
      uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `void main(){ gl_Position = vec4(position,1.0); }`,
      fragmentShader: `
        precision highp float;
        uniform float uTime; uniform vec2 uRes; uniform vec2 uMouse;

        // Concentric water ripples with domain warping
        float ripple(vec2 uv, vec2 c, float t, float speed){
          float d = distance(uv, c);
          return sin(d * 42.0 - t * speed) / (1.0 + d * 18.0);
        }

        void main(){
          vec2 uv = gl_FragCoord.xy / uRes.xy;
          vec2 asp = vec2(uRes.x/uRes.y, 1.0);
          vec2 p = uv * asp;

          float t = uTime;

          // Layered ripples from multiple emitters
          float r = 0.0;
          r += ripple(p, vec2(0.50 * asp.x, 0.50), t, 2.2);
          r += ripple(p, vec2(0.20 * asp.x, 0.30), t, 1.6) * 0.7;
          r += ripple(p, vec2(0.85 * asp.x, 0.75), t, 1.9) * 0.8;
          r += ripple(p, vec2(uMouse.x * asp.x, uMouse.y), t, 2.8) * 1.1;

          // Soft caustic highlights
          float caustic = smoothstep(0.15, 0.9, 0.5 + r * 0.6);

          // Base: deep black -> crimson vignette
          vec3 base = mix(vec3(0.00, 0.00, 0.00), vec3(0.06, 0.005, 0.02), uv.y);

          // Red radial glow around center-top
          float g1 = smoothstep(0.9, 0.0, distance(uv, vec2(0.5, 0.15)));
          base += vec3(0.90, 0.03, 0.08) * g1 * 0.55;

          // Secondary glow bottom-left
          float g2 = smoothstep(0.7, 0.0, distance(uv, vec2(0.1, 1.05)));
          base += vec3(0.70, 0.02, 0.06) * g2 * 0.35;

          // Ripple highlights tinted red/white
          base += vec3(1.0, 0.15, 0.20) * caustic * 0.35;
          base += vec3(1.0) * pow(caustic, 6.0) * 0.25;

          // Cursor starlight
          float m = smoothstep(0.35, 0.0, distance(uv, uMouse));
          base += vec3(1.0, 0.2, 0.25) * m * 0.25;

          // Vignette
          float v = smoothstep(1.15, 0.35, distance(uv, vec2(0.5)));
          base *= mix(0.45, 1.05, v);

          // Grain
          float n = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898,78.233))) * 43758.5453);
          base += (n - 0.5) * 0.025;

          gl_FragColor = vec4(base, 1.0);
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    scene.add(mesh);

    const resize = () => {
      const w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h, false);
      uniforms.uRes.value.set(w, h);
    };
    resize();
    window.addEventListener("resize", resize);
    const onMove = (e: MouseEvent) => uniforms.uMouse.value.set(e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight);
    window.addEventListener("mousemove", onMove);

    let raf = 0;
    const start = performance.now();
    const loop = () => {
      uniforms.uTime.value = (performance.now() - start) / 1000;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      material.dispose(); mesh.geometry.dispose(); renderer.dispose();
    };
  }, []);

  const timeStr = useMemo(() => now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), [now]);

  return (
    <div className="fixed inset-0 z-[9999] overflow-hidden bg-black text-white font-sans">
      {/* Water-ripple red shader */}
      <canvas ref={waterRef} className="absolute inset-0 h-full w-full" />

      {/* Soft red radial CSS glows layered on top */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[900px] w-[900px] -translate-x-1/2 rounded-full opacity-60 blur-3xl animate-pulse-slow"
           style={{ background: "radial-gradient(circle, rgba(229,9,20,0.55) 0%, rgba(229,9,20,0.12) 35%, transparent 70%)" }} />
      <div className="pointer-events-none absolute -bottom-40 -right-40 h-[600px] w-[600px] rounded-full opacity-40 blur-3xl"
           style={{ background: "radial-gradient(circle, rgba(180,0,15,0.4) 0%, transparent 70%)" }} />

      {/* Ghost Netflix "N" watermark */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="select-none font-black leading-none tracking-tighter text-[38vw] md:text-[26vw]"
              style={{
                background: "linear-gradient(180deg, rgba(229,9,20,0.20) 0%, rgba(229,9,20,0.04) 60%, transparent 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                filter: "drop-shadow(0 0 60px rgba(229,9,20,0.45))",
                animation: "ncore 6s ease-in-out infinite",
              }}>N</span>
      </div>

      {/* Scanline sweep */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-x-0 h-[2px] opacity-60"
             style={{ background: "linear-gradient(90deg, transparent, rgba(229,9,20,0.9), transparent)", animation: "sweep 7s linear infinite" }} />
      </div>

      {/* Corner brackets */}
      <svg className="pointer-events-none absolute top-6 left-6 h-16 w-16 opacity-50" viewBox="0 0 100 100" fill="none">
        <path d="M2 2 L2 30 M2 2 L30 2" stroke="rgba(229,9,20,0.8)" strokeWidth="1.5"/>
        <circle cx="2" cy="2" r="3" fill="#E50914"/>
      </svg>
      <svg className="pointer-events-none absolute top-6 right-6 h-16 w-16 opacity-50" viewBox="0 0 100 100" fill="none">
        <path d="M98 2 L98 30 M98 2 L70 2" stroke="rgba(229,9,20,0.8)" strokeWidth="1.5"/>
        <circle cx="98" cy="2" r="3" fill="#E50914"/>
      </svg>
      <svg className="pointer-events-none absolute bottom-6 left-6 h-16 w-16 opacity-50" viewBox="0 0 100 100" fill="none">
        <path d="M2 98 L2 70 M2 98 L30 98" stroke="rgba(229,9,20,0.8)" strokeWidth="1.5"/>
      </svg>
      <svg className="pointer-events-none absolute bottom-6 right-6 h-16 w-16 opacity-50" viewBox="0 0 100 100" fill="none">
        <path d="M98 98 L98 70 M98 98 L70 98" stroke="rgba(229,9,20,0.8)" strokeWidth="1.5"/>
      </svg>

      {/* Orbital ring behind card */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <svg className="h-[560px] w-[560px] opacity-25 animate-spin-slow" viewBox="0 0 200 200" fill="none">
          <circle cx="100" cy="100" r="90" stroke="url(#rg1)" strokeWidth="0.5" strokeDasharray="2 6"/>
          <circle cx="100" cy="100" r="70" stroke="url(#rg1)" strokeWidth="0.5" strokeDasharray="1 4"/>
          <defs>
            <linearGradient id="rg1" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#E50914"/>
              <stop offset="100%" stopColor="#ff5560"/>
            </linearGradient>
          </defs>
        </svg>
      </div>

      {/* Content */}
      <div className="relative z-10 flex min-h-full items-center justify-center px-5 py-10">
        <div className="w-full max-w-2xl">
          {/* Brand */}
          <div className="mb-8 flex items-center justify-center gap-2">
            <span className="text-[#E50914] font-black text-3xl md:text-4xl"
                  style={{ fontFamily: "'Bebas Neue', Impact, sans-serif", letterSpacing: "0.06em", textShadow: "0 0 24px rgba(229,9,20,0.6)" }}>
              NETFLIX
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-[#E50914]/50 bg-[#E50914]/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.35em] text-white/90 backdrop-blur-sm">
              <KeyRound className="h-3 w-3" /> OTP
            </span>
          </div>

          {/* Lottie hero */}
          <div className="mx-auto mb-6 flex h-48 w-48 items-center justify-center md:h-56 md:w-56">
            {lottieData ? (
              <Lottie animationData={lottieData} loop autoplay style={{ width: "100%", height: "100%" }} />
            ) : (
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
          <div className="relative rounded-2xl border border-white/10 bg-black/60 p-7 md:p-10 backdrop-blur-xl shadow-[0_30px_120px_-20px_rgba(229,9,20,0.4)]">
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
              {message || "OTP delivery is getting a quick tune-up. Your codes and inbox will be back online in a moment."}
            </p>

            <div className="mt-5 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80"><Shield className="h-3 w-3 text-emerald-300"/>Secure delivery</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80"><Mail className="h-3 w-3 text-[#ff6b73]"/>Inbox sync</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80"><Sparkles className="h-3 w-3 text-amber-300"/>New features</span>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-widest text-white/40">Local Time</div>
                <div className="mt-0.5 font-mono text-white/90">{timeStr}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-widest text-white/40 flex items-center gap-1"><Clock className="h-3 w-3"/> Back By</div>
                <div className="mt-0.5 font-mono text-white/90 truncate">{eta || "Very soon"}</div>
              </div>
            </div>

            <div className="mt-6 h-1 w-full overflow-hidden rounded-full bg-white/5">
              <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-[#E50914] to-transparent"
                   style={{ animation: "loader 2.2s ease-in-out infinite" }} />
            </div>

            {isAdmin && (
              <button
                onClick={onAdminBypass}
                className="mt-7 group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#E50914] px-5 py-3 text-sm font-bold uppercase tracking-wider text-white transition hover:bg-[#f6121d] shadow-[0_10px_40px_-10px_rgba(229,9,20,0.9)]"
              >
                Enter as Admin <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            )}
          </div>

          <div className="mt-6 text-center text-[11px] uppercase tracking-[0.3em] text-white/30">
            © Netflix OTP · System Update in Progress
          </div>
        </div>
      </div>

      <style>{`
        @keyframes sweep { 0%{top:-10%} 100%{top:110%} }
        @keyframes loader { 0%{transform:translateX(-100%)} 100%{transform:translateX(400%)} }
        @keyframes ncore { 0%,100%{opacity:.55; transform:scale(1)} 50%{opacity:.9; transform:scale(1.03)} }
        @keyframes pulse-slow { 0%,100%{opacity:.5} 50%{opacity:.8} }
        @keyframes spin-slow { to { transform: rotate(360deg); } }
        .animate-pulse-slow { animation: pulse-slow 4s ease-in-out infinite; }
        .animate-spin-slow { animation: spin-slow 60s linear infinite; }
      `}</style>
    </div>
  );
}
