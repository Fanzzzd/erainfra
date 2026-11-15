import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const progressIndicatorVariants = cva("h-full rounded-full transition-[width]", {
  variants: {
    tone: {
      default: "bg-primary",
      product: "bg-product",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-danger",
    },
  },
  defaultVariants: { tone: "default" },
});

/** Props for {@link Progress}. */
type ProgressProps = ProgressPrimitive.Root.Props & {
  className?: string;
} & VariantProps<typeof progressIndicatorVariants>;

/**
 * A progress bar with an optional `ProgressLabel` and `ProgressValue` as
 * children. Pass `value={null}` while the total is unknown. `tone` colours
 * the bar, for example `danger` for a disk that is nearly full.
 */
function Progress({ className, children, tone = "default", ...props }: ProgressProps) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-tone={tone}
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", className)}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator className={progressIndicatorVariants({ tone })} />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

/** The bar's track. `Progress` renders it for you. */
function ProgressTrack({
  className,
  ...props
}: ProgressPrimitive.Track.Props & { className?: string }) {
  return (
    <ProgressPrimitive.Track
      data-slot="progress-track"
      className={cn(
        "relative flex h-1.5 w-full items-center overflow-hidden rounded-full bg-muted",
        className,
      )}
      {...props}
    />
  );
}

/** The filled part of the bar. `Progress` renders it for you. */
function ProgressIndicator({
  className,
  ...props
}: ProgressPrimitive.Indicator.Props & { className?: string }) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn(progressIndicatorVariants(), className)}
      {...props}
    />
  );
}

/** The visible name of the bar, linked to it for screen readers. */
function ProgressLabel({
  className,
  ...props
}: ProgressPrimitive.Label.Props & { className?: string }) {
  return (
    <ProgressPrimitive.Label
      data-slot="progress-label"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  );
}

/** The formatted value, at the end of the label row. */
function ProgressValue({
  className,
  ...props
}: ProgressPrimitive.Value.Props & { className?: string }) {
  return (
    <ProgressPrimitive.Value
      data-slot="progress-value"
      className={cn("ml-auto text-sm text-muted-foreground tabular-nums", className)}
      {...props}
    />
  );
}

export {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
  type ProgressProps,
};
