import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "@/lib/utils";

/**
 * A set of options where exactly one is chosen. Arrow keys move between the
 * options. Name the group with `aria-label`, or put it in a `FieldSet` with a
 * `FieldLegend`, and label each item with a `Field` and `FieldLabel`.
 */
function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full gap-3", className)}
      {...props}
    />
  );
}

/** One option: a 16px circle with a 32px hit area, filled when chosen. */
function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-field transition-colors after:absolute after:-inset-2 data-checked:border-primary data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:border-destructive data-invalid:border-destructive",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="size-1.5 rounded-full bg-primary-foreground"
      />
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
