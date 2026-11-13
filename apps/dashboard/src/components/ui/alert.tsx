import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Class names for the Era alert. The tone variants colour the border and the
 * icon; the text stays the foreground colour, so it meets 4.5:1 on the card.
 */
const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border bg-card px-4 py-3 text-left text-sm text-card-foreground has-data-[slot=alert-action]:pr-24 has-[>svg]:grid-cols-[auto_minmax(0,1fr)] has-[>svg]:gap-x-3 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "*:[svg]:text-muted-foreground",
        info: "border-info/40 *:[svg]:text-info",
        success: "border-success/40 *:[svg]:text-success",
        warning: "border-warning/40 *:[svg]:text-warning",
        danger: "border-danger/40 *:[svg]:text-danger",
        /** shadcn's name for `danger`, so blocks written for shadcn keep working. */
        destructive: "border-danger/40 *:[svg]:text-danger",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

/** Props for {@link Alert}. */
type AlertProps = React.ComponentProps<"div"> & VariantProps<typeof alertVariants>;

/**
 * A message in the flow of the page, such as a failed save or a limit that
 * applies to this screen. It has `role="alert"` by default, so a screen reader
 * announces it when it appears. Pass `role="status"` for news that can wait,
 * or `role="note"` for a message that is there when the page loads.
 */
function Alert({ className, variant = "default", role = "alert", ...props }: AlertProps) {
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      role={role}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

/** The alert's one-line summary. */
function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3",
        className,
      )}
      {...props}
    />
  );
}

/** Detail under the title: what happened and what to do next. */
function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-pretty text-muted-foreground group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-3",
        className,
      )}
      {...props}
    />
  );
}

/** A button at the top right of the alert, such as Retry. */
function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2.5 right-3", className)}
      {...props}
    />
  );
}

export { Alert, AlertAction, AlertDescription, AlertTitle, alertVariants, type AlertProps };
