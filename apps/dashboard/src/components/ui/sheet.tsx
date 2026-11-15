import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { usePortalContainer } from "@/lib/era-root";
import { cn } from "@/lib/utils";

/**
 * A panel that slides in from an edge: the mobile navigation, or details
 * next to a list. It behaves like `Dialog`: focus is trapped and Escape
 * closes it.
 */
function Sheet(props: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root {...props} />;
}

/** The element that opens the sheet. */
function SheetTrigger(props: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

/** Closes the sheet. */
function SheetClose(props: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

/** Portals into the `EraRoot` slot when there is one, else into `document.body`. */
function SheetPortal(props: SheetPrimitive.Portal.Props) {
  const container = usePortalContainer();
  return <SheetPrimitive.Portal container={container} {...props} />;
}

/** The icon button in the top right corner that closes the sheet. */
function SheetCloseButton({
  className,
  label = "Close",
  ...props
}: SheetPrimitive.Close.Props & { className?: string; label?: string }) {
  return (
    <SheetPrimitive.Close
      data-slot="sheet-close-button"
      aria-label={label}
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("absolute top-3 right-3", className)}
        />
      }
      {...props}
    >
      <XIcon aria-hidden="true" />
    </SheetPrimitive.Close>
  );
}

/** The dimmed layer behind the sheet. */
function SheetOverlay({
  className,
  ...props
}: SheetPrimitive.Backdrop.Props & { className?: string }) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-overlay transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

const sheetContentVariants = cva(
  "fixed z-50 flex flex-col gap-4 bg-popover text-sm text-popover-foreground shadow-xl transition-[transform,opacity] duration-200 ease-out outline-none data-ending-style:opacity-0 data-starting-style:opacity-0",
  {
    variants: {
      side: {
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l data-ending-style:translate-x-10 data-starting-style:translate-x-10 sm:max-w-sm",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-ending-style:-translate-x-10 data-starting-style:-translate-x-10 sm:max-w-sm",
        top: "inset-x-0 top-0 h-auto border-b data-ending-style:-translate-y-10 data-starting-style:-translate-y-10",
        bottom:
          "inset-x-0 bottom-0 h-auto border-t data-ending-style:translate-y-10 data-starting-style:translate-y-10",
      },
    },
    defaultVariants: { side: "right" },
  },
);

/** The sliding panel with its overlay. Add `SheetCloseButton` when it has no other close control. */
function SheetContent({
  className,
  side = "right",
  ...props
}: SheetPrimitive.Popup.Props & { className?: string } & VariantProps<
    typeof sheetContentVariants
  >) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(sheetContentVariants({ side }), className)}
        {...props}
      />
    </SheetPortal>
  );
}

/** Title and description at the top of the sheet. */
function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1 p-4 pr-12", className)}
      {...props}
    />
  );
}

/** Actions pinned to the bottom of the sheet. */
function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 border-t p-4", className)}
      {...props}
    />
  );
}

/** The sheet's name, announced on open. */
function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props & { className?: string }) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-heading text-base font-semibold tracking-title text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** A sentence under the title. */
function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props & { className?: string }) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  sheetContentVariants,
};
