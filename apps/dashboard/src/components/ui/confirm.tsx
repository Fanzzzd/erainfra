import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  createConfirm,
} from "@ui-sdk/react/alert-dialog";

import { buttonVariants } from "@/components/ui/button";
import { dialogPanelClass, overlayClass } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** What a destructive confirmation says. The confirm button names the action, such as Revoke. */
type DestructiveQuestion = {
  title: string;
  description?: string;
  confirmLabel: string;
};

const ask = createConfirm<DestructiveQuestion>();

/**
 * Asks before a destructive action, in an alert dialog, and resolves `true` only when the
 * operator presses the confirm button. Cancel, Escape and a press outside resolve `false`.
 * `ConfirmDialog` must be mounted once, near the root.
 */
function confirmDestructive(question: DestructiveQuestion): Promise<boolean> {
  return ask(question);
}

function ConfirmDialog() {
  return (
    <AlertDialog controller={ask.controller}>
      <AlertDialogBackdrop className={overlayClass} />
      <AlertDialogContent<DestructiveQuestion> className={cn(dialogPanelClass, "max-w-md")}>
        {(state) => (
          <>
            <div className="flex flex-col gap-1.5">
              <AlertDialogTitle className="font-display text-(length:--era-text-lg) font-semibold leading-6 text-foreground">
                {state.payload?.title}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-(length:--era-text-md) leading-5 text-muted-foreground">
                {state.payload?.description}
              </AlertDialogDescription>
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <AlertDialogClose className={buttonVariants({ variant: "secondary" })}>
                Cancel
              </AlertDialogClose>
              <AlertDialogClose value="confirm" className={buttonVariants({ variant: "danger" })}>
                {state.payload?.confirmLabel}
              </AlertDialogClose>
            </div>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { ConfirmDialog, confirmDestructive };
