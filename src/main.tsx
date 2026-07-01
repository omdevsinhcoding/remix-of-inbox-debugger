import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

function esc(s: string) {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] || c));
}

function showFatal(message: string) {
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = `
    <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,-apple-system,sans-serif;background:#020617;color:#e2e8f0;">
      <div style="max-width:420px;background:#0f172a;border:1px solid #7f1d1d;border-radius:20px;padding:24px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5);">
        <div style="width:42px;height:42px;border-radius:14px;margin:0 auto 14px;background:linear-gradient(135deg,#ef4444,#b91c1c);"></div>
        <h1 style="font-size:18px;margin:0 0 6px;font-weight:800;color:#f8fafc;">Something went wrong loading the app</h1>
        <p style="font-size:12px;color:#94a3b8;margin:0 0 12px;line-height:1.5;word-break:break-word;">${esc(message)}</p>
        <button onclick="location.reload()" style="background:#ef4444;color:#fff;border:0;padding:10px 18px;border-radius:10px;font-weight:700;cursor:pointer;">Reload</button>
      </div>
    </div>`;
}

function setBootStatus(message: string) {
  try {
    const el = document.getElementById('boot-error');
    if (el) {
      el.style.display = 'block';
      el.textContent = message;
    }
  } catch {}
}

async function boot() {
  try {
    const container = document.getElementById('root');
    if (!container) throw new Error('Missing #root element');

    setBootStatus('Starting app…');
    const mod = await import('./App.tsx');
    const App = mod.default;

    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (err: any) {
    console.error('[boot] fatal:', err);
    showFatal(err?.message || String(err));
  }
}

void boot();

window.addEventListener('error', (e) => {
  const root = document.getElementById('root');
  if (root && root.querySelector('#boot-fallback')) showFatal(e?.message || 'Script error');
});
window.addEventListener('unhandledrejection', (e: any) => {
  const root = document.getElementById('root');
  if (root && root.querySelector('#boot-fallback')) showFatal(e?.reason?.message || String(e?.reason) || 'Promise rejected');
});
