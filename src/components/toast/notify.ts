// Global toast store — framework-free, single source of truth for all
// user + admin surfaces. No external toast library. Full-text friendly.

export type ToastVariant = "success" | "error" | "warning" | "info" | "loading";

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type NotifyOpts = {
  id?: string | number;
  description?: string;
  duration?: number;
  action?: ToastAction;
};

export type GlobalToast = {
  id: string | number;
  title: string;
  description?: string;
  variant: ToastVariant;
  duration: number;
  createdAt: number;
  action?: ToastAction;
};

type Listener = (items: GlobalToast[]) => void;

const listeners = new Set<Listener>();
const timers = new Map<string | number, number>();
let items: GlobalToast[] = [];
let seed = 0;

const MAX_VISIBLE = 3;
const DEFAULT_DURATION = 4200;
const LOADING_DURATION = Number.POSITIVE_INFINITY;

function snapshot() {
  return items.slice();
}

function publish() {
  const next = snapshot();
  listeners.forEach((listener) => listener(next));
}

function clearTimer(id: string | number) {
  const timer = timers.get(id);
  if (timer) window.clearTimeout(timer);
  timers.delete(id);
}

function scheduleDismiss(id: string | number, duration: number) {
  clearTimer(id);
  if (!Number.isFinite(duration) || duration <= 0 || typeof window === "undefined") return;
  timers.set(id, window.setTimeout(() => notify.dismiss(id), duration));
}

function fire(variant: ToastVariant, title: string, opts: NotifyOpts = {}) {
  const id = opts.id ?? `gt-${Date.now()}-${++seed}`;
  const duration = opts.duration ?? (variant === "loading" ? LOADING_DURATION : DEFAULT_DURATION);
  const toast: GlobalToast = {
    id,
    title: title || "",
    description: opts.description,
    variant,
    duration,
    createdAt: Date.now(),
    action: opts.action,
  };
  items = [toast, ...items.filter((item) => item.id !== id)].slice(0, MAX_VISIBLE);
  scheduleDismiss(id, duration);
  publish();
  return id;
}

export const toastStore = {
  subscribe(listener: Listener) {
    listeners.add(listener);
    listener(snapshot());
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: snapshot,
};

export const notify = {
  success: (title: string, opts?: NotifyOpts) => fire("success", title, opts),
  error:   (title: string, opts?: NotifyOpts) => fire("error", title, opts),
  warning: (title: string, opts?: NotifyOpts) => fire("warning", title, opts),
  info:    (title: string, opts?: NotifyOpts) => fire("info", title, opts),
  loading: (title: string, opts?: NotifyOpts) => fire("loading", title, opts),
  dismiss(id?: string | number) {
    if (id === undefined) {
      items.forEach((item) => clearTimer(item.id));
      items = [];
    } else {
      clearTimer(id);
      items = items.filter((item) => item.id !== id);
    }
    publish();
    return id;
  },
  promise<T>(promise: Promise<T>, messages: {
    loading?: string;
    success?: string | ((data: T) => string);
    error?: string | ((error: unknown) => string);
    description?: string;
    id?: string | number;
  }) {
    const id = fire("loading", messages.loading || "Loading…", {
      id: messages.id,
      description: messages.description,
    });
    promise
      .then((data) => {
        const title = typeof messages.success === "function" ? messages.success(data) : messages.success;
        fire("success", title || "Done", { id, duration: DEFAULT_DURATION });
      })
      .catch((error) => {
        const title = typeof messages.error === "function" ? messages.error(error) : messages.error;
        fire("error", title || "Something went wrong", { id, duration: DEFAULT_DURATION });
      });
    return id;
  },
};

export default notify;
