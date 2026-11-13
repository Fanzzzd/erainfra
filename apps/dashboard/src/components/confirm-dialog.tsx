import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** Props for {@link ConfirmDialog}. */
type ConfirmDialogProps = {
  /** The element that opens the dialog, such as `<Button variant="destructive" />`. Leave it out when you control `open`. */
  trigger?: React.ReactElement<Record<string, unknown>>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The question, for example "Remove runner-01?". */
  title: React.ReactNode;
  /** What happens, and whether it can be undone. */
  description?: React.ReactNode;
  /** Extra content between the description and the buttons. */
  children?: React.ReactNode;
  /** The confirming button's label. Name the action: "Remove machine", not "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /**
   * When set, the user must type this text, such as the machine name, before
   * the confirm button turns on. Use it for actions that destroy data.
   */
  confirmationText?: string;
  /** `destructive` (the default) paints the confirm button in `--destructive`. */
  tone?: "destructive" | "default";
  /**
   * Runs on confirm. Return a promise to keep the dialog open, with both
   * buttons disabled, until it settles. A rejection shows its message in the
   * dialog and keeps it open.
   */
  onConfirm: () => void | Promise<void>;
};

/**
 * A confirmation for a destructive or irreversible action, built on
 * `AlertDialog`. Focus starts on Cancel, or on the text field when typed
 * confirmation is on. The typed text and the error clear each time it opens,
 * also when you control `open` and close it yourself.
 *
 * @example
 * <ConfirmDialog
 *   trigger={<Button variant="destructive">Remove</Button>}
 *   title="Remove runner-01?"
 *   description="Running jobs on it are cancelled. The machine can join again later."
 *   confirmLabel="Remove machine"
 *   confirmationText="runner-01"
 *   onConfirm={() => api.removeMachine("runner-01")}
 * />
 */
function ConfirmDialog({
  trigger,
  open: openProp,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmationText,
  tone = "destructive",
  onConfirm,
}: ConfirmDialogProps) {
  const [openState, setOpenState] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const open = openProp ?? openState;

  // Start empty on every open, however the dialog opened or closed. Base UI
  // calls onOpenChange only for changes it makes, not when the parent sets
  // `open`, so a reset there would miss a dialog the parent closed itself.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTyped("");
      setError(null);
    }
  }

  const setOpen = (next: boolean) => {
    if (pending) return;
    setOpenState(next);
    onOpenChange?.(next);
  };

  const matches = confirmationText === undefined || typed === confirmationText;

  const confirm = async () => {
    if (!matches || pending) return;
    setError(null);
    setPending(true);
    try {
      await onConfirm();
      setPending(false);
      setOpenState(false);
      onOpenChange?.(false);
    } catch (cause) {
      setPending(false);
      setError(cause instanceof Error ? cause.message : "The action failed. Try again.");
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger ? <AlertDialogTrigger render={trigger} /> : null}
      <AlertDialogContent
        data-slot="confirm-dialog"
        {...(confirmationText === undefined ? {} : { initialFocus: input })}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        {confirmationText === undefined ? null : (
          <Field>
            <FieldLabel className="block font-normal text-muted-foreground">
              Type <span className="font-mono font-medium text-foreground">{confirmationText}</span>{" "}
              to confirm
            </FieldLabel>
            <Input
              ref={input}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void confirm();
              }}
            />
          </Field>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={tone === "destructive" ? "destructive" : "default"}
            disabled={!matches || pending}
            aria-busy={pending || undefined}
            className={cn(pending && "cursor-progress")}
            onClick={() => void confirm()}
          >
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { ConfirmDialog, type ConfirmDialogProps };
