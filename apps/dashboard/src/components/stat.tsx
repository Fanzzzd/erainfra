import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Lays out 2, 3 or 4 stats so that no row has an empty slot or a lone stat.
 * It measures its own width: one column on a narrow container; 2 stats go
 * side by side from 28rem; 3 stats go in a row from 36rem; 4 stats make a
 * 2 by 2 grid from 28rem and a row from 56rem. 5 or more fill columns of at
 * least 14rem.
 */
function StatGroup({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="stat-group" className={cn("@container", className)} {...props}>
      <div
        data-slot="stat-group-grid"
        className={cn(
          "grid gap-3",
          "@md:has-[>:nth-child(2):last-child]:grid-cols-2",
          "@xl:has-[>:nth-child(3):last-child]:grid-cols-3",
          "@md:has-[>:nth-child(4):last-child]:grid-cols-2 @4xl:has-[>:nth-child(4):last-child]:grid-cols-4",
          "@md:has-[>:nth-child(5)]:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]",
        )}
      >
        {children}
      </div>
    </div>
  );
}

const statVariants = cva("grid grid-cols-[minmax(0,1fr)_auto] content-start gap-x-4 gap-y-1", {
  variants: {
    variant: {
      tile: "rounded-xl border bg-card p-4",
      plain: "",
    },
  },
  defaultVariants: { variant: "tile" },
});

/**
 * One number with its label and an optional hint and sparkline. It renders a
 * `<dl>`, so screen readers read the label with the value.
 *
 * @example
 * <Stat>
 *   <StatLabel>Slots in use</StatLabel>
 *   <StatValue>5<StatUnit>/14</StatUnit></StatValue>
 *   <StatHint>Across 3 machines</StatHint>
 * </Stat>
 */
function Stat({
  className,
  variant = "tile",
  ...props
}: React.ComponentProps<"dl"> & VariantProps<typeof statVariants>) {
  return <dl data-slot="stat" className={cn(statVariants({ variant }), className)} {...props} />;
}

/** What the number counts. */
function StatLabel({ className, ...props }: React.ComponentProps<"dt">) {
  return (
    <dt
      data-slot="stat-label"
      className={cn("col-start-1 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

/** The number, in tabular figures. */
function StatValue({ className, ...props }: React.ComponentProps<"dd">) {
  return (
    <dd
      data-slot="stat-value"
      className={cn(
        "col-start-1 text-2xl leading-tight font-semibold tracking-title tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

/** A unit or total after the value, such as "/14" or "GiB", in a lighter tone. */
function StatUnit({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="stat-unit"
      className={cn(
        "ml-0.5 text-base font-normal tracking-normal text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** A short line of context under the value. */
function StatHint({ className, ...props }: React.ComponentProps<"dd">) {
  return (
    <dd
      data-slot="stat-hint"
      className={cn("col-start-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

/** Props for {@link StatSparkline}. */
type StatSparklineProps = Omit<React.ComponentProps<"dd">, "children"> & {
  /** The series, oldest first. Two points or more. */
  values: readonly number[];
  /**
   * A text summary, such as "Runs per day, 28 to 41 over 7 days". Without it
   * the sparkline is hidden from screen readers, so say the trend in
   * `StatHint` instead.
   */
  label?: string;
};

/**
 * A small trend line in `--product`, at the right of the stat. Plain SVG, no
 * chart library.
 */
function StatSparkline({ values, label, className, ...props }: StatSparklineProps) {
  const gradient = React.useId();
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values.map(
    (v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - min) / span) * 28}`,
  );
  const line = points.join(" ");
  return (
    <dd
      data-slot="stat-sparkline"
      className={cn(
        "col-start-2 row-span-3 row-start-1 h-10 w-24 self-end text-product",
        className,
      )}
      {...props}
    >
      <svg
        viewBox="0 0 100 32"
        preserveAspectRatio="none"
        className="size-full overflow-visible"
        role={label ? "img" : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
      >
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.16" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,32 ${line} 100,32`} fill={`url(#${gradient})`} />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </dd>
  );
}

export {
  Stat,
  StatGroup,
  StatHint,
  StatLabel,
  StatSparkline,
  StatUnit,
  StatValue,
  statVariants,
  type StatSparklineProps,
};
