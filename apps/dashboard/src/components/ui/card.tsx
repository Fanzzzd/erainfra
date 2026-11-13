import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const cardVariants = cva(
  "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl border bg-card py-(--card-spacing) text-sm text-card-foreground has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
  {
    variants: {
      size: {
        default: "[--card-spacing:--spacing(4)]",
        sm: "[--card-spacing:--spacing(3)]",
        lg: "[--card-spacing:--spacing(6)]",
      },
    },
    defaultVariants: { size: "default" },
  },
);

/**
 * A panel: card fill, a 1px border and no shadow. Only popups are raised.
 * `size` sets the inner spacing for every part through `--card-spacing`.
 */
function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(cardVariants({ size }), className)}
      {...props}
    />
  );
}

/** The top of a card: title, description and an optional `CardAction`. */
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className,
      )}
      {...props}
    />
  );
}

/** The classes of {@link CardTitle}, in cva so a prefixed install prefixes them. */
const cardTitleClasses = cva(
  "font-heading text-base leading-snug font-semibold tracking-title group-data-[size=sm]/card:text-sm",
);

/**
 * The card title. It renders a `div`; pass `render={<h2 />}` to put it in
 * the page outline at the right level.
 */
function CardTitle({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(cardTitleClasses(), className),
      },
      props,
    ),
    render,
    state: { slot: "card-title" },
  });
}

/** Muted text under the title. */
function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

/** Actions at the top right of the header, such as a button or a menu. */
function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  );
}

/** The body of a card. Add `p-0` for a full-bleed table. */
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-content" className={cn("px-(--card-spacing)", className)} {...props} />
  );
}

/** A footer strip on the subtle surface, separated by a rule. */
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center border-t bg-subtle p-(--card-spacing)", className)}
      {...props}
    />
  );
}

export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cardVariants,
};
