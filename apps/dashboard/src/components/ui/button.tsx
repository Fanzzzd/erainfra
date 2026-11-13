import { renderElement } from "@ui-sdk/react/primitive";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { asChildElement } from "@/components/ui/slot";
import { cn } from "@/lib/utils";

/**
 * The shared Era button: control height and radius from the tokens, 12px of side padding,
 * `--era-text-md` at weight 500. `default` is the primary button on the product accent,
 * `outline` and `secondary` are the bordered secondary button, and `destructive` is the danger
 * button: danger text and border on the surface. A destructive dialog's confirm button is the
 * filled `danger` variant.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-default items-center justify-center gap-2 whitespace-nowrap rounded-md border text-(length:--era-text-md) font-medium leading-none disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "border-destructive bg-card text-destructive hover:bg-destructive-soft",
        danger:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border-input bg-card text-foreground hover:bg-sunken",
        secondary: "border-input bg-card text-foreground hover:bg-sunken",
        ghost: "border-transparent text-muted-foreground hover:bg-sunken hover:text-foreground",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-(--era-control-height) px-3",
        // Kept for the call sites that ask for it; every button shares the token height.
        sm: "h-(--era-control-height) px-3",
        icon: "size-(--era-control-height)",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Renders the single child element, such as a link, with the button's look and props. */
    asChild?: boolean;
  };

function Button({ className, variant, size, asChild = false, children, ...props }: ButtonProps) {
  const own = {
    "data-slot": "button",
    className: cn(buttonVariants({ variant, size, className })),
  };
  const child = asChildElement(asChild, children);
  return renderElement(
    "button",
    { ...own, ...props, children: child ? undefined : children },
    child,
  );
}

export { Button, buttonVariants };
