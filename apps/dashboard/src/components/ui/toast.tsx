import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type * as React from "react";

import { usePortalContainer } from "@/lib/era-root";
import { cn } from "@/lib/utils";

/*
 * Why Base UI Toast and not Sonner: it comes with @base-ui/react, which every
 * Era primitive already uses, so there is no second behaviour library, no
 * next-themes, and no stylesheet injected at runtime. It portals into the
 * EraRoot slot like the other popups, announces through a live region, and
 * F6 moves focus into the toast landmark.
 */

/** The kinds of toast. Each has an icon and colour; `error` is announced at once. */
type ToastKind = "default" | "success" | "error" | "warning" | "info";

/** Options for {@link toast}. */
type ToastOptions = {
  description?: React.ReactNode;
  /** Milliseconds before it closes. `0` keeps it open. Defaults to 5000. */
  timeout?: number;
  /** A button in the toast, such as Undo. */
  action?: { label: string; onClick: () => void };
  /** Pass the id of an open toast to update it in place. */
  id?: string;
};

const manager = ToastPrimitive.createToastManager<{ kind?: ToastKind }>();

function show(kind: ToastKind, title: React.ReactNode, options: ToastOptions = {}): string {
  const { description, timeout, action, id } = options;
  return manager.add({
    title,
    type: kind,
    priority: kind === "error" ? "high" : "low",
    ...(description === undefined ? {} : { description }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(id === undefined ? {} : { id }),
    ...(action ? { actionProps: { children: action.label, onClick: action.onClick } } : {}),
  });
}

/**
 * Shows a toast from anywhere, including outside React. Returns its id.
 * Render one `<Toaster />` near the root of the app.
 *
 * @example
 * toast("Copied to clipboard")
 * toast.error("Could not cancel the run", { description: error.message })
 */
const toast = Object.assign(
  (title: React.ReactNode, options?: ToastOptions) => show("default", title, options),
  {
    success: (title: React.ReactNode, options?: ToastOptions) => show("success", title, options),
    error: (title: React.ReactNode, options?: ToastOptions) => show("error", title, options),
    warning: (title: React.ReactNode, options?: ToastOptions) => show("warning", title, options),
    info: (title: React.ReactNode, options?: ToastOptions) => show("info", title, options),
    /** Shows a loading toast that turns into success or error when the promise settles. */
    promise: <T,>(
      promise: Promise<T>,
      messages: {
        loading: string;
        success: string | ((value: T) => string);
        error: string | ((error: unknown) => string);
      },
    ) =>
      manager.promise(promise, {
        loading: { title: messages.loading, type: "default" },
        success: (value: T) => ({
          title:
            typeof messages.success === "function" ? messages.success(value) : messages.success,
          type: "success",
        }),
        error: (error: unknown) => ({
          title: typeof messages.error === "function" ? messages.error(error) : messages.error,
          type: "error",
          priority: "high",
        }),
      }),
    /** Closes one toast, or all of them. */
    dismiss: (id?: string) => manager.close(id),
  },
);

const icons: Record<ToastKind, React.ReactNode> = {
  default: null,
  success: <CircleCheckIcon aria-hidden="true" className="text-success" />,
  error: <CircleAlertIcon aria-hidden="true" className="text-danger" />,
  warning: <TriangleAlertIcon aria-hidden="true" className="text-warning" />,
  info: <InfoIcon aria-hidden="true" className="text-info" />,
};

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((item) => {
    const kind = (item.type ?? "default") as ToastKind;
    return (
      <ToastPrimitive.Root
        key={item.id}
        toast={item}
        data-slot="toast"
        data-kind={kind}
        className={cn(
          "absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full origin-bottom rounded-lg border bg-popover text-popover-foreground shadow-lg select-none",
          "[--gap:0.5rem] [--peek:0.5rem] [--scale:calc(max(0,1-(var(--toast-index)*0.05)))] [--shrink:calc(1-var(--scale))] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))]",
          "h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_0.4s_cubic-bezier(0.22,1,0.36,1),opacity_0.4s,height_0.15s]",
          "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
          "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
          "data-starting-style:[transform:translateY(150%)] data-ending-style:opacity-0 data-limited:opacity-0 [&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)]",
          "data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))] data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        )}
      >
        <ToastPrimitive.Content className="flex h-full items-start gap-2.5 overflow-hidden p-3 pr-2 transition-opacity duration-200 data-behind:opacity-0 data-expanded:opacity-100 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
          {icons[kind]}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <ToastPrimitive.Title className="text-sm font-medium" />
            <ToastPrimitive.Description className="text-sm text-muted-foreground" />
          </div>
          {item.actionProps ? (
            <ToastPrimitive.Action className="inline-flex h-7 shrink-0 items-center rounded-md border px-2.5 text-[0.8rem] font-medium hover:bg-muted" />
          ) : null}
          <ToastPrimitive.Close
            aria-label="Close"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&>svg]:size-4"
          >
            <XIcon aria-hidden="true" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Content>
      </ToastPrimitive.Root>
    );
  });
}

/** Props for {@link Toaster}. */
type ToasterProps = {
  /** How many toasts show at once. Older ones collapse behind. */
  limit?: number;
  /** Default milliseconds before a toast closes. */
  timeout?: number;
  className?: string;
};

/**
 * The stack where toasts appear, at the bottom right. Render it once near
 * the root of the app, or inside `EraRoot` for an embedded library. Hovering
 * or focusing the stack pauses the timers and fans it out.
 */
function Toaster({ limit = 3, timeout = 5000, className }: ToasterProps) {
  const container = usePortalContainer();
  return (
    <ToastPrimitive.Provider toastManager={manager} limit={limit} timeout={timeout}>
      <ToastPrimitive.Portal container={container}>
        <ToastPrimitive.Viewport
          data-slot="toaster"
          className={cn(
            "fixed right-4 bottom-4 z-[60] mx-auto w-[calc(100vw-2rem)] sm:right-6 sm:bottom-6 sm:w-90",
            className,
          )}
        >
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

export { toast, Toaster, type ToasterProps, type ToastKind, type ToastOptions };
