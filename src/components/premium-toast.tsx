import { toast } from "sonner";
import { CheckCircle2, Mail, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";

type Variant = "success" | "mail" | "info";

interface PremiumToastOpts {
  id?: string | number;
  duration?: number;
  description?: string;
  variant?: Variant;
  icon?: ReactNode;
}

/**
 * Classy, premium toast — obsidian glass card with a gold hairline accent,
 * elegant serif title, and a subtle animated shimmer. Replaces the generic
 * green success toast across the app.
 */
export function premiumToast(message: string, opts: PremiumToastOpts = {}) {
  const { id, duration = 2600, description, variant = "success", icon } = opts;

  const Icon =
    icon ??
    (variant === "mail" ? (
      <Mail className="w-4 h-4" strokeWidth={2.25} />
    ) : variant === "info" ? (
      <Sparkles className="w-4 h-4" strokeWidth={2.25} />
    ) : (
      <CheckCircle2 className="w-4 h-4" strokeWidth={2.25} />
    ));

  return toast.custom(
    (t) => (
      <div
        className="group pointer-events-auto relative w-[min(92vw,380px)] overflow-hidden rounded-2xl"
        style={{
          background:
            "linear-gradient(135deg, rgba(11,13,20,0.96) 0%, rgba(20,22,34,0.96) 55%, rgba(11,13,20,0.96) 100%)",
          border: "1px solid rgba(212,175,110,0.28)",
          boxShadow:
            "0 20px 50px -20px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.03) inset, 0 1px 0 rgba(255,255,255,0.05) inset",
          backdropFilter: "blur(14px)",
        }}
      >
        {/* Top gold hairline */}
        <div
          className="absolute inset-x-0 top-0 h-px"
          style={{
            background:
              "linear-gradient(90deg, transparent 0%, rgba(212,175,110,0.7) 50%, transparent 100%)",
          }}
        />
        {/* Ambient radial glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-16 -right-10 h-40 w-40 rounded-full opacity-40 blur-2xl"
          style={{ background: "radial-gradient(circle, rgba(212,175,110,0.35), transparent 70%)" }}
        />

        <div className="relative flex items-start gap-3 p-3.5 pr-9">
          <div
            className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-xl"
            style={{
              background:
                "linear-gradient(135deg, rgba(212,175,110,0.18), rgba(212,175,110,0.06))",
              border: "1px solid rgba(212,175,110,0.35)",
              color: "#e8d3a1",
              boxShadow: "0 0 22px -6px rgba(212,175,110,0.55)",
            }}
          >
            {Icon}
          </div>
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-[13.5px] font-semibold tracking-tight"
              style={{
                color: "#f4ead2",
                fontFamily:
                  '"Cormorant Garamond", "Playfair Display", ui-serif, Georgia, serif',
                fontSize: "16px",
                letterSpacing: "0.005em",
              }}
            >
              {message}
            </p>
            {description && (
              <p className="mt-0.5 truncate text-[11.5px] text-slate-400/90">{description}</p>
            )}
          </div>
          <button
            onClick={() => toast.dismiss(t)}
            aria-label="Dismiss"
            className="absolute right-2.5 top-2.5 rounded-md p-1 text-slate-500 opacity-0 transition-all hover:text-slate-200 group-hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Progress hairline */}
        <div
          className="absolute inset-x-0 bottom-0 h-[2px] origin-left"
          style={{
            background:
              "linear-gradient(90deg, rgba(212,175,110,0.9) 0%, rgba(232,211,161,0.6) 60%, rgba(212,175,110,0) 100%)",
            animation: `premium-toast-bar ${duration}ms linear forwards`,
          }}
        />
        <style>{`@keyframes premium-toast-bar { from { transform: scaleX(1) } to { transform: scaleX(0) } }`}</style>
      </div>
    ),
    { id, duration }
  );
}

export default premiumToast;
