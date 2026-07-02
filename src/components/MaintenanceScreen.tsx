import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { ArrowRight, Clock } from "lucide-react";

type Props = {
  title?: string;
  message?: string;
  eta?: string;
  isAdmin?: boolean;
  onAdminBypass?: () => void;
};

/**
 * Netflix-inspired premium maintenance screen.
 * Cinematic black stage, crimson brand palette, Three.js flowing shader,
 * drifting embers, editorial serif headline on a glass card.
 */
export default function MaintenanceScreen({ title, message, eta, isAdmin, onAdminBypass }: Props) {
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

  const displayTitle = title?.trim() || "We'll be back soon";
  const displayMessage =
    message?.trim() ||
    "Our site is temporarily down for scheduled maintenance. We're upgrading the system to make things faster and more reliable for you. Please check back in a little while — no action is needed on your side.";


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
          <span>{now.toLocaleTimeString()}</span>
        </div>
      </div>

      <div className="relative z-10 h-full flex items-center justify-center px-4 sm:px-5 py-20 overflow-y-auto">
        <div
          className="w-full max-w-[620px] rounded-[24px] px-6 sm:px-12 py-8 sm:py-12 text-center backdrop-blur-2xl border animate-fade-in"
          style={{
            background: "linear-gradient(180deg, rgba(15,6,8,0.72) 0%, rgba(6,3,4,0.82) 100%)",
            borderColor: "rgba(255,255,255,0.08)",
            boxShadow: "0 40px 140px -20px rgba(229,9,20,0.25), 0 20px 60px -10px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)",
          }}
        >
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-[#e50914]/30 bg-[#e50914]/[0.08] mb-6 sm:mb-7">
            <span className="relative flex w-2 h-2">
              <span className="absolute inset-0 rounded-full bg-[#e50914]/70 animate-ping" />
              <span className="relative inline-flex rounded-full w-2 h-2 bg-[#e50914]" />
            </span>
            <span className="text-[10px] sm:text-[10.5px] uppercase tracking-[0.24em] font-semibold text-red-100/90">Site under maintenance</span>
          </div>

          <div className="mx-auto mb-6 sm:mb-8 relative w-16 h-16 sm:w-20 sm:h-20">
            <div
              className="absolute inset-0 rounded-2xl flex items-center justify-center font-black text-white text-[38px] sm:text-[46px] leading-none"
              style={{
                background: "linear-gradient(135deg,#e50914 0%,#7a0910 100%)",
                boxShadow: "0 20px 40px -10px rgba(229,9,20,0.6), inset 0 1px 0 rgba(255,255,255,0.15)",
                fontFamily: "'Bebas Neue', 'Arial Black', sans-serif",
              }}
            >
              N
            </div>
            <div className="absolute -inset-2 rounded-2xl bg-[#e50914]/25 blur-xl -z-10 animate-pulse" />
          </div>

          <h1
            className="text-[28px] sm:text-[44px] leading-[1.05] tracking-tight text-white mb-4"
            style={{ fontFamily: "'Instrument Serif', ui-serif, Georgia, serif", letterSpacing: "-0.02em" }}
          >
            {displayTitle}
          </h1>

          <p className="text-white/65 text-[13.5px] sm:text-[15px] leading-relaxed font-light max-w-[460px] mx-auto">
            {displayMessage}
          </p>

          {eta && (
            <div className="mt-6 inline-flex items-center gap-2 text-white/75 text-[12px] bg-white/[0.04] border border-white/[0.1] rounded-full px-3.5 py-1.5">
              <Clock className="w-3.5 h-3.5 text-[#e50914]" />
              <span className="tracking-wide">Back online <span className="text-white font-medium">{eta}</span></span>
            </div>
          )}

          <div className="mt-8 h-[3px] w-full rounded-full overflow-hidden bg-white/[0.06]">
            <div className="h-full w-1/3 rounded-full" style={{ background: "linear-gradient(90deg, transparent, #e50914 40%, #ff3b47 60%, transparent)", animation: "maint-shimmer 1.8s linear infinite" }} />
          </div>

          {isAdmin && onAdminBypass && (
            <button
              onClick={onAdminBypass}
              className="mt-8 group inline-flex items-center gap-2 px-6 py-3 rounded-md text-white text-[13px] font-semibold transition-all hover:gap-3"
              style={{ background: "linear-gradient(180deg,#e50914,#b0060f)", boxShadow: "0 10px 30px -8px rgba(229,9,20,0.55)" }}
            >
              Enter as admin
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </button>
          )}
        </div>
      </div>

      <div className="absolute bottom-3 inset-x-0 text-center text-[10px] sm:text-[10.5px] text-white/35 tracking-[0.24em] uppercase z-10">
        Thank you for your patience
      </div>

      <style>{`@keyframes maint-shimmer { 0%{transform:translateX(-100%);} 100%{transform:translateX(400%);} }`}</style>
    </div>
  );
}
