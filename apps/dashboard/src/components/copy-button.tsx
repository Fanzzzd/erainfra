import { CheckIcon, CopyIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Writes text to the clipboard, with a fallback for pages without the async Clipboard API. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    // The deprecated call is the only fallback where the Clipboard API is blocked.
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** Props for {@link CopyButton}. */
type CopyButtonProps = Omit<React.ComponentProps<typeof Button>, "value" | "onClick" | "onCopy"> & {
  /** The text to copy. */
  value: string;
  /**
   * Called after each attempt. When you pass it, you own the announcement,
   * for example a toast; the button then skips its own live message.
   */
  onCopy?: (ok: boolean) => void;
  /** What the button announces after a successful copy. Defaults to "Copied". */
  copiedMessage?: string;
};

/**
 * Copies `value` to the clipboard. The icon turns into a check for two
 * seconds. Without children it is an icon button named "Copy"; with children
 * the children are its label.
 */
function CopyButton({
  value,
  onCopy,
  copiedMessage = "Copied",
  children,
  className,
  variant = "ghost",
  size,
  ...props
}: CopyButtonProps) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");

  React.useEffect(() => {
    if (state === "idle") return undefined;
    const id = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(id);
  }, [state]);

  const handleClick = async () => {
    const ok = await copyText(value);
    setState(ok ? "copied" : "failed");
    onCopy?.(ok);
  };

  const Icon = state === "copied" ? CheckIcon : CopyIcon;
  const message = state === "copied" ? copiedMessage : state === "failed" ? "Copy failed" : "";

  return (
    <Button
      data-slot="copy-button"
      data-state={state}
      variant={variant}
      size={size ?? (children ? "sm" : "icon-sm")}
      aria-label={children ? undefined : "Copy"}
      className={cn("data-[state=copied]:text-success", className)}
      onClick={() => void handleClick()}
      {...props}
    >
      <Icon aria-hidden="true" data-icon={children ? "inline-start" : undefined} />
      {children}
      {onCopy ? null : (
        <span role="status" className="sr-only">
          {message}
        </span>
      )}
    </Button>
  );
}

export { CopyButton, copyText, type CopyButtonProps };
