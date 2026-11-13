import {
  Dialog as DialogPrimitive,
  DialogBackdrop,
  DialogClose as DialogClosePrimitive,
  DialogContent as DialogContentPrimitive,
  DialogDescription as DialogDescriptionPrimitive,
  DialogTitle as DialogTitlePrimitive,
  DialogTrigger as DialogTriggerPrimitive,
} from "@ui-sdk/react/dialog";
import { XIcon } from "lucide-react";
import { Fragment, type ComponentProps, type ReactNode } from "react";

import { asChildElement } from "@/components/ui/slot";
import { cn } from "@/lib/utils";

/**
 * ui-sdk dialogs open in the browser's top layer, in place in the tree, so a dialog needs no
 * portal. The backdrop and content still escape any `overflow` or stacking context around them.
 */
function Dialog(props: ComponentProps<typeof DialogPrimitive>) {
  return <DialogPrimitive {...props} />;
}

/** `asChild` makes the single child element, such as a Button, the trigger. */
function DialogTrigger({
  asChild = false,
  children,
  ...props
}: ComponentProps<typeof DialogTriggerPrimitive> & { asChild?: boolean }) {
  const child = asChildElement(asChild, children);
  if (child) return <DialogTriggerPrimitive render={child} {...props} />;
  return <DialogTriggerPrimitive {...props}>{children}</DialogTriggerPrimitive>;
}

function DialogPortal({ children }: { children?: ReactNode }) {
  return <Fragment>{children}</Fragment>;
}

/** `asChild` makes the single child element, such as a Button, close the dialog. */
function DialogClose({
  asChild = false,
  children,
  ...props
}: ComponentProps<typeof DialogClosePrimitive> & { asChild?: boolean }) {
  const child = asChildElement(asChild, children);
  if (child) return <DialogClosePrimitive render={child} {...props} />;
  return <DialogClosePrimitive {...props}>{children}</DialogClosePrimitive>;
}

/** The backdrop dims the page in `--era-overlay` and fades in and out. */
const overlayClass =
  "fixed inset-0 z-50 bg-overlay transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0";

function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogBackdrop>) {
  return <DialogBackdrop className={cn(overlayClass, className)} {...props} />;
}

/** A dialog panel: the raised surface with the popup shadow, centred, fading and scaling in. */
const dialogPanelClass =
  "fixed inset-0 z-50 m-auto grid h-fit grid-cols-[minmax(0,1fr)] max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] max-w-lg gap-5 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-left text-(length:--era-text-md) font-normal normal-case tracking-normal text-popover-foreground shadow-popup outline-none transition-[opacity,scale] data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0";

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: Omit<ComponentProps<typeof DialogContentPrimitive>, "children"> & {
  children?: ReactNode;
  showCloseButton?: boolean;
}) {
  return (
    <>
      <DialogOverlay />
      <DialogContentPrimitive className={cn(dialogPanelClass, className)} {...props}>
        {children}
        {showCloseButton && (
          <DialogClosePrimitive
            aria-label="Close"
            className="absolute right-3 top-3 grid size-(--era-control-height) place-items-center rounded-md text-muted-foreground hover:bg-sunken hover:text-foreground disabled:pointer-events-none"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </DialogClosePrimitive>
        )}
      </DialogContentPrimitive>
    </>
  );
}

function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 pr-8 text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: ComponentProps<typeof DialogTitlePrimitive>) {
  return (
    <DialogTitlePrimitive
      className={cn(
        "font-display text-(length:--era-text-lg) font-semibold leading-6 text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogDescriptionPrimitive>) {
  return (
    <DialogDescriptionPrimitive
      className={cn("text-(length:--era-text-md) leading-5 text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  dialogPanelClass,
  overlayClass,
};
