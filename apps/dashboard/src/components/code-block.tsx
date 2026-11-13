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
};

/**
 * A block of code or shell commands with a copy button. Copying shows a toast
 * when a `Toaster` is mounted. The code scrolls sideways and its scroll area is
 * focusable, so keyboard users can read long lines.
 */
function CodeBlock({ code, title, className, ...props }: CodeBlockProps) {
  return (
    <figure
      data-slot="code-block"
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
          if (ok) toast.success("Copied to clipboard");
          else
            toast.error("Could not copy", { description: "Select the text and copy it by hand." });
        }}
      />
      <pre
        tabIndex={0}
        className={cn(
          "overflow-x-auto p-4 text-[13px] leading-6 focus-visible:-outline-offset-2",
          !title && "pr-12",
        )}
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}

export { CodeBlock, type CodeBlockProps };
