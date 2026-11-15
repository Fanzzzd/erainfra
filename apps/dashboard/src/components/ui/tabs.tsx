import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Tabs with arrow-key navigation between triggers. Use the `line` list for
 * filters and page sections, and the default segmented list for small
 * switches inside a panel.
 */
function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props & { className?: string }) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn("group/tabs flex gap-2 data-horizontal:flex-col", className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list relative inline-flex w-fit items-center text-muted-foreground group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:items-stretch",
  {
    variants: {
      variant: {
        default: "h-8 rounded-lg bg-muted p-[3px]",
        line: "h-9 gap-1",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

/** The row of triggers. Give it an `aria-label` when the page has no heading for it. */
function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & { className?: string } & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

/**
 * One tab. A count goes in a `Badge` after the label. In a `line` list the
 * active tab gets a 2px underline in `--product`.
 */
function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props & { className?: string }) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 text-sm font-medium whitespace-nowrap transition-colors hover:text-foreground data-active:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=default]/tabs-list:data-active:bg-background group-data-[variant=default]/tabs-list:data-active:shadow-xs group-data-[variant=default]/tabs-list:data-active:ring-1 group-data-[variant=default]/tabs-list:data-active:ring-border",
        "group-data-[variant=line]/tabs-list:focus-visible:-outline-offset-2",
        "after:absolute after:rounded-full after:bg-product after:opacity-0 after:transition-opacity group-data-[variant=line]/tabs-list:data-active:after:opacity-100 group-data-horizontal/tabs:after:inset-x-1 group-data-horizontal/tabs:after:-bottom-px group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-1 group-data-vertical/tabs:after:-left-px group-data-vertical/tabs:after:w-0.5",
        className,
      )}
      {...props}
    />
  );
}

/** The panel for one tab. It is focusable so keyboard users can reach its content. */
function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props & { className?: string }) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm focus-visible:outline-offset-4", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
