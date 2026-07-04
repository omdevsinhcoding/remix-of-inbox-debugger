import { AlertTriangle, Check, Info, LoaderCircle, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { type GlobalToast, notify, toastStore } from "./notify";

type ToastTone = "light" | "dark";

const ICONS = {
  success: Check,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
  loading: LoaderCircle,
};

function parseRgb(value: string): [number, number, number] | null {
  if (!value || value === "transparent") return null;
  const match = value.match(/rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*(\d+(?:\.\d+)?))?\)/i);
  if (!match) return null;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (alpha < 0.2) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance([r, g, b]: [number, number, number]) {
  const toLinear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function getPageTone(): ToastTone {
  if (typeof window === "undefined" || typeof document === "undefined") return "dark";
  const x = Math.max(12, window.innerWidth - 28);
  const y = Math.max(12, window.innerHeight - 28);
  const stack = document.elementsFromPoint(x, y);
  for (const element of stack) {
    if ((element as HTMLElement).closest?.("[data-global-toast-root]")) continue;
    let node: Element | null = element;
    while (node) {
      const bg = parseRgb(window.getComputedStyle(node).backgroundColor);
      if (bg) return luminance(bg) > 0.38 ? "dark" : "light";
      node = node.parentElement;
    }
  }
  const bodyBg = parseRgb(window.getComputedStyle(document.body).backgroundColor);
  if (bodyBg) return luminance(bodyBg) > 0.38 ? "dark" : "light";
  return "dark";
}

function ToastCard({ toast, tone }: { toast: GlobalToast; tone: ToastTone }) {
  const Icon = ICONS[toast.variant];
  return (
    <div className="gt-toast" data-tone={tone} data-variant={toast.variant} role="status" aria-live="polite">
      <div className="gt-toast-icon" aria-hidden="true">
        <Icon />
      </div>
      <div className="gt-toast-copy">
        <div className="gt-toast-title">{toast.title}</div>
        {toast.description ? <div className="gt-toast-desc">{toast.description}</div> : null}
      </div>
      <button className="gt-toast-close" type="button" aria-label="Dismiss notification" onClick={() => notify.dismiss(toast.id)}>
        <X />
      </button>
    </div>
  );
}

export function ToastProvider() {
  const [toasts, setToasts] = useState<GlobalToast[]>(() => toastStore.getSnapshot());
  const [tone, setTone] = useState<ToastTone>(() => getPageTone());

  useEffect(() => {
    return toastStore.subscribe(setToasts);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    let raf = 0;
    const update = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => setTone(getPageTone()));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = new MutationObserver(update);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true, attributeFilter: ["class", "style"] });
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer.disconnect();
    };
  }, []);

  const root = useMemo(() => (typeof document === "undefined" ? null : document.body), []);
  if (!root || toasts.length === 0) return null;

  return createPortal(
    <div className="gt-toast-viewport" data-global-toast-root="true">
      {toasts.map((toast) => <ToastCard key={toast.id} toast={toast} tone={tone} />)}
    </div>,
    root,
  );
}

export default ToastProvider;
