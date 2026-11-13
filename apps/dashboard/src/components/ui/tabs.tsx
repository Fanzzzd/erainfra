import {
  Tabs as TabsPrimitive,
  TabsList as TabsListPrimitive,
  TabsPanel,
  TabsTab,
} from "@ui-sdk/react/tabs";
import type * as React from "react";

import { cn } from "@/lib/utils";

type TabsProps = Omit<
  React.ComponentProps<typeof TabsPrimitive>,
  "value" | "defaultValue" | "onValueChange"
> & {
  value?: string;
  defaultValue?: string;
  /** Called with the newly selected tab. A selection of nothing is not reported. */
  onValueChange?: (value: string) => void;
};

function Tabs({ className, onValueChange, ...props }: TabsProps) {
  return (
    <TabsPrimitive
      className={cn("flex flex-col gap-4", className)}
      onValueChange={(value) => {
        if (value !== null) onValueChange?.(value);
      }}
      {...props}
    />
  );
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsListPrimitive>) {
  return (
    <TabsListPrimitive
      className={cn(
        "inline-flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-border bg-sunken p-1",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsTab>) {
  return (
    <TabsTab
      className={cn(
        "inline-flex h-7 flex-1 cursor-default items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent px-2.5 text-(length:--era-text-sm) font-medium text-muted-foreground hover:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 data-selected:bg-card data-selected:text-foreground data-selected:border-border [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPanel>) {
  return <TabsPanel className={cn("flex-1", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
