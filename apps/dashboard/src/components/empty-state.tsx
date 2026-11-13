import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const emptyStateVariants = cva(
  "flex w-full min-w-0 flex-col items-center justify-center gap-3 p-8 text-center text-balance",
  {
    variants: {
      variant: {
        plain: "",
        outline: "rounded-xl border border-dashed",
      },
    },
    defaultVariants: { variant: "plain" },
  },
);

/**
 * What a list or page shows when it has nothing yet: an icon, a title, one
 * sentence that says why, and the next step. `outline` draws a dashed frame
 * for use on a bare page; inside a card or table use `plain`.
 */
function EmptyState({
  className,
  variant = "plain",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyStateVariants>) {
  return (
    <div
      data-slot="empty-state"
      className={cn(emptyStateVariants({ variant }), className)}
      {...props}
    />
  );
}

/** An icon on a muted tile. Decorative; the title carries the meaning. */
function EmptyStateMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state-media"
      aria-hidden="true"
      className={cn(
        "mb-1 flex size-10 shrink-0 items-center justify-center rounded-lg border bg-subtle text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-5",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The title, for example "No machines yet". It renders a `div`; pass
 * `render={<h2 />}` when it should be in the page outline.
 */
function EmptyStateTitle({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("font-heading text-sm font-semibold tracking-title", className) },
      props,
    ),
    render,
    state: { slot: "empty-state-title" },
  });
}

/** One sentence that says why it is empty or what fills it. */
function EmptyStateDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="empty-state-description"
      className={cn(
        "max-w-sm text-sm text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** The next step: a button or a command. */
function EmptyStateActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state-actions"
      className={cn("mt-1 flex flex-wrap items-center justify-center gap-2", className)}
      {...props}
    />
  );
}

export {
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateMedia,
  EmptyStateTitle,
  emptyStateVariants,
};
