import type * as React from "react";

import { CopyButton } from "@/components/copy-button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

/** Props for {@link CodeBlock}. */
type CodeBlockProps = Omit<React.ComponentProps<"figure">, "children"> & {
  /** The code, exactly as it should be copied. */
  code: string;
  /** A caption above the code, such as a file name or "Install". */
  title?: React.ReactNode;
  /** The toast text after a successful copy. Defaults to "Copied to clipboard". */
  copiedMessage?: string;
  /**
   * Wrap long lines instead of scrolling sideways, for a long token or a log
   * line that should be read whole. The copied text is unchanged.
   */
  wrap?: boolean;
};

/**
 * A block of code or shell commands with a copy button. Copying shows a toast
 * when a `Toaster` is mounted. Long lines scroll sideways, and the scroll area
 * is focusable so keyboard users can read them; set `wrap` to wrap them.
 */
function CodeBlock({
  code,
  title,
  copiedMessage = "Copied to clipboard",
  wrap = false,
  className,
  ...props
}: CodeBlockProps) {
  return (
    <figure
      data-slot="code-block"
      data-wrap={wrap || undefined}
      className={cn(
        "group/code-block relative overflow-hidden rounded-lg border bg-subtle",
        className,
      )}
      {...props}
    >
      {title ? (
        <figcaption className="flex h-10 items-center border-b bg-background pr-12 pl-4 text-[13px] text-muted-foreground">
          <span className="truncate">{title}</span>
        </figcaption>
      ) : null}
      <CopyButton
        value={code}
        className="absolute top-1.5 right-1.5"
        onCopy={(ok) => {
          if (ok) toast.success(copiedMessage);
          else
            toast.error("Could not copy", { description: "Select the text and copy it by hand." });
        }}
      />
      <pre
        // Only a scrolling block needs focus, so keyboard users can scroll it.
        tabIndex={wrap ? undefined : 0}
        className={cn(
          "p-4 text-[13px] leading-6 focus-visible:-outline-offset-2",
          wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto",
          !title && "pr-12",
        )}
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}

export { CodeBlock, type CodeBlockProps };
