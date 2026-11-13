import {
  Tooltip as TooltipPrimitive,
  TooltipContent as TooltipContentPrimitive,
  TooltipTrigger as TooltipTriggerPrimitive,
} from "@ui-sdk/react/tooltip";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";

import { asChildElement } from "@/components/ui/slot";
import { cn } from "@/lib/utils";

/**
 * ui-sdk groups tooltips without a provider: once one is open, the next opens at once. The
 * provider here only sets the hover delay for the tooltips inside it.
 */
const TooltipDelay = createContext(120);

function TooltipProvider({
  delayDuration = 120,
  children,
}: {
  delayDuration?: number;
  children?: ReactNode;
}) {
  return <TooltipDelay value={delayDuration}>{children}</TooltipDelay>;
}

function Tooltip({ delay, ...props }: ComponentProps<typeof TooltipPrimitive>) {
  const providerDelay = useContext(TooltipDelay);
  return <TooltipPrimitive delay={delay ?? providerDelay} {...props} />;
}

/** `asChild` makes the single child element, such as a link, the trigger. */
function TooltipTrigger({
  asChild = false,
  children,
  ...props
}: ComponentProps<typeof TooltipTriggerPrimitive> & { asChild?: boolean }) {
  const child = asChildElement(asChild, children);
  if (child) return <TooltipTriggerPrimitive render={child} {...props} />;
  return <TooltipTriggerPrimitive {...props}>{children}</TooltipTriggerPrimitive>;
}

function TooltipContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof TooltipContentPrimitive>) {
  return (
    <TooltipContentPrimitive
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "z-50 w-fit max-w-xs origin-(--transform-origin) text-balance rounded-md border border-border bg-popover px-2 py-1 text-left text-(length:--era-text-xs) font-normal normal-case leading-4 tracking-normal text-popover-foreground shadow-popup transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-95 data-starting-style:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
