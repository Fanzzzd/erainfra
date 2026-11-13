import { Loader2Icon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A spinning progress icon. It is decorative by default; pass `aria-label`
 * and `role="status"` when it is the only sign of progress. Under
 * `prefers-reduced-motion` it stops spinning.
 */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      aria-hidden={props["aria-label"] ? undefined : true}
      className={cn("size-4 motion-safe:animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
