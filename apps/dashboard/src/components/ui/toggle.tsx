import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/** Class names for the Era toggle, shared with `ToggleGroupItem`. */
const toggleVariants = cva(
  "group/toggle inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,border-color] select-none hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-muted data-pressed:text-foreground aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border-border bg-background data-pressed:bg-muted",
      },
      size: {
        default:
          "h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        sm: "h-7 min-w-7 rounded-md px-2 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 min-w-9 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/** Props for {@link Toggle}. */
type ToggleProps = TogglePrimitive.Props & VariantProps<typeof toggleVariants>;

/**
 * A button that stays pressed, such as Wrap lines or Show hidden. It reports
 * `aria-pressed`. An icon-only toggle needs an `aria-label`.
 */
function Toggle({ className, variant = "default", size = "default", ...props }: ToggleProps) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Toggle, toggleVariants, type ToggleProps };
