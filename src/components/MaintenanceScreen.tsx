import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { ArrowRight, Clock } from "lucide-react";

type Props = {
  title?: string;
  message?: string;
  endsAt?: string | null;
  versionFrom?: string;
  versionTo?: string;
  isAdmin?: boolean;
  onAdminBypass?: () => void;
};


/**
 * Netflix-inspired premium maintenance screen.
 * Cinematic black stage, crimson brand palette, Three.js flowing shader,
 * drifting embers, editorial serif headline on a glass card.
 */
export default function MaintenanceScreen({ title, message, endsAt, versionFrom, versionTo, isAdmin, onAdminBypass }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<HTMLCanvasElement | null>(null);
  const [now, setNow] = useState<Date>(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

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
          float t=uTime*0.06;
          vec2 q=vec2(fbm(p*1.4+t), fbm(p*1.4-t+3.7));
          float n=fbm(p*2.0+q*1.3+t*0.8);
          vec3 c1=vec3(0.008,0.006,0.010);
          vec3 c2=vec3(0.10,0.02,0.04);
          vec3 c3=vec3(0.55,0.04,0.08);
          vec3 c4=vec3(0.90,0.05,0.10);
          vec3 col=mix(c1,c2, smoothstep(-0.5,0.4,n));
          col=mix(col,c3, smoothstep(0.2,0.8,n)*0.55);
          col=mix(col,c4, smoothstep(0.65,1.0,n)*0.22);
          float d=distance(uv,uMouse);
          col+=vec3(0.90,0.10,0.12)*smoothstep(0.35,0.0,d)*0.12;
          float vig=smoothstep(1.20,0.30,length(p));
          col*=mix(0.35,1.0,vig);
          float grain=fract(sin(dot(uv*uResolution,vec2(12.9898,78.233)))*43758.5453);
          col+=(grain-0.5)*0.03;
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

  useEffect(() => {
    const c = particlesRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const parts = Array.from({ length: 55 }, () => ({
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00012,
      vy: -0.00008 - Math.random() * 0.00022,
      r: 0.5 + Math.random() * 1.8,
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
        g.addColorStop(0, `rgba(255,120,110,${p.a})`);
        g.addColorStop(1, "rgba(255,120,110,0)");
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

  // Rotating headlines — used when admin hasn't set a custom title.
  const rotatingTitles = [
    "We're upgrading the system",
    "Tuning things up behind the scenes",
    "Rolling out a fresh update",
    "Making the app faster for you",
    "Polishing a few pixels",
    "Sharpening the experience",
    "Deploying new improvements",
    "Fine-tuning the engine",
    "Refreshing the servers",
    "Almost ready — final touches",
    "Just a quick pit stop",
    "Back in a few moments",
  ];
  const customTitle = title?.trim();
  const [titleIdx, setTitleIdx] = useState(0);
  const [titlePhase, setTitlePhase] = useState<"in" | "out">("in");
  const displayTitle = customTitle || rotatingTitles[titleIdx];
  const letters = Array.from(displayTitle);
  const IN_STEP = 45;   // ms between letters appearing
  const OUT_STEP = 28;  // ms between letters disappearing
  const IN_DUR = 520;   // per-letter fade-in duration
  const OUT_DUR = 380;  // per-letter fade-out duration
  const HOLD = 1100;    // hold time after fully shown
  useEffect(() => {
    if (customTitle) return; // don't rotate when admin pinned a headline
    if (titlePhase === "in") {
      const totalIn = letters.length * IN_STEP + IN_DUR + HOLD;
      const t = setTimeout(() => setTitlePhase("out"), totalIn);
      return () => clearTimeout(t);
    } else {
      const totalOut = letters.length * OUT_STEP + OUT_DUR;
      const t = setTimeout(() => {
        setTitleIdx((i) => (i + 1) % rotatingTitles.length);
        setTitlePhase("in");
      }, totalOut);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customTitle, titlePhase, titleIdx]);

  const displayMessage =
    message?.trim() ||
    "The site is offline for a short while so we can make it faster and safer for you. You don't need to do anything — just come back in a few minutes.";


  // 12-hour formatted clock
  const clockText = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });

  // Countdown / back-at label built from endsAt
  const endsDate = endsAt ? new Date(endsAt) : null;
  const endsValid = !!(endsDate && !isNaN(endsDate.getTime()) && endsDate.getTime() > Date.now());
  let backAtLabel = "";
  let countdownLabel = "";
  if (endsValid && endsDate) {
    backAtLabel = endsDate.toLocaleString(undefined, {
      hour: "numeric", minute: "2-digit", hour12: true,
      day: "numeric", month: "short",
    });
    const diff = Math.max(0, endsDate.getTime() - now.getTime());
    const totalMin = Math.floor(diff / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const s = Math.floor((diff % 60000) / 1000);
    countdownLabel = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  // Version pill (only if admin filled at least one field)
  const vFrom = (versionFrom || "").trim();
  const vTo = (versionTo || "").trim();
  const showVersionPill = !!(vFrom || vTo);

  const activityLines = [
    "Applying security updates…",
    "Optimising database queries…",
    "Refreshing the mailbox engine…",
    "Warming up the servers…",
    "Running final health checks…",
  ];
  const [activityIdx, setActivityIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setActivityIdx((i) => (i + 1) % activityLines.length), 2200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  return (
    <div className="fixed inset-0 z-[9999] overflow-hidden bg-black text-white">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={particlesRef} className="absolute inset-0 w-full h-full pointer-events-none mix-blend-screen" />

      <div className="absolute top-0 inset-x-0 flex items-center justify-between px-4 sm:px-10 py-4 sm:py-5 z-10">
        <div className="flex items-center gap-3">
          <div className="font-black text-[22px] sm:text-[26px] leading-none tracking-tight" style={{ color: "#e50914", fontFamily: "'Bebas Neue', 'Arial Black', sans-serif", textShadow: "0 0 30px rgba(229,9,20,0.55)" }}>NETFLIX</div>
          <span className="hidden sm:inline text-[10px] tracking-[0.28em] uppercase text-white/50 font-medium border-l border-white/15 pl-3">ID Manager</span>
        </div>
        <div className="flex items-center gap-2 text-white/55 text-[11px] font-mono tabular-nums">
          <span className="w-1.5 h-1.5 rounded-full bg-[#e50914] animate-pulse" />
          <span>{clockText}</span>
        </div>
      </div>


      <div className="relative z-10 h-full flex items-center justify-center px-4 sm:px-6 py-20 overflow-y-auto">
        <div
          className="relative w-full max-w-[640px] rounded-[22px] overflow-hidden animate-fade-in"
          style={{
            background:
              "linear-gradient(180deg, rgba(18,18,20,0.86) 0%, rgba(8,8,10,0.94) 100%)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow:
              "0 60px 160px -30px rgba(229,9,20,0.22), 0 30px 80px -20px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.05)",
          }}
        >
          {/* Top console strip */}
          <div className="flex items-center justify-between px-6 sm:px-8 py-3.5 border-b border-white/[0.06] bg-white/[0.015]">
            <div className="flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-[#e50914] shadow-[0_0_10px_#e50914] animate-pulse" />
              <span className="text-[10.5px] tracking-[0.3em] uppercase text-white/70 font-semibold">System update in progress</span>
            </div>
            {showVersionPill && (
              <div className="hidden sm:flex items-center gap-1.5 text-[10.5px] tracking-[0.24em] uppercase text-white/40 font-mono">
                {vFrom && <span>v{vFrom.replace(/^v/i, "")}</span>}
                {vFrom && vTo && <span className="text-white/20">→</span>}
                {vTo && <span className="text-white/80">v{vTo.replace(/^v/i, "")}</span>}
              </div>
            )}

          </div>

          <div className="px-6 sm:px-10 pt-8 sm:pt-10 pb-8 sm:pb-10">
            {/* Animated equaliser / heartbeat */}
            <div className="flex items-end gap-[6px] h-14 mb-8" aria-hidden>
              {Array.from({ length: 32 }).map((_, i) => (
                <span
                  key={i}
                  className="flex-1 rounded-full"
                  style={{
                    background: "linear-gradient(180deg, #ff3b47, #7a0910)",
                    animation: `maint-eq 1.${(i % 7) + 2}s ease-in-out ${i * 0.06}s infinite alternate`,
                    height: "12%",
                    boxShadow: "0 0 8px rgba(229,9,20,0.4)",
                  }}
                />
              ))}
            </div>

            <h1
              className="text-[28px] sm:text-[40px] font-semibold text-white leading-[1.15] tracking-[-0.02em] mb-3 min-h-[1.2em]"
              style={{ fontFamily: "'Inter', 'Helvetica Neue', system-ui, sans-serif" }}
            >
              {(() => {
                const words = displayTitle.split(" ");
                let letterIndex = -1;
                return (
                  <span key={`${titleIdx}-${titlePhase}`} className="inline">
                    {words.map((word, wi) => (
                      <span key={wi} className="inline-block whitespace-nowrap">
                        {Array.from(word).map((ch) => {
                          letterIndex += 1;
                          const isOut = titlePhase === "out";
                          const delay = isOut
                            ? letterIndex * OUT_STEP
                            : letterIndex * IN_STEP;
                          return (
                            <span
                              key={letterIndex}
                              className="inline-block"
                              style={{
                                animation: isOut
                                  ? `maint-letter-out ${OUT_DUR}ms cubic-bezier(0.55,0.06,0.68,0.19) both`
                                  : `maint-letter-in ${IN_DUR}ms cubic-bezier(0.22,0.61,0.36,1) both`,
                                animationDelay: `${delay}ms`,
                              }}
                            >
                              {ch}
                            </span>
                          );
                        })}
                        {wi < words.length - 1 && <span className="inline-block">&nbsp;</span>}
                      </span>
                    ))}
                  </span>
                );
              })()}
            </h1>



            <p className="text-white/60 text-[14px] sm:text-[15.5px] leading-relaxed font-light max-w-[520px]">
              {displayMessage}
            </p>

            {/* Live activity log */}
            <div
              className="mt-7 rounded-xl border border-white/[0.06] bg-black/40 px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-3 overflow-hidden"
              style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)" }}
            >
              <span className="relative flex w-2 h-2 flex-shrink-0">
                <span className="absolute inset-0 rounded-full bg-emerald-400/60 animate-ping" />
                <span className="relative inline-flex rounded-full w-2 h-2 bg-emerald-400" />
              </span>
              <span className="text-[10px] sm:text-[11px] uppercase tracking-[0.2em] sm:tracking-[0.22em] text-white/45 font-mono flex-shrink-0">Live</span>
              <span className="text-white/20 flex-shrink-0">|</span>




            <p className="text-white/60 text-[14px] sm:text-[15.5px] leading-relaxed font-light max-w-[520px]">
              {displayMessage}
            </p>

            {/* Live activity log */}
            <div
              className="mt-7 rounded-xl border border-white/[0.06] bg-black/40 px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-3 overflow-hidden"
              style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)" }}
            >
              <span className="relative flex w-2 h-2 flex-shrink-0">
                <span className="absolute inset-0 rounded-full bg-emerald-400/60 animate-ping" />
                <span className="relative inline-flex rounded-full w-2 h-2 bg-emerald-400" />
              </span>
              <span className="hidden sm:inline text-[11px] uppercase tracking-[0.22em] text-white/45 font-mono flex-shrink-0">Live</span>
              <span className="hidden sm:inline text-white/20">|</span>
              <span
                key={activityIdx}
                className="text-[12px] sm:text-[13px] text-white/85 animate-fade-in font-mono flex-1 min-w-0 truncate"
                title={activityLines[activityIdx]}
              >
                {activityLines[activityIdx]}
              </span>
            </div>


            {/* Meta row */}
            <div className="mt-6 flex flex-wrap items-center gap-2.5">
              {endsValid && (
                <div className="inline-flex items-center gap-2 text-white/85 text-[12.5px] bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-1.5">
                  <Clock className="w-3.5 h-3.5 text-[#e50914]" />
                  <span>
                    Back at <span className="text-white font-semibold">{backAtLabel}</span>
                    <span className="text-white/45"> · in </span>
                    <span className="text-white font-semibold tabular-nums">{countdownLabel}</span>
                  </span>
                </div>
              )}

              <div className="inline-flex items-center gap-2 text-white/60 text-[12.5px] bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span>No action needed from you</span>
              </div>
              <div className="inline-flex items-center gap-2 text-white/60 text-[12.5px] bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#e50914]" />
                <span>Your data is safe</span>
              </div>
            </div>

            {isAdmin && onAdminBypass && (
              <button
                onClick={onAdminBypass}
                className="mt-7 group inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-white text-[13px] font-semibold transition-all hover:gap-3"
                style={{ background: "linear-gradient(180deg,#e50914,#b0060f)", boxShadow: "0 10px 30px -8px rgba(229,9,20,0.55)" }}
              >
                Enter as admin
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="absolute bottom-3 inset-x-0 text-center text-[10px] sm:text-[10.5px] text-white/35 tracking-[0.24em] uppercase z-10">
        Thanks for waiting — see you in a bit
      </div>

      <style>{`
        @keyframes maint-eq {
          0%   { height: 12%; opacity: 0.5; }
          50%  { height: 85%; opacity: 1; }
          100% { height: 22%; opacity: 0.6; }
        }
        @keyframes maint-title-in {
          0%   { opacity: 0; transform: translateY(14px); filter: blur(6px); }
          60%  { opacity: 1; filter: blur(0); }
          100% { opacity: 1; transform: translateY(0);   filter: blur(0); }
        }
        @keyframes maint-letter-in {
          0%   { opacity: 0; transform: translateY(0.6em) rotateX(-40deg); filter: blur(4px); }
          60%  { opacity: 1; filter: blur(0); }
          100% { opacity: 1; transform: translateY(0) rotateX(0);           filter: blur(0); }
        }

      `}</style>

    </div>
  );
}

