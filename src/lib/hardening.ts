// Client-side hardening: disable devtools shortcuts, right-click, selection abuse,
// anti-debugger loop, and block common site-rippers via UA sniff.
// NOTE: This is deterrence, not real security. Do NOT rely on it for secrets.

const DEV = import.meta.env.DEV;

function isBlockedBot(): boolean {
  const ua = (navigator.userAgent || "").toLowerCase();
  const badBots = [
    "httrack", "wget", "curl", "webzip", "teleport", "offline explorer",
    "sitesnagger", "webcopier", "getleft", "cyotek", "webreaper",
    "httpx", "python-requests", "scrapy", "libwww-perl", "go-http-client",
    "java/", "okhttp", "apache-httpclient",
  ];
  return badBots.some((b) => ua.includes(b));
}

function showBlockedScreen() {
  document.documentElement.innerHTML = `
    <body style="margin:0;background:#020617;color:#f8fafc;font-family:Inter,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div style="max-width:480px;text-align:center;">
        <div style="width:56px;height:56px;margin:0 auto 20px;border-radius:18px;background:linear-gradient(135deg,#ef4444,#b91c1c);display:grid;place-items:center;color:#fff;font-weight:900;font-size:28px;">!</div>
        <h1 style="font-size:22px;margin:0 0 12px;font-weight:800;">Access denied</h1>
        <p style="color:#94a3b8;line-height:1.6;margin:0;">Automated downloaders and scrapers are not allowed.</p>
      </div>
    </body>`;
}

export function installHardening() {
  if (DEV) return; // don't cripple local development
  try {
    if (isBlockedBot()) { showBlockedScreen(); return; }
  } catch {}

  // 1. Right-click disable
  window.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement;
    // allow right-click on inputs/textareas so users can paste
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    e.preventDefault();
  }, { capture: true });

  // 2. Devtools / view-source shortcuts
  window.addEventListener("keydown", (e) => {
    const k = (e.key || "").toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    // F12
    if (k === "f12") { e.preventDefault(); return; }
    // Ctrl+Shift+I / J / C / K
    if (ctrl && e.shiftKey && ["i", "j", "c", "k"].includes(k)) { e.preventDefault(); return; }
    // Ctrl+U (view source), Ctrl+S (save page)
    if (ctrl && (k === "u" || k === "s")) { e.preventDefault(); return; }
  }, { capture: true });

  // 3. Drag / copy of images (deterrent)
  window.addEventListener("dragstart", (e) => {
    const t = e.target as HTMLElement;
    if (t && t.tagName === "IMG") e.preventDefault();
  }, { capture: true });

  // 4. Anti-debugger loop — if devtools is open, debugger triggers repeatedly.
  //    Harmless when devtools is closed.
  const antiDebug = () => {
    try {
      const start = performance.now();
      // eslint-disable-next-line no-debugger
      debugger;
      const dt = performance.now() - start;
      if (dt > 120) {
        // devtools likely open — clear body
        document.body.style.filter = "blur(12px)";
        document.body.style.pointerEvents = "none";
      } else {
        document.body.style.filter = "";
        document.body.style.pointerEvents = "";
      }
    } catch {}
  };
  setInterval(antiDebug, 1500);

  // 5. Silence console in production
  try {
    const noop = () => {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ["log", "warn", "info", "debug", "table", "trace"].forEach((m) => ((console as any)[m] = noop));
  } catch {}
}
