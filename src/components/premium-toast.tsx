import { toast } from "sonner";
import { AlertCircle, CheckCircle2, Mail, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";

type Variant = "success" | "mail" | "info" | "error";

interface PremiumToastOpts {
  id?: string | number;
  duration?: number;
  description?: string;
  variant?: Variant;
  icon?: ReactNode;
}

export function premiumToast(message: string, opts: PremiumToastOpts = {}) {
  const { id, duration = 2600, description, variant = "success", icon } = opts;

  const Icon =
    icon ??
    (variant === "mail" ? (
      <Mail className="w-4 h-4" strokeWidth={2.25} />
    ) : variant === "error" ? (
      <AlertCircle className="w-4 h-4" strokeWidth={2.25} />
    ) : variant === "info" ? (
      <Sparkles className="w-4 h-4" strokeWidth={2.25} />
    ) : (
      <CheckCircle2 className="w-4 h-4" strokeWidth={2.25} />
    ));

  return toast(message, {
    id,
    duration,
    description,
    icon: Icon,
    className: `cx-v-${variant}`,
  });
}

export default premiumToast;
