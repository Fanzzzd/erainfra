import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { usePortalContainer } from "@/lib/era-root";
import { cn } from "@/lib/utils";

/**
 * A modal dialog for a task that needs the user's full attention, such as a
 * form. Focus moves inside on open, stays there, and returns to the trigger on
 * close; Escape closes it. For a destructive confirmation use `AlertDialog`
 * or `ConfirmDialog`.
 *
 * When you control `open`, `onOpenChange` runs only for changes the dialog
 * makes (a trigger, Escape, an outside click, a close button), not when you
 * set `open` yourself. Keep form state in a component inside `DialogContent`,
 * which mounts on each open, or reset it in `onOpenChangeComplete`, which
 * runs for every change.
 */
function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root {...props} />;
}

/** The element that opens the dialog. Pass `render={<Button />}` to style it. */
function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

/** Portals into the `EraRoot` slot when there is one, else into `document.body`. */
function DialogPortal(props: DialogPrimitive.Portal.Props) {
  const container = usePortalContainer();
  return <DialogPrimitive.Portal container={container} {...props} />;
}

/** Closes the dialog. Pass `render={<Button variant="outline" />}` for a Cancel button. */
function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** The icon button in the top right corner that closes the dialog. */
function DialogCloseButton({
  className,
  label = "Close",
  ...props
}: DialogPrimitive.Close.Props & { className?: string; label?: string }) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close-button"
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
    </DialogPrimitive.Close>
  );
}

/** The dimmed layer behind the dialog. `DialogContent` renders it for you. */
function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props & { className?: string }) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-overlay duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

const dialogContentVariants = cva(
  "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border bg-popover p-5 text-sm text-popover-foreground shadow-xl duration-150 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
  {
    variants: {
      size: {
        sm: "sm:max-w-sm",
        default: "sm:max-w-lg",
        lg: "sm:max-w-2xl",
      },
    },
    defaultVariants: { size: "default" },
  },
);

/**
 * The dialog panel with its overlay. Compose `DialogHeader`, the body,
 * `DialogFooter` and, when the dialog has no Cancel button, `DialogCloseButton`.
 */
function DialogContent({
  className,
  size = "default",
  ...props
}: DialogPrimitive.Popup.Props & { className?: string } & VariantProps<
    typeof dialogContentVariants
  >) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        data-size={size}
        className={cn(dialogContentVariants({ size }), className)}
        {...props}
      />
    </DialogPortal>
  );
}

/** Title and description, stacked. */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 pr-8", className)}
      {...props}
    />
  );
}

/** The action row on the subtle surface. The primary action goes last. */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-5 -mb-5 flex flex-col-reverse gap-2 border-t bg-subtle px-5 py-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

/** The dialog's name. Screen readers announce it on open. */
function DialogTitle({
  className,
  ...props
}: DialogPrimitive.Title.Props & { className?: string }) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-heading text-base leading-snug font-semibold tracking-title", className)}
      {...props}
    />
  );
}

/** One or two sentences under the title, announced after it. */
function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props & { className?: string }) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  dialogContentVariants,
};
