import { Label as LabelPrimitive } from "@ui-sdk/react/label";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive>) {
  return (
    <LabelPrimitive
      className={cn(
        "flex select-none items-center gap-2 text-(length:--era-text-sm) font-medium leading-4 text-foreground group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
