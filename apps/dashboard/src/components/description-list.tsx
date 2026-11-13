import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const descriptionListVariants = cva("text-sm", {
  variants: {
    layout: {
      /** Term on the left, value on the right, one row each. Stacks on narrow containers. */
      rows: "divide-y [&>div]:grid [&>div]:gap-1 [&>div]:py-2.5 @md:[&>div]:grid-cols-[minmax(8rem,1fr)_2fr] @md:[&>div]:gap-4",
      /** Term above value, in a grid of columns. */
      grid: "grid gap-x-6 gap-y-4 @sm:grid-cols-2 @2xl:grid-cols-3 [&>div]:flex [&>div]:flex-col [&>div]:gap-1",
    },
  },
  defaultVariants: { layout: "rows" },
});

/**
 * Key and value pairs, such as a machine's facts. Each pair is a
 * `DescriptionListItem` holding a `DescriptionTerm` and `DescriptionDetails`.
 * Put it in a container (`@container`) so the layout follows its width.
 */
function DescriptionList({
  className,
  layout = "rows",
  ...props
}: React.ComponentProps<"dl"> & VariantProps<typeof descriptionListVariants>) {
  return (
    <dl
      data-slot="description-list"
      className={cn(descriptionListVariants({ layout }), className)}
      {...props}
    />
  );
}

/** One pair. It renders a `div`, which HTML allows inside `<dl>`. */
function DescriptionListItem({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="description-list-item" className={cn("min-w-0", className)} {...props} />;
}

/** The key. */
function DescriptionTerm({ className, ...props }: React.ComponentProps<"dt">) {
  return (
    <dt
      data-slot="description-term"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

/** The value. Numbers use tabular figures. */
function DescriptionDetails({ className, ...props }: React.ComponentProps<"dd">) {
  return (
    <dd
      data-slot="description-details"
      className={cn("min-w-0 break-words tabular-nums", className)}
      {...props}
    />
  );
}

export {
  DescriptionDetails,
  DescriptionList,
  DescriptionListItem,
  DescriptionTerm,
  descriptionListVariants,
};
