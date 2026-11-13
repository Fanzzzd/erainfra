import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A multi-line text input that grows with its content. It joins a `Field`
 * like `Input` does, and has the same edge and states.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <InputPrimitive
      data-slot="textarea"
      render={<textarea {...props} />}
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-field px-2.5 py-2 text-base transition-colors placeholder:text-muted-foreground focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-invalid:border-destructive md:text-sm",
        className,
      )}
    />
  );
}

export { Textarea };
