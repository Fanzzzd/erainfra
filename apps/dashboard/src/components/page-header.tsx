import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The top of a page: `PageHeaderTitle`, an optional `PageHeaderDescription`
 * and `PageHeaderActions`. The actions sit to the right when the container
 * is at least `@2xl` wide, and below the text when it is narrower.
 */
function PageHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        "@container/page-header grid grid-cols-1 gap-x-6 gap-y-1",
        "@2xl/page-header:grid-cols-[minmax(0,1fr)_auto]",
        className,
      )}
      {...props}
    />
  );
}

/** The classes of {@link PageHeaderTitle}, in cva so a prefixed install prefixes them. */
const pageHeaderTitleClasses = cva(
  "font-heading text-2xl leading-tight font-semibold tracking-title text-balance @2xl/page-header:col-start-1",
);

/**
 * The page title. It renders an `h1`; pass `render={<h2 />}` when the page
 * sits inside another, such as a product window on a marketing page.
 */
function PageHeaderTitle({ className, render, ...props }: useRender.ComponentProps<"h1">) {
  return useRender({
    defaultTagName: "h1",
    props: mergeProps<"h1">(
      {
        className: cn(pageHeaderTitleClasses(), className),
      },
      props,
    ),
    render,
    state: { slot: "page-header-title" },
  });
}

/** One or two sentences under the title. */
function PageHeaderDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="page-header-description"
      className={cn(
        "max-w-[62ch] text-sm text-muted-foreground @2xl/page-header:col-start-1",
        className,
      )}
      {...props}
    />
  );
}

/** Buttons and live indicators for the page. The primary action goes last. */
function PageHeaderActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-header-actions"
      className={cn(
        "mt-3 flex flex-wrap items-center gap-2",
        "@2xl/page-header:col-start-2 @2xl/page-header:row-span-2 @2xl/page-header:row-start-1 @2xl/page-header:mt-0 @2xl/page-header:self-end",
        className,
      )}
      {...props}
    />
  );
}

export { PageHeader, PageHeaderActions, PageHeaderDescription, PageHeaderTitle };
