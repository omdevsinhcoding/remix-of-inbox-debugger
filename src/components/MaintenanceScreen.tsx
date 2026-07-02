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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<HTMLCanvasElement | null>(null);
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

  // Three.js aurora-over-onyx background
  useEffect(() => {
    const canvas = canvasRef.current;
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
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float noise(vec2 p){ vec2 i=floor(p), f=fract(p); float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1)); vec2 u=f*f*(3.0-2.0*f); return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y; }
        float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<6;i++){ v+=a*noise(p); p*=2.02; a*=0.5;} return v; }
        void main(){
          vec2 uv = gl_FragCoord.xy / uRes.xy;
          vec2 p = uv * vec2(uRes.x/uRes.y, 1.0);
          float t = uTime * 0.06;
          // base onyx
          vec3 col = mix(vec3(0.02,0.03,0.06), vec3(0.04,0.05,0.10), uv.y);
          // aurora ribbons
          float n1 = fbm(vec2(p.x*1.5, p.y*2.5 + t));
          float n2 = fbm(vec2(p.x*2.2 - t*0.8, p.y*3.0 + t*0.5));
          vec3 cobalt = vec3(0.10, 0.35, 0.95);
          vec3 teal   = vec3(0.20, 0.85, 0.85);
          vec3 violet = vec3(0.55, 0.25, 0.95);
          float ribbon = smoothstep(0.35, 0.85, n1) * smoothstep(0.30, 0.75, n2);
          col += cobalt * ribbon * 0.55;
          col += teal   * pow(ribbon, 2.0) * 0.45;
          col += violet * smoothstep(0.55, 0.95, n2) * 0.35;
          // platinum sweep
          float sweep = smoothstep(0.0, 0.08, sin(uv.x*3.14159 + t*3.0)*0.5+0.5) * 0.08;
          col += vec3(sweep);
          // cursor starlight
          float d = distance(uv, uMouse);
          col += vec3(0.55,0.75,1.0) * smoothstep(0.35, 0.0, d) * 0.15;
          // vignette
          float v = smoothstep(1.1, 0.35, distance(uv, vec2(0.5)));
          col *= mix(0.55, 1.05, v);
          // grain
          col += (hash(gl_FragCoord.xy + uTime) - 0.5) * 0.02;
          gl_FragColor = vec4(col, 1.0);
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

  // Drifting particles overlay
  useEffect(() => {
    const c = particlesRef.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    let raf = 0;
    const resize = () => { c.width = window.innerWidth; c.height = window.innerHeight; };
    resize(); window.addEventListener("resize", resize);
    const N = 70;
    const pts = Array.from({ length: N }, () => ({
      x: Math.random() * c.width, y: Math.random() * c.height,
      vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
      r: Math.random() * 1.6 + 0.4, a: Math.random() * 0.6 + 0.2,
    }));
    const tick = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = c.width; if (p.x > c.width) p.x = 0;
        if (p.y < 0) p.y = c.height; if (p.y > c.height) p.y = 0;
        ctx.beginPath();
        ctx.fillStyle = `rgba(210,230,255,${p.a})`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);

  const timeStr = useMemo(() => now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), [now]);

  return (
    <div className="fixed inset-0 z-[9999] overflow-hidden bg-black text-white font-sans">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={particlesRef} className="pointer-events-none absolute inset-0 h-full w-full opacity-80" />

      {/* Corner decorative SVGs */}
      <svg className="pointer-events-none absolute top-6 left-6 h-16 w-16 opacity-40" viewBox="0 0 100 100" fill="none">
        <path d="M2 2 L2 30 M2 2 L30 2" stroke="rgba(150,200,255,0.6)" strokeWidth="1.5"/>
        <circle cx="2" cy="2" r="3" fill="#60a5fa"/>
      </svg>
      <svg className="pointer-events-none absolute top-6 right-6 h-16 w-16 opacity-40" viewBox="0 0 100 100" fill="none">
        <path d="M98 2 L98 30 M98 2 L70 2" stroke="rgba(150,200,255,0.6)" strokeWidth="1.5"/>
        <circle cx="98" cy="2" r="3" fill="#60a5fa"/>
      </svg>
      <svg className="pointer-events-none absolute bottom-6 left-6 h-16 w-16 opacity-40" viewBox="0 0 100 100" fill="none">
        <path d="M2 98 L2 70 M2 98 L30 98" stroke="rgba(150,200,255,0.6)" strokeWidth="1.5"/>
      </svg>
      <svg className="pointer-events-none absolute bottom-6 right-6 h-16 w-16 opacity-40" viewBox="0 0 100 100" fill="none">
        <path d="M98 98 L98 70 M98 98 L70 98" stroke="rgba(150,200,255,0.6)" strokeWidth="1.5"/>
      </svg>

      {/* Floating orbital rings behind card */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <svg className="h-[560px] w-[560px] opacity-20 animate-spin-slow" viewBox="0 0 200 200" fill="none">
          <circle cx="100" cy="100" r="90" stroke="url(#g1)" strokeWidth="0.5" strokeDasharray="2 6"/>
          <circle cx="100" cy="100" r="70" stroke="url(#g1)" strokeWidth="0.5" strokeDasharray="1 4"/>
          <defs>
            <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#60a5fa"/>
              <stop offset="100%" stopColor="#a78bfa"/>
            </linearGradient>
          </defs>
        </svg>
      </div>

      {/* Content */}
      <div className="relative z-10 flex min-h-full items-center justify-center px-5 py-10">
        <div className="w-full max-w-2xl">
          {/* Brand */}
          <div className="mb-8 flex items-center justify-center gap-2">
            <span className="text-[#E50914] font-black text-3xl md:text-4xl tracking-wide"
                  style={{ fontFamily: "'Bebas Neue', Impact, sans-serif", letterSpacing: "0.06em", textShadow: "0 0 24px rgba(229,9,20,0.55)" }}>
              NETFLIX
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-white/25 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.35em] text-white/80 backdrop-blur-sm">
              <KeyRound className="h-3 w-3" /> OTP
            </span>
          </div>

          {/* Lottie hero */}
          <div className="mx-auto mb-6 flex h-48 w-48 items-center justify-center md:h-56 md:w-56">
            {lottieData ? (
              <Lottie animationData={lottieData} loop autoplay style={{ width: "100%", height: "100%" }} />
            ) : (
              <div className="relative h-32 w-32">
                <div className="absolute inset-0 rounded-full border-4 border-white/10" />
                <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-[#60a5fa] animate-spin" />
                <div className="absolute inset-3 rounded-full border-2 border-transparent border-b-[#a78bfa] animate-spin" style={{ animationDirection: "reverse", animationDuration: "1.6s" }} />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Mail className="h-8 w-8 text-white/80" />
                </div>
              </div>
            )}
          </div>

          {/* Card */}
          <div className="relative rounded-2xl border border-white/12 bg-white/[0.04] p-7 md:p-10 backdrop-blur-2xl shadow-[0_30px_120px_-20px_rgba(30,60,180,0.5)]">
            <div className="absolute inset-x-6 -top-px h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />

            <div className="flex items-center gap-2 mb-4">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-400" />
              </span>
              <span className="text-[11px] uppercase tracking-[0.35em] text-cyan-300 font-semibold">
                System Update · Maintenance
              </span>
            </div>

            <h1 className="text-3xl md:text-5xl font-black leading-tight tracking-tight text-white">
              {title || "We'll be right back."}
            </h1>
            <p className="mt-4 text-base md:text-lg text-white/70 leading-relaxed">
              {message || "OTP delivery is getting a quick tune-up. Your codes and inbox will be back online in a moment."}
            </p>

            {/* Feature chips */}
            <div className="mt-5 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80"><Shield className="h-3 w-3 text-emerald-300"/>Secure delivery</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80"><Mail className="h-3 w-3 text-cyan-300"/>Inbox sync</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80"><Sparkles className="h-3 w-3 text-violet-300"/>New features</span>
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
              <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-cyan-300 to-transparent" style={{ animation: "loader 2.2s ease-in-out infinite" }} />
            </div>

            {isAdmin && (
              <button
                onClick={onAdminBypass}
                className="mt-7 group inline-flex w-full items-center justify-center gap-2 rounded-lg bg-white text-black px-5 py-3 text-sm font-bold uppercase tracking-wider transition hover:bg-white/90 shadow-[0_10px_40px_-10px_rgba(255,255,255,0.5)]"
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
        @keyframes loader { 0%{transform:translateX(-100%)} 100%{transform:translateX(400%)} }
        @keyframes spin-slow { to { transform: rotate(360deg); } }
        .animate-spin-slow { animation: spin-slow 60s linear infinite; }
      `}</style>
    </div>
  );
}
