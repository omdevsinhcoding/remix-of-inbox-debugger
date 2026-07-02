import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { ArrowRight, Coffee, Wrench, Cog, Sparkles, Hammer } from "lucide-react";

type Props = {
  title?: string;
  message?: string;
  eta?: string;
  isAdmin?: boolean;
  onAdminBypass?: () => void;
};

/**
 * Premium + playful maintenance screen.
 * Background: Three.js flowing gradient shader + drifting particles.
 * Foreground: interactive glass card with mini "workshop" creatures,
 * a mini tap-the-bolt game, and mobile-first responsive layout.
 */
export default function MaintenanceScreen({ title, message, eta, isAdmin, onAdminBypass }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<HTMLCanvasElement | null>(null);
  const [now, setNow] = useState<Date>(new Date());
  const [bolts, setBolts] = useState(0);
  const [pop, setPop] = useState<{ id: number; x: number; y: number }[]>([]);
  const [mood, setMood] = useState<"idle" | "wave" | "wink">("idle");

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    const m = setInterval(() => setMood(Math.random() > 0.5 ? "wave" : "wink"), 4200);
    const reset = setInterval(() => setMood("idle"), 4600);
    return () => { clearInterval(id); clearInterval(m); clearInterval(reset); };
  }, []);

  // Three.js flowing gradient background
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const uniforms = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform float uTime;
        uniform vec2 uResolution;
        uniform vec2 uMouse;
        vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
        vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
        vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
        float snoise(vec2 v){
          const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
          vec2 i=floor(v+dot(v,C.yy));
          vec2 x0=v-i+dot(i,C.xx);
          vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
          vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1;
          i=mod289(i);
          vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
          vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
          m=m*m; m=m*m;
          vec3 x=2.0*fract(p*C.www)-1.0;
          vec3 h=abs(x)-0.5;
          vec3 ox=floor(x+0.5);
          vec3 a0=x-ox;
          m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
          vec3 g;
          g.x=a0.x*x0.x+h.x*x0.y;
          g.yz=a0.yz*x12.xz+h.yz*x12.yw;
          return 130.0*dot(m,g);
        }
        float fbm(vec2 p){ float v=0.0; float a=0.5; for(int i=0;i<5;i++){ v+=a*snoise(p); p*=2.02; a*=0.5;} return v; }
        void main(){
          vec2 uv=vUv;
          vec2 p=(uv-0.5)*vec2(uResolution.x/uResolution.y,1.0);
          float t=uTime*0.08;
          vec2 q=vec2(fbm(p*1.6+t), fbm(p*1.6-t+3.7));
          float n=fbm(p*2.2+q*1.4+t*0.9);
          vec3 c1=vec3(0.035,0.031,0.055);
          vec3 c2=vec3(0.16,0.08,0.28);
          vec3 c3=vec3(0.92,0.32,0.45);
          vec3 c4=vec3(1.0,0.78,0.42);
          vec3 col=mix(c1,c2, smoothstep(-0.6,0.4,n));
          col=mix(col,c3, smoothstep(0.15,0.75,n)*0.55);
          col=mix(col,c4, smoothstep(0.55,0.95,n)*0.28);
          float d=distance(uv,uMouse);
          col+=vec3(0.9,0.5,0.35)*smoothstep(0.35,0.0,d)*0.10;
          float vig=smoothstep(1.15,0.35,length(p));
          col*=mix(0.55,1.0,vig);
          float grain=fract(sin(dot(uv*uResolution,vec2(12.9898,78.233)))*43758.5453);
          col+=(grain-0.5)*0.025;
          gl_FragColor=vec4(col,1.0);
        }
      `,
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    scene.add(mesh);

    const resize = () => {
      const w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h, false);
      uniforms.uResolution.value.set(w, h);
    };
    resize();
    window.addEventListener("resize", resize);
    const onMove = (e: PointerEvent) => {
      uniforms.uMouse.value.set(e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight);
    };
    window.addEventListener("pointermove", onMove, { passive: true });

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
      window.removeEventListener("pointermove", onMove);
      material.dispose(); mesh.geometry.dispose(); renderer.dispose();
    };
  }, []);

  // Drifting particles overlay
  useEffect(() => {
    const c = particlesRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const parts = Array.from({ length: 50 }, () => ({
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00015,
      vy: -0.00008 - Math.random() * 0.00025,
      r: 0.5 + Math.random() * 1.6,
      a: 0.15 + Math.random() * 0.55,
    }));
    const resize = () => {
      c.width = window.innerWidth * Math.min(window.devicePixelRatio, 2);
      c.height = window.innerHeight * Math.min(window.devicePixelRatio, 2);
    };
    resize();
    window.addEventListener("resize", resize);
    let raf = 0;
    const loop = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy;
        if (p.y < -0.02) { p.y = 1.02; p.x = Math.random(); }
        if (p.x < -0.02) p.x = 1.02;
        if (p.x > 1.02) p.x = -0.02;
        const g = ctx.createRadialGradient(p.x * c.width, p.y * c.height, 0, p.x * c.width, p.y * c.height, p.r * 6);
        g.addColorStop(0, `rgba(255,220,180,${p.a})`);
        g.addColorStop(1, "rgba(255,220,180,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x * c.width, p.y * c.height, p.r * 6, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);

  const displayTitle = title?.trim() || "We're tuning the projector";
  const displayMessage =
    message?.trim() ||
    "Our tiny crew is oiling the reels and polishing the pixels. Grab a snack — the show returns in a moment.";

  const tapBolt = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const id = Date.now() + Math.random();
    setPop((p) => [...p, { id, x, y }]);
    setBolts((b) => b + 1);
    setTimeout(() => setPop((p) => p.filter((it) => it.id !== id)), 900);
  };

  return (
    <div className="fixed inset-0 z-[9999] overflow-hidden bg-black text-white">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={particlesRef} className="absolute inset-0 w-full h-full pointer-events-none mix-blend-screen" />

      {/* Top brand strip */}
      <div className="absolute top-0 inset-x-0 flex items-center justify-between px-4 sm:px-10 py-4 sm:py-5 z-10">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-white text-lg" style={{ background: "linear-gradient(135deg,#e50914,#7a0910)", boxShadow: "0 0 24px rgba(229,9,20,0.55)" }}>N</div>
          <span className="text-[10px] sm:text-[11px] tracking-[0.28em] sm:tracking-[0.32em] uppercase text-white/60 font-medium">Netflix ID Manager</span>
        </div>
        <div className="flex items-center gap-2 text-white/60 text-[11px] font-mono tabular-nums">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span>{now.toLocaleTimeString()}</span>
        </div>
      </div>

      {/* Center content */}
      <div className="relative z-10 h-full flex items-center justify-center px-4 sm:px-5 py-20 sm:py-16 overflow-y-auto">
        <div
          className="w-full max-w-[680px] rounded-[28px] px-5 sm:px-10 py-7 sm:py-10 backdrop-blur-2xl border animate-fade-in"
          style={{
            background: "linear-gradient(180deg, rgba(20,14,26,0.62) 0%, rgba(10,8,14,0.75) 100%)",
            borderColor: "rgba(255,255,255,0.08)",
            boxShadow: "0 40px 120px -20px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.06)",
          }}
        >
          {/* Playful workshop scene */}
          <div className="relative h-[150px] sm:h-[180px] mb-5 sm:mb-7 rounded-2xl overflow-hidden border border-white/[0.06]" style={{ background: "radial-gradient(ellipse at 50% 100%, rgba(229,9,20,0.18), transparent 60%), linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.25))" }}>
            {/* floor line */}
            <div className="absolute bottom-6 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

            {/* big spinning cogs */}
            <Cog className="absolute -left-4 -top-4 w-20 h-20 text-white/[0.06]" style={{ animation: "maint-spin 12s linear infinite" }} />
            <Cog className="absolute -right-6 top-6 w-28 h-28 text-white/[0.05]" style={{ animation: "maint-spin-r 18s linear infinite" }} />
            <Cog className="absolute left-1/3 -bottom-6 w-24 h-24 text-white/[0.04]" style={{ animation: "maint-spin 22s linear infinite" }} />

            {/* Mini creature: robot mascot */}
            <div className="absolute left-6 bottom-6" style={{ animation: "maint-hop 2.6s ease-in-out infinite" }}>
              <div className="relative w-14 h-16">
                {/* antenna */}
                <div className="absolute left-1/2 -translate-x-1/2 -top-3 w-0.5 h-3 bg-amber-300/70" />
                <div className="absolute left-1/2 -translate-x-1/2 -top-4 w-2 h-2 rounded-full bg-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.9)] animate-pulse" />
                {/* head */}
                <div className="absolute inset-x-0 top-0 h-9 rounded-xl border border-white/15" style={{ background: "linear-gradient(180deg,#2a1f3a,#140c1e)" }}>
                  {/* eyes */}
                  <div className="absolute inset-0 flex items-center justify-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.9)] ${mood === "wink" ? "scale-y-[0.15]" : ""}`} style={{ transition: "transform 0.2s" }} />
                    <span className="w-2 h-2 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.9)]" />
                  </div>
                </div>
                {/* body */}
                <div className="absolute inset-x-1 top-9 h-6 rounded-md border border-white/10" style={{ background: "linear-gradient(180deg,#3a2450,#1a1028)" }}>
                  <div className="absolute inset-x-2 top-1 h-1 rounded-full bg-white/10 overflow-hidden">
                    <div className="h-full w-1/3 bg-emerald-400/80" style={{ animation: "maint-shimmer 2.2s linear infinite" }} />
                  </div>
                </div>
                {/* waving arm */}
                <div className="absolute -right-3 top-9 w-4 h-1.5 bg-white/25 rounded origin-left" style={{ transform: mood === "wave" ? "rotate(-45deg)" : "rotate(-10deg)", transition: "transform 0.35s ease" }} />
              </div>
            </div>

            {/* Mini creature: worker with hammer */}
            <div className="absolute right-8 bottom-6" style={{ animation: "maint-bob 3.1s ease-in-out infinite" }}>
              <div className="relative w-12 h-16">
                {/* hardhat */}
                <div className="absolute left-1/2 -translate-x-1/2 top-0 w-8 h-3 rounded-t-full bg-amber-400" />
                <div className="absolute left-1/2 -translate-x-1/2 top-2 w-9 h-1 bg-amber-500" />
                {/* face */}
                <div className="absolute left-1/2 -translate-x-1/2 top-3 w-7 h-6 rounded-md bg-[#f2c9a4]">
                  <div className="absolute top-2 left-1.5 w-1 h-1 rounded-full bg-black" />
                  <div className="absolute top-2 right-1.5 w-1 h-1 rounded-full bg-black" />
                  <div className="absolute bottom-1 left-1/2 -translate-x-1/2 w-2 h-0.5 rounded-full bg-black/70" />
                </div>
                {/* body */}
                <div className="absolute left-1/2 -translate-x-1/2 top-9 w-8 h-5 rounded-sm bg-indigo-500/80" />
                {/* hammer arm */}
                <div className="absolute left-0 top-10 w-1.5 h-4 bg-[#f2c9a4] origin-top" style={{ animation: "maint-hammer 0.9s ease-in-out infinite" }}>
                  <Hammer className="w-3.5 h-3.5 text-slate-200 absolute -bottom-3 -left-1" />
                </div>
              </div>
            </div>

            {/* floating sparkles */}
            <Sparkles className="absolute left-1/2 top-4 w-4 h-4 text-amber-200/80" style={{ animation: "maint-float 3s ease-in-out infinite" }} />
            <Sparkles className="absolute left-1/4 top-8 w-3 h-3 text-pink-200/70" style={{ animation: "maint-float 4s ease-in-out infinite 0.6s" }} />
            <Sparkles className="absolute right-1/4 top-10 w-3 h-3 text-cyan-200/70" style={{ animation: "maint-float 3.6s ease-in-out infinite 1.1s" }} />

            {/* status pill floating */}
            <div className="absolute top-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-2 px-3 py-1 rounded-full border border-amber-300/25 bg-amber-500/[0.12] backdrop-blur-md">
              <span className="relative flex w-1.5 h-1.5">
                <span className="absolute inset-0 rounded-full bg-amber-300/70 animate-ping" />
                <span className="relative inline-flex rounded-full w-1.5 h-1.5 bg-amber-300" />
              </span>
              <span className="text-[9px] uppercase tracking-[0.24em] font-semibold text-amber-100/90">Under maintenance</span>
            </div>
          </div>

          <h1
            className="text-[26px] sm:text-[40px] leading-[1.08] tracking-tight text-white mb-3 text-center"
            style={{ fontFamily: "'Instrument Serif', ui-serif, Georgia, serif", letterSpacing: "-0.02em" }}
          >
            {displayTitle}
          </h1>

          <p className="text-white/70 text-[13.5px] sm:text-[15px] leading-relaxed font-light max-w-[460px] mx-auto text-center">
            {displayMessage}
          </p>

          {eta && (
            <div className="mt-5 flex justify-center">
              <div className="inline-flex items-center gap-2 text-white/80 text-[12px] bg-white/[0.05] border border-white/[0.1] rounded-full px-3.5 py-1.5">
                <Coffee className="w-3.5 h-3.5 text-amber-300" />
                <span className="tracking-wide">Back around <span className="text-white font-medium">{eta}</span></span>
              </div>
            </div>
          )}

          {/* Mini game: tap the bolts */}
          <div className="mt-6 sm:mt-8">
            <div className="flex items-center justify-between mb-2 px-1">
              <span className="text-[10.5px] uppercase tracking-[0.22em] text-white/50 font-semibold">Kill time · tap the bolts</span>
              <span className="text-[11px] font-mono tabular-nums text-amber-200/90">{bolts.toString().padStart(3, "0")}</span>
            </div>
            <div
              onClick={tapBolt}
              className="relative h-20 sm:h-24 rounded-2xl overflow-hidden border border-white/[0.08] cursor-pointer select-none active:scale-[0.995] transition-transform"
              style={{ background: "linear-gradient(180deg, rgba(229,9,20,0.08), rgba(255,255,255,0.02))" }}
            >
              {/* moving bolts */}
              {[0, 1, 2, 3].map((i) => (
                <Wrench
                  key={i}
                  className="absolute w-5 h-5 text-amber-200/90 drop-shadow-[0_0_8px_rgba(252,211,77,0.5)]"
                  style={{
                    top: `${20 + (i % 2) * 40}%`,
                    left: `-10%`,
                    animation: `maint-slide ${5 + i * 1.3}s linear infinite ${i * 0.7}s`,
                  }}
                />
              ))}
              {pop.map((p) => (
                <span
                  key={p.id}
                  className="absolute text-amber-200 font-bold text-sm pointer-events-none"
                  style={{ left: p.x, top: p.y, transform: "translate(-50%,-50%)", animation: "maint-pop 0.9s ease-out forwards" }}
                >
                  +1
                </span>
              ))}
              <div className="absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-black/40 to-transparent pointer-events-none flex items-end justify-center pb-1">
                <span className="text-[10px] text-white/40 tracking-wider">tap anywhere</span>
              </div>
            </div>
          </div>

          {/* Progress shimmer */}
          <div className="mt-6 h-[3px] w-full rounded-full overflow-hidden bg-white/[0.06]">
            <div className="h-full w-1/3 rounded-full" style={{ background: "linear-gradient(90deg, transparent, #e50914, #ffb46b, transparent)", animation: "maint-shimmer 2s linear infinite" }} />
          </div>

          {isAdmin && onAdminBypass && (
            <div className="mt-6 flex justify-center">
              <button
                onClick={onAdminBypass}
                className="group inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-black text-[13px] font-semibold hover:bg-white/90 transition-all hover:gap-3"
              >
                Enter as admin
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="absolute bottom-3 inset-x-0 text-center text-[10px] sm:text-[10.5px] text-white/40 tracking-[0.2em] uppercase z-10">
        Thank you for your patience
      </div>

      <style>{`
        @keyframes maint-shimmer { 0%{transform:translateX(-100%);} 100%{transform:translateX(400%);} }
        @keyframes maint-spin { to { transform: rotate(360deg); } }
        @keyframes maint-spin-r { to { transform: rotate(-360deg); } }
        @keyframes maint-hop { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-6px);} }
        @keyframes maint-bob { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-3px);} }
        @keyframes maint-hammer { 0%,100%{transform:rotate(-20deg);} 50%{transform:rotate(40deg);} }
        @keyframes maint-float { 0%,100%{transform:translateY(0) rotate(0);opacity:.8;} 50%{transform:translateY(-8px) rotate(15deg);opacity:1;} }
        @keyframes maint-slide { 0%{left:-10%;transform:rotate(0);} 100%{left:110%;transform:rotate(360deg);} }
        @keyframes maint-pop { 0%{opacity:1;transform:translate(-50%,-50%) scale(0.6);} 100%{opacity:0;transform:translate(-50%,-140%) scale(1.2);} }
      `}</style>
    </div>
  );
}
