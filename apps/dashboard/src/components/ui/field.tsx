import { Field as FieldPrimitive } from "@base-ui/react/field";
import { Fieldset as FieldsetPrimitive } from "@base-ui/react/fieldset";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A group of related fields with a legend, for example the options of one
 * setting. Screen readers announce the legend with each control.
 */
function FieldSet({ className, ...props }: FieldsetPrimitive.Root.Props & { className?: string }) {
  return (
    <FieldsetPrimitive.Root
      data-slot="field-set"
      className={cn("flex min-w-0 flex-col gap-4 border-0 p-0", className)}
      {...props}
    />
  );
}

/** The caption of a `FieldSet`. */
function FieldLegend({
  className,
  ...props
}: FieldsetPrimitive.Legend.Props & { className?: string }) {
  return (
    <FieldsetPrimitive.Legend
      data-slot="field-legend"
      className={cn("mb-1 text-sm font-medium", className)}
      {...props}
    />
  );
}

/** Stacks fields with even spacing. Horizontal fields switch layout at its `@md` width. */
function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "group/field-group @container/field-group flex w-full flex-col gap-5",
        className,
      )}
      {...props}
    />
  );
}

const fieldVariants = cva("group/field flex w-full gap-2", {
  variants: {
    orientation: {
      vertical: "flex-col",
      horizontal:
        "flex-row items-center has-[>[data-slot=field-content]]:items-start has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=switch]]:mt-0.5",
      responsive:
        "flex-col @md/field-group:flex-row @md/field-group:items-center @md/field-group:has-[>[data-slot=field-content]]:items-start",
    },
  },
  defaultVariants: { orientation: "vertical" },
});

/** Props for {@link Field}. */
type FieldProps = FieldPrimitive.Root.Props & {
  className?: string;
} & VariantProps<typeof fieldVariants>;

/**
 * One form control with its label, description and error, built on Base UI
 * Field: the label, description and error are linked to the control by id,
 * so you never wire `htmlFor` or `aria-describedby` by hand. Works with
 * `Input`, `Textarea`, `Checkbox`, `Switch` and `Select`. Set `invalid` for
 * an error from the server, or let native validation set it.
 */
function Field({ className, orientation = "vertical", ...props }: FieldProps) {
  return (
    <FieldPrimitive.Root
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  );
}

/** Holds a label and description next to a checkbox or switch in a horizontal field. */
function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-content"
      className={cn("flex flex-1 flex-col gap-1 leading-snug", className)}
      {...props}
    />
  );
}

/** The label of a `Field`. */
function FieldLabel({ className, ...props }: FieldPrimitive.Label.Props & { className?: string }) {
  return (
    <FieldPrimitive.Label
      data-slot="field-label"
      className={cn(
        "flex w-fit items-center gap-2 text-sm leading-snug font-medium select-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/** Help text under the control, announced with it. */
function FieldDescription({
  className,
  ...props
}: FieldPrimitive.Description.Props & { className?: string }) {
  return (
    <FieldPrimitive.Description
      data-slot="field-description"
      className={cn(
        "text-sm leading-normal text-muted-foreground [&>a]:underline [&>a]:underline-offset-4",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The error message. It shows only while the field is invalid. Pass `match`
 * to show it for one validity state, such as `"valueMissing"`.
 */
function FieldError({ className, ...props }: FieldPrimitive.Error.Props & { className?: string }) {
  return (
    <FieldPrimitive.Error
      data-slot="field-error"
      className={cn("text-sm text-destructive", className)}
      {...props}
    />
  );
}

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  type FieldProps,
};
