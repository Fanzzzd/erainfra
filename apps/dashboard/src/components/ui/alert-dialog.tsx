import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { usePortalContainer } from "@/lib/era-root";
import { cn } from "@/lib/utils";

/**
 * A modal that asks the user to confirm or cancel. Clicking outside does not
 * close it, so the user has to choose. For the common destructive case use
 * `ConfirmDialog`, which adds typed confirmation and a pending state.
 */
function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root {...props} />;
}

/** The element that opens the alert dialog. */
function AlertDialogTrigger(props: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

/** Portals into the `EraRoot` slot when there is one, else into `document.body`. */
function AlertDialogPortal(props: AlertDialogPrimitive.Portal.Props) {
  const container = usePortalContainer();
  return <AlertDialogPrimitive.Portal container={container} {...props} />;
}

/** The dimmed layer behind the alert dialog. */
function AlertDialogOverlay({
  className,
  ...props
}: AlertDialogPrimitive.Backdrop.Props & { className?: string }) {
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-overlay duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

/** The alert dialog panel with its overlay. */
function AlertDialogContent({
  className,
  ...props
}: AlertDialogPrimitive.Popup.Props & { className?: string }) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-popover p-5 text-sm text-popover-foreground shadow-xl duration-150 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

/** Title and description, stacked. */
function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  );
}

/** The action row. Cancel first, the confirming action last. */
function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "-mx-5 -mb-5 flex flex-col-reverse gap-2 border-t bg-subtle px-5 py-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

/** The question, for example "Remove runner-01?". */
function AlertDialogTitle({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props & { className?: string }) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("font-heading text-base leading-snug font-semibold tracking-title", className)}
      {...props}
    />
  );
}

/** What happens if the user confirms, and whether it can be undone. */
function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props & { className?: string }) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-sm text-pretty text-muted-foreground", className)}
      {...props}
    />
  );
}

/** The confirming button. It does not close the dialog by itself, so async work can finish first. */
function AlertDialogAction(props: React.ComponentProps<typeof Button>) {
  return <Button data-slot="alert-dialog-action" {...props} />;
}

/** Closes the dialog without acting. Focus starts here, the safe choice. */
function AlertDialogCancel({
  variant = "outline",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
