import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastRegion,
  ToastTitle,
  toast,
} from "@ui-sdk/react/toast";
import { XIcon } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

/**
 * One region for every toast in the console, in the bottom-right corner. `toast()`,
 * `toast.success()` and `toast.error()` work from any event handler. The stack layout and the
 * colour for each toast type live in `styles.css`, under `[data-slot="toast"]`.
 */
function Toaster() {
  return (
    <ToastRegion side="bottom" align="end">
      {() => (
        <Toast>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <ToastTitle className="font-medium leading-5" />
            <ToastDescription className="text-(length:--era-text-sm) leading-5 text-muted-foreground" />
          </div>
          <ToastAction className={buttonVariants({ variant: "secondary" })} />
          <ToastClose
            aria-label="Dismiss"
            className="-mr-1 -mt-0.5 grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-sunken hover:text-foreground"
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </ToastClose>
        </Toast>
      )}
    </ToastRegion>
  );
}

export { Toaster, toast };
