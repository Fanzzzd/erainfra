import type * as React from "react";

import { cn } from "@/lib/utils";

/** The shared Era input: control height and radius, the surface, a 1px strong border. */
const inputClass =
  "flex h-(--era-control-height) w-full min-w-0 rounded-md border border-input bg-card px-2.5 text-(length:--era-text-md) text-foreground placeholder:text-subtle-foreground file:h-6 file:border-0 file:bg-transparent file:text-(length:--era-text-md) file:font-medium disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(inputClass, className)} {...props} />;
}

export { Input, inputClass };
