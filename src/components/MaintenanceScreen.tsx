import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Wrench, ArrowRight, Clock } from "lucide-react";

type Props = {
  title?: string;
  message?: string;
  eta?: string;
  isAdmin?: boolean;
  onAdminBypass?: () => void;
};

/**
 * Premium animated maintenance screen.
 * - Three.js fullscreen ShaderMaterial: flowing gradient mesh + drifting particles.
 * - Pure GLSL noise, no textures — lightweight, GPU-accelerated.
 * - Glass card with editorial serif headline over a dark cinematic backdrop.
 */
export default function MaintenanceScreen({ title, message, eta, isAdmin, onAdminBypass }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<HTMLCanvasElement | null>(null);
  const [now, setNow] = useState<Date>(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
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
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform float uTime;
        uniform vec2 uResolution;
        uniform vec2 uMouse;

        // Classic 2D simplex noise (Ashima)
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

        // Layered flowing noise → gradient blend
        float fbm(vec2 p){
          float v=0.0; float a=0.5;
          for(int i=0;i<5;i++){ v+=a*snoise(p); p*=2.02; a*=0.5; }
          return v;
        }

        void main(){
          vec2 uv=vUv;
          vec2 p=(uv-0.5)*vec2(uResolution.x/uResolution.y,1.0);

          float t=uTime*0.08;
          vec2 q=vec2(fbm(p*1.6+t), fbm(p*1.6-t+3.7));
          float n=fbm(p*2.2+q*1.4+t*0.9);

          // Palette: obsidian → deep violet → magenta ember → warm gold spark
          vec3 c1=vec3(0.035,0.031,0.055);       // near-black indigo
          vec3 c2=vec3(0.16,0.08,0.28);          // violet
          vec3 c3=vec3(0.92,0.32,0.45);          // ember red/pink
          vec3 c4=vec3(1.0,0.78,0.42);           // warm gold

          vec3 col=mix(c1,c2, smoothstep(-0.6,0.4,n));
          col=mix(col,c3, smoothstep(0.15,0.75,n)*0.55);
          col=mix(col,c4, smoothstep(0.55,0.95,n)*0.28);

          // Cursor-driven glow
          float d=distance(uv,uMouse);
          col+=vec3(0.9,0.5,0.35)*smoothstep(0.35,0.0,d)*0.10;

          // Vignette
          float vig=smoothstep(1.15,0.35,length(p));
          col*=mix(0.55,1.0,vig);

          // Subtle grain
          float grain=fract(sin(dot(uv*uResolution,vec2(12.9898,78.233)))*43758.5453);
          col+=(grain-0.5)*0.025;

          gl_FragColor=vec4(col,1.0);
        }
      `,
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    scene.add(mesh);

    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
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
      material.dispose();
      mesh.geometry.dispose();
      renderer.dispose();
    };
  }, []);

  // Lightweight drifting particles on top (2D canvas — near-zero cost)
  useEffect(() => {
    const c = particlesRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const parts = Array.from({ length: 60 }, () => ({
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

  const displayTitle = title?.trim() || "We're polishing things up";
  const displayMessage =
    message?.trim() ||
    "Netflix ID Manager is temporarily offline for scheduled maintenance. We'll be back with improved performance and new features shortly.";

  return (
    <div className="fixed inset-0 z-[9999] overflow-hidden bg-black text-white">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={particlesRef} className="absolute inset-0 w-full h-full pointer-events-none mix-blend-screen" style={{ width: "100%", height: "100%" }} />

      {/* Top brand strip */}
      <div className="absolute top-0 inset-x-0 flex items-center justify-between px-5 sm:px-10 py-5 z-10">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-white text-lg" style={{ background: "linear-gradient(135deg,#e50914,#7a0910)", boxShadow: "0 0 24px rgba(229,9,20,0.55)" }}>N</div>
          <span className="text-[11px] tracking-[0.32em] uppercase text-white/60 font-medium">Netflix ID Manager</span>
        </div>
        <div className="flex items-center gap-2 text-white/60 text-[11px] font-mono tabular-nums">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="hidden sm:inline">{now.toLocaleTimeString()}</span>
        </div>
      </div>

      {/* Center content */}
      <div className="relative z-10 h-full flex items-center justify-center px-5">
        <div
          className="w-full max-w-[640px] rounded-3xl px-6 sm:px-10 py-8 sm:py-12 text-center backdrop-blur-2xl border animate-fade-in"
          style={{
            background: "linear-gradient(180deg, rgba(20,14,26,0.62) 0%, rgba(10,8,14,0.72) 100%)",
            borderColor: "rgba(255,255,255,0.08)",
            boxShadow: "0 40px 120px -20px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.06)",
          }}
        >
          {/* Animated status pill */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-amber-300/25 bg-amber-500/[0.08] mb-6">
            <span className="relative flex w-2 h-2">
              <span className="absolute inset-0 rounded-full bg-amber-300/70 animate-ping" />
              <span className="relative inline-flex rounded-full w-2 h-2 bg-amber-300" />
            </span>
            <span className="text-[10.5px] uppercase tracking-[0.24em] font-semibold text-amber-100/90">Scheduled maintenance</span>
          </div>

          {/* Rotating wrench icon */}
          <div className="mx-auto mb-6 w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: "radial-gradient(circle at 30% 30%, rgba(229,9,20,0.35), rgba(0,0,0,0) 70%), rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
            <Wrench className="w-7 h-7 text-white/85" style={{ animation: "maint-wrench 2.4s ease-in-out infinite" }} />
          </div>

          <h1
            className="text-[34px] sm:text-[46px] leading-[1.05] tracking-tight text-white mb-4"
            style={{ fontFamily: "'Instrument Serif', ui-serif, Georgia, serif", letterSpacing: "-0.02em" }}
          >
            {displayTitle}
          </h1>

          <p className="text-white/70 text-[14px] sm:text-[15px] leading-relaxed font-light max-w-[440px] mx-auto">
            {displayMessage}
          </p>

          {eta && (
            <div className="mt-6 inline-flex items-center gap-2 text-white/75 text-[12px] bg-white/[0.04] border border-white/[0.08] rounded-full px-3.5 py-1.5">
              <Clock className="w-3.5 h-3.5 text-amber-300" />
              <span className="tracking-wide">Estimated back online: <span className="text-white font-medium">{eta}</span></span>
            </div>
          )}

          {/* Progress shimmer */}
          <div className="mt-8 h-[3px] w-full rounded-full overflow-hidden bg-white/[0.06]">
            <div className="h-full w-1/3 rounded-full" style={{ background: "linear-gradient(90deg, transparent, #e50914, #ffb46b, transparent)", animation: "maint-shimmer 2s linear infinite" }} />
          </div>

          {isAdmin && onAdminBypass && (
            <button
              onClick={onAdminBypass}
              className="mt-8 group inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-black text-[13px] font-semibold hover:bg-white/90 transition-all hover:gap-3"
            >
              Enter as admin
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </button>
          )}
        </div>
      </div>

      {/* Bottom line */}
      <div className="absolute bottom-4 inset-x-0 text-center text-[10.5px] text-white/40 tracking-[0.2em] uppercase z-10">
        Thank you for your patience
      </div>

      <style>{`
        @keyframes maint-shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
        @keyframes maint-wrench {
          0%,100% { transform: rotate(-12deg); }
          50% { transform: rotate(18deg); }
        }
      `}</style>
    </div>
  );
}
