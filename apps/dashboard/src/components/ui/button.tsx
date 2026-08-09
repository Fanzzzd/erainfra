import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-emerald-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0b] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-emerald-300/20 bg-emerald-400 text-emerald-950 hover:bg-emerald-300",
        destructive: "border border-red-400/20 bg-red-500 text-white hover:bg-red-400",
        outline:
          "border border-white/[0.12] bg-transparent text-zinc-200 hover:bg-white/[0.05] hover:text-white",
        secondary:
          "border border-white/[0.08] bg-white/[0.06] text-zinc-200 hover:bg-white/[0.09] hover:text-white",
        ghost: "border border-transparent text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100",
        link: "text-emerald-300 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-8 px-2.5 text-xs",
        lg: "h-10 px-5",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
