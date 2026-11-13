import type * as React from "react";

import { cn } from "@/lib/utils";

/** Props for {@link Table}. */
type TableProps = React.ComponentProps<"table"> & {
  /** Classes for the scroll container around the table, for example a max height. */
  containerClassName?: string | undefined;
};

/**
 * A data table with a muted header, 1px row rules and tabular numbers. It
 * sits in a horizontal scroll container that is focusable, so keyboard users
 * can scroll a wide table with the arrow keys. Name the table with
 * `aria-label` or a `TableCaption`; the container takes the same name.
 */
function Table({ className, containerClassName, ...props }: TableProps) {
  const label = props["aria-label"];
  return (
    <div
      data-slot="table-container"
      // A scroll container must be focusable to be scrollable by keyboard.
      tabIndex={0}
      role={label ? "region" : undefined}
      aria-label={label}
      className={cn(
        "relative w-full overflow-auto focus-visible:-outline-offset-2",
        containerClassName,
      )}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm tabular-nums", className)}
        {...props}
      />
    </div>
  );
}

/** The header row group. Inside a scrolling container with a height, it sticks. */
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

/** The body row group. */
function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

/** A totals row on the subtle surface. */
function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-subtle font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

/** A row. Set `aria-selected` to highlight a selected row. */
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 aria-selected:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

/** A header cell: muted, sentence case, never wrapping. */
function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

/** A body cell. */
function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "h-12 px-3 py-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

/** The table's visible name, under the table. */
function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  type TableProps,
};
