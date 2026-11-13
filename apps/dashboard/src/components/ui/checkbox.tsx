import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A checkbox with a 16px box and a 32px hit area. Set `indeterminate` for a
 * partly selected group, such as the select-all box of a table. Label it with
 * a `Field` or `aria-label`.
 */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props & { className?: string }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-field transition-colors after:absolute after:-inset-2 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:border-destructive data-invalid:border-destructive",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current [&>svg]:size-3.5"
        render={(indicatorProps, state) => (
          <span {...indicatorProps}>
            {state.indeterminate ? (
              <MinusIcon aria-hidden="true" />
            ) : (
              <CheckIcon aria-hidden="true" />
            )}
          </span>
        )}
      />
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
