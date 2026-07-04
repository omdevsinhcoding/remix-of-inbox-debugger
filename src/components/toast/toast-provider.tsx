// Toast v2 provider — mounts Sonner with fresh, unstyled class hooks.
// Positioned top-center on mobile (safe-area aware), bottom-right on desktop.
import { Toaster } from "sonner";
import { useEffect, useState } from "react";

export function ToastProvider() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  return (
    <Toaster
      position={isMobile ? "top-center" : "bottom-right"}
      closeButton
      expand={false}
      visibleToasts={1}
      duration={2800}
      gap={8}
      offset={isMobile ? "calc(env(safe-area-inset-top) + 0.75rem)" : "1.25rem"}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "tst-toast group",
          title: "tst-toast-title",
          description: "tst-toast-desc",
          icon: "tst-toast-icon",
          closeButton: "tst-toast-close",
          success: "tst-v-success",
          error: "tst-v-error",
          info: "tst-v-info",
          warning: "tst-v-warning",
          loading: "tst-v-loading",
        },
      }}
    />
  );
}

export default ToastProvider;
