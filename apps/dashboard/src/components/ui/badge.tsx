import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4 transition-colors duration-150",
  {
    variants: {
      variant: {
        default: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
        secondary: "border-white/[0.08] bg-white/[0.05] text-zinc-300",
        destructive: "border-red-400/20 bg-red-400/10 text-red-300",
        outline: "border-white/[0.1] bg-white/[0.025] text-zinc-400",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
