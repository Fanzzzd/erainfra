import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

import { toggleVariants } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

type ToggleGroupContextValue = VariantProps<typeof toggleVariants> & { spacing: number };

const ToggleGroupContext = React.createContext<ToggleGroupContextValue>({
  size: "default",
  variant: "default",
  spacing: 0,
});

/** Props for {@link ToggleGroup}. */
type ToggleGroupProps = ToggleGroupPrimitive.Props &
  VariantProps<typeof toggleVariants> & {
    /** The gap between items in Tailwind spacing units. 0 joins them into one segmented control. */
    spacing?: number;
  };

/**
 * A row of toggles. By default one item is pressed at a time, as in a
 * segmented control for a view or a time range; set `multiple` to allow
 * several. Arrow keys move between the items. Name the group with
 * `aria-label`.
 */
function ToggleGroup({
  className,
  variant = "default",
  size = "default",
  spacing = 0,
  orientation = "horizontal",
  children,
  ...props
}: ToggleGroupProps) {
  const context = React.useMemo(() => ({ variant, size, spacing }), [variant, size, spacing]);
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      orientation={orientation}
      style={{ "--gap": spacing } as React.CSSProperties}
      className={cn(
        "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-lg data-vertical:flex-col data-vertical:items-stretch",
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={context}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  );
}

/** One item of a {@link ToggleGroup}. It takes the group's variant and size. */
function ToggleGroupItem({ className, ...props }: TogglePrimitive.Props) {
  const { variant, size, spacing } = React.useContext(ToggleGroupContext);
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      className={cn(
        toggleVariants({ variant, size }),
        "focus-visible:z-10",
        spacing === 0 &&
          "rounded-none group-data-horizontal/toggle-group:first:rounded-l-lg group-data-horizontal/toggle-group:last:rounded-r-lg group-data-vertical/toggle-group:first:rounded-t-lg group-data-vertical/toggle-group:last:rounded-b-lg",
        spacing === 0 &&
          variant === "outline" &&
          "group-data-horizontal/toggle-group:-ml-px group-data-horizontal/toggle-group:first:ml-0 group-data-vertical/toggle-group:-mt-px group-data-vertical/toggle-group:first:mt-0",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem, type ToggleGroupProps };
