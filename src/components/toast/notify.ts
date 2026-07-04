// Toast v2 — clean API on top of sonner.
// All variants share one "Classic Card with Icon Chip" visual.
// Light / dark handled purely in CSS via prefers-color-scheme.
import { toast as sonnerToast } from "sonner";
import type { ReactNode } from "react";

export type NotifyOpts = {
  id?: string | number;
  description?: string;
  duration?: number;
  icon?: ReactNode;
};

type Variant = "success" | "error" | "warning" | "info" | "loading";

function fire(variant: Variant, title: string, opts: NotifyOpts = {}) {
  const { id, description, duration, icon } = opts;
  const method =
    variant === "success" ? sonnerToast.success :
    variant === "error"   ? sonnerToast.error :
    variant === "warning" ? sonnerToast.warning :
    variant === "loading" ? sonnerToast.loading :
    sonnerToast.info;
  return method(title, {
    id,
    description,
    duration: duration ?? (variant === "loading" ? Infinity : 2800),
    icon,
    className: `tst-v-${variant}`,
  });
}

export const notify = {
  success: (title: string, opts?: NotifyOpts) => fire("success", title, opts),
  error:   (title: string, opts?: NotifyOpts) => fire("error", title, opts),
  warning: (title: string, opts?: NotifyOpts) => fire("warning", title, opts),
  info:    (title: string, opts?: NotifyOpts) => fire("info", title, opts),
  loading: (title: string, opts?: NotifyOpts) => fire("loading", title, opts),
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
  promise: sonnerToast.promise,
};

export default notify;
