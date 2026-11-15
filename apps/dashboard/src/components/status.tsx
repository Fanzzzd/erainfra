import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The colour of a state: `neutral`, `info`, `success`, `warning`, `danger`,
 * or `product`, the running colour of the current product. Each one meets
 * 4.5:1 as text on its 10% tint, so a badge in any tone is readable.
 */
type StatusTone = "product" | "success" | "warning" | "danger" | "info" | "neutral";

/** How one state looks and reads. */
type StatusDefinition = {
  /** The word the interface shows, such as "Deploying". */
  label: string;
  tone: StatusTone;
  /** A hollow dot for states that are pending or have not started. */
  hollow?: boolean;
  /** A slow pulse for states that are in progress. Off under reduced motion. */
  pulse?: boolean;
};

/** A product's states, keyed by the word its API uses. */
type StatusMap = Record<string, StatusDefinition>;

/**
 * Declares a product's own states against the Era tones, with their keys
 * kept as literal types so `<Status states={…} state="…" />` checks the
 * state. Built-in states can be mixed in by spreading {@link statusStates}.
 *
 * @example
 * const deployStates = defineStatusStates({
 *   deploying: { label: "Deploying", tone: "product", pulse: true },
 *   firing: { label: "Firing", tone: "danger" },
 *   delivered: { label: "Delivered", tone: "success" },
 *   waiting: { label: "Waiting for approval", tone: "warning", hollow: true },
 * });
 * <Status states={deployStates} state="deploying" />
 */
function defineStatusStates<const S extends StatusMap>(states: S): S {
  return states;
}

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
      // The border colour shows only on a hollow dot, which sets a border width.
      product: "border-product bg-product",
      success: "border-success bg-success",
      warning: "border-warning bg-warning",
      danger: "border-danger bg-danger",
      info: "border-info bg-info",
      neutral: "border-muted-foreground bg-muted-foreground",
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
type StatusProps<S extends StatusMap = typeof statusStates> = Omit<
  React.ComponentProps<"span">,
  "children"
> & {
  /** A key of `states`, or of the built-in {@link statusStates} without it. */
  state: NoInfer<keyof S & string>;
  /** The product's own states from {@link defineStatusStates}. Defaults to the built-in ones. */
  states?: S;
  /** Replaces the default label, for example "Failed after 3 attempts". */
  children?: React.ReactNode;
};

/** The definition of `state`, from `states` or the built-in map. */
function definitionOf(state: string, states: StatusMap | undefined): StatusDefinition {
  const map: StatusMap = states ?? statusStates;
  return map[state] ?? { label: state, tone: "neutral" };
}

/**
 * A state as a dot and a label, for table cells and lists. Failed and
 * unhealthy labels are in `--danger` as well, so they stand out without the
 * dot.
 */
function Status<S extends StatusMap = typeof statusStates>({
  state,
  states,
  className,
  children,
  ...props
}: StatusProps<S>) {
  const def = definitionOf(state, states);
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
function StatusBadge<S extends StatusMap = typeof statusStates>({
  state,
  states,
  className,
  children,
  ...props
}: StatusProps<S>) {
  const def = definitionOf(state, states);
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
  defineStatusStates,
  healthStates,
  machineStates,
  runStates,
  statusDotVariants,
  statusStates,
  type HealthState,
  type MachineState,
  type RunState,
  type StatusDefinition,
  type StatusMap,
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
