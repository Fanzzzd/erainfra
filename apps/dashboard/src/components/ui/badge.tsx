import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Class names for the Era badge. The tone variants use a 10% tint of the
 * status colour with the status colour as text; `check-contrast.mjs` checks
 * that pair in both themes.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border border-transparent px-1.5 text-xs font-medium whitespace-nowrap tabular-nums transition-colors has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/85",
        secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-muted",
        outline: "border-border text-foreground [a]:hover:bg-muted",
        product: "bg-product/10 text-product",
        success: "bg-success/10 text-success",
        warning: "bg-warning/10 text-warning",
        danger: "bg-danger/10 text-danger",
        info: "bg-info/10 text-info",
        neutral: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "secondary",
    },
  },
);

/** Props for {@link Badge}. */
type BadgeProps = useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

/**
 * A short label: a count, a stage or a state. Pass `render={<a href="…" />}`
 * to make it a link. For run, machine and health states use `StatusBadge`,
 * which picks the tone and label for you.
 */
function Badge({ className, variant = "secondary", render, ...props }: BadgeProps) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">({ className: cn(badgeVariants({ variant }), className) }, props),
    render,
    state: { slot: "badge", variant },
  });
}

export { Badge, badgeVariants, type BadgeProps };
