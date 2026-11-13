import { useEffect, useRef, useState, type ComponentProps, type RefObject } from "react";

import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Whether a scroll box needs its own tab stop: it overflows sideways and holds nothing a
 * keyboard can focus, so without one the hidden columns are out of a keyboard user's reach.
 * Re-checked when the box or its table resizes, which live rows and window changes cause.
 */
function useKeyboardScroll(container: RefObject<HTMLDivElement | null>) {
  const [needsTabStop, setNeedsTabStop] = useState(false);
  useEffect(() => {
    const box = container.current;
    if (!box) return;
    const check = () =>
      setNeedsTabStop(box.scrollWidth > box.clientWidth && !box.querySelector(FOCUSABLE));
    const observer = new ResizeObserver(check);
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    check();
    return () => observer.disconnect();
  }, [container]);
  return needsTabStop;
}

/**
 * The container owns the horizontal scroll so a wide fleet table never widens
 * the page itself. `min-w-*` on the `<table>` is what pushes the scroll into
 * this box rather than onto the document. Identifiers in `<code>` stay on one
 * line, so a narrow screen scrolls the table instead of breaking a name at its
 * hyphens.
 */
function Table({ className, ...props }: ComponentProps<"table">) {
  const container = useRef<HTMLDivElement>(null);
  const needsTabStop = useKeyboardScroll(container);
  return (
    <div
      ref={container}
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
      {...(needsTabStop
        ? { tabIndex: 0, role: "region", "aria-label": "Table, scrolls sideways" }
        : {})}
    >
      <table
        data-slot="table"
        className={cn(
          "w-full caption-bottom text-(length:--era-text-md) tabular-nums [&_td_code:not(.block)]:whitespace-nowrap",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b [&_tr]:hover:bg-transparent", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t border-border bg-sunken font-medium", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-border hover:bg-sunken/60 data-[state=selected]:bg-sunken",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 whitespace-nowrap px-4 text-left align-middle text-(length:--era-text-sm) font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td data-slot="table-cell" className={cn("px-4 py-3 align-middle", className)} {...props} />
  );
}

function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-(length:--era-text-sm) text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
