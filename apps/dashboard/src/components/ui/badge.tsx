import { renderElement } from "@ui-sdk/react/primitive";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { asChildElement } from "@/components/ui/slot";
import { cn } from "@/lib/utils";

/**
 * The console leans on badges to carry state, so the tonal variants below are
 * part of the vocabulary rather than decoration: `success` reads as proven,
 * `warning` as "works, with a caveat an operator must know", `destructive` as
 * broken. Anything neutral stays `outline`. Each tone is the Era status pair:
 * the `*-soft` background with the matching status text colour.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-(length:--era-text-xs) font-semibold leading-4 tabular-nums [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary-soft text-primary",
        secondary: "bg-sunken text-muted-foreground",
        outline: "bg-sunken text-muted-foreground",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        info: "bg-info-soft text-info",
        destructive: "bg-destructive-soft text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  children,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const own = { "data-slot": "badge", className: cn(badgeVariants({ variant }), className) };
  const child = asChildElement(asChild, children);
  return renderElement("span", { ...own, ...props, children: child ? undefined : children }, child);
}

export { Badge, badgeVariants };
