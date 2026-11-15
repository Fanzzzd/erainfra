import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A placeholder block for content that is loading. It pulses only when the
 * user allows motion. Mark the loading region with `aria-busy` yourself.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("rounded-md bg-muted motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}

export { Skeleton };
