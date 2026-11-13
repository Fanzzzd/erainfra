import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const switchVariants = cva(
  "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent p-px transition-colors after:absolute after:-inset-x-2 after:-inset-y-2 data-checked:bg-primary data-unchecked:bg-input data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:border-destructive",
  {
    variants: {
      size: {
        default: "h-5 w-9 [--thumb:--spacing(4)]",
        sm: "h-4 w-7 [--thumb:--spacing(3)]",
      },
    },
    defaultVariants: { size: "default" },
  },
);

/**
 * An on and off switch for a setting that applies at once. Use a checkbox
 * when the change waits for a submit button.
 */
function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & { className?: string } & VariantProps<typeof switchVariants>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(switchVariants({ size }), className)}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-(--thumb) rounded-full bg-background transition-transform data-checked:translate-x-[calc(var(--thumb)*0.9+1px)] data-checked:bg-primary-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
