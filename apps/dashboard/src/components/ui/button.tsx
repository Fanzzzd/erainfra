import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Class names for the Era button. Use them to style a link or another element
 * as a button when `render` does not fit.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,opacity] select-none motion-safe:active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/85",
        outline: "border-border bg-background hover:bg-muted aria-expanded:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklab,var(--secondary),var(--foreground)_6%)] aria-expanded:bg-[color-mix(in_oklab,var(--secondary),var(--foreground)_6%)]",
        ghost: "hover:bg-muted aria-expanded:bg-muted",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        link: "h-auto! px-0! text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-md px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        icon: "size-8",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-md",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/** Props for {@link Button}: Base UI button props plus the Era variants. */
type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

/**
 * A button. Icon-only buttons need an `aria-label`. Mark a leading or
 * trailing icon with `data-icon="inline-start"` or `"inline-end"` to tighten
 * the padding on that side. Show progress by composing a `Spinner` and
 * `disabled`, not with a loading prop.
 */
function Button({ className, variant = "default", size = "default", ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants, type ButtonProps };
