import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** The colour of a state. `product` is the running colour of the current product. */
type StatusTone = "product" | "success" | "warning" | "danger" | "info" | "neutral";

/** How one state looks and reads. */
type StatusDefinition = {
  label: string;
  tone: StatusTone;
  /** A hollow dot for states that have not started. */
  hollow?: boolean;
  /** A slow pulse for states that are in progress. Off under reduced motion. */
  pulse?: boolean;
};

/** Job and run attempt states, as EraInfra reports them. */
const runStates = {
  queued: { label: "Queued", tone: "neutral", hollow: true },
  pending: { label: "Pending", tone: "neutral", hollow: true },
  preparing: { label: "Preparing", tone: "warning", pulse: true },
  running: { label: "Running", tone: "product", pulse: true },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral", hollow: true },
} as const satisfies Record<string, StatusDefinition>;

/** Machine, device and peer states across EraInfra and EraMesh. */
const machineStates = {
  online: { label: "Online", tone: "success" },
  offline: { label: "Offline", tone: "neutral", hollow: true },
  connecting: { label: "Connecting", tone: "warning", pulse: true },
  draining: { label: "Draining", tone: "warning" },
  busy: { label: "Busy", tone: "product" },
  idle: { label: "Idle", tone: "neutral" },
} as const satisfies Record<string, StatusDefinition>;

/** Health of a service, a sync or a check. */
const healthStates = {
  healthy: { label: "Healthy", tone: "success" },
  degraded: { label: "Degraded", tone: "warning" },
  unhealthy: { label: "Unhealthy", tone: "danger" },
  unknown: { label: "Unknown", tone: "neutral", hollow: true },
} as const satisfies Record<string, StatusDefinition>;

/**
 * Every state an Era product shows, keyed by the word the product's API
 * uses. Add a state here, in the registry, so all three products show it the
 * same way.
 */
const statusStates = { ...runStates, ...machineStates, ...healthStates } satisfies Record<
  string,
  StatusDefinition
>;

type RunState = keyof typeof runStates;
type MachineState = keyof typeof machineStates;
type HealthState = keyof typeof healthStates;
/** Any state in {@link statusStates}. */
type StatusState = keyof typeof statusStates;

const statusDotVariants = cva("relative inline-block size-2 shrink-0 rounded-full", {
  variants: {
    tone: {
      product: "bg-product",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-danger",
      info: "bg-info",
      neutral: "bg-muted-foreground",
    },
    hollow: {
      true: "border-[1.5px] bg-transparent",
      false: "",
    },
    pulse: {
      true: "motion-safe:animate-pulse",
      false: "",
    },
  },
  compoundVariants: [
    { hollow: true, tone: "product", className: "border-product" },
    { hollow: true, tone: "success", className: "border-success" },
    { hollow: true, tone: "warning", className: "border-warning" },
    { hollow: true, tone: "danger", className: "border-danger" },
    { hollow: true, tone: "info", className: "border-info" },
    { hollow: true, tone: "neutral", className: "border-muted-foreground" },
  ],
  defaultVariants: { tone: "neutral", hollow: false, pulse: false },
});

/** A coloured dot. Decorative; always show the state in words next to it. */
function StatusDot({
  className,
  tone,
  hollow,
  pulse,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statusDotVariants>) {
  return (
    <span
      data-slot="status-dot"
      aria-hidden="true"
      className={cn(statusDotVariants({ tone, hollow, pulse }), className)}
      {...props}
    />
  );
}

/** Props for {@link Status} and {@link StatusBadge}. */
type StatusProps = Omit<React.ComponentProps<"span">, "children"> & {
  state: StatusState;
  /** Replaces the default label, for example "Failed after 3 attempts". */
  children?: React.ReactNode;
};

/**
 * A state as a dot and a label, for table cells and lists. Failed and
 * unhealthy labels are in `--danger` as well, so they stand out without the
 * dot.
 */
function Status({ state, className, children, ...props }: StatusProps) {
  const def: StatusDefinition = statusStates[state];
  return (
    <span
      data-slot="status"
      data-state={state}
      data-tone={def.tone}
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap data-[tone=danger]:text-danger",
        className,
      )}
      {...props}
    >
      <StatusDot tone={def.tone} hollow={def.hollow ?? false} pulse={def.pulse ?? false} />
      {children ?? def.label}
    </span>
  );
}

/** A state as a tinted badge with a dot, for headers and summaries. */
function StatusBadge({ state, className, children, ...props }: StatusProps) {
  const def: StatusDefinition = statusStates[state];
  return (
    <Badge variant={def.tone} data-state={state} className={cn("gap-1.5", className)} {...props}>
      <StatusDot tone={def.tone} hollow={def.hollow ?? false} className="size-1.5" />
      {children ?? def.label}
    </Badge>
  );
}

export {
  LiveIndicator,
  Status,
  StatusBadge,
  StatusDot,
  healthStates,
  machineStates,
  runStates,
  statusDotVariants,
  statusStates,
  type HealthState,
  type MachineState,
  type RunState,
  type StatusDefinition,
  type StatusProps,
  type StatusState,
  type StatusTone,
};

/** A "Live" label with a pulsing dot in `--product`, for pages that update on their own. */
function LiveIndicator({ className, children, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="live-indicator"
      className={cn("inline-flex items-center gap-2 text-[13px] text-muted-foreground", className)}
      {...props}
    >
      <StatusDot tone="product" pulse />
      {children ?? "Live"}
    </span>
  );
}
