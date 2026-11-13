import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import type { EraProduct } from "@/lib/era-root";
import { cn } from "@/lib/utils";

/** The one spelling of each product name. */
const productNames = {
  mesh: "EraMesh",
  db: "EraDB",
  infra: "EraInfra",
} as const satisfies Record<EraProduct, string>;

const glyphs: Record<EraProduct, React.ReactNode> = {
  mesh: (
    <>
      <path d="M4 15 10 4l6 11z" strokeLinejoin="round" />
      <circle cx="10" cy="4" r="2" fill="currentColor" stroke="none" />
      <circle cx="4" cy="15" r="2" fill="currentColor" stroke="none" />
      <circle cx="16" cy="15" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  db: (
    <>
      <ellipse cx="10" cy="5" rx="6" ry="2.4" />
      <path d="M4 5v10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V5" />
      <path d="M4 10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4" />
    </>
  ),
  infra: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="11" y="3" width="6" height="6" rx="1.2" />
      <rect x="3" y="11" width="6" height="6" rx="1.2" />
      <rect x="11" y="11" width="6" height="6" rx="1.2" />
    </>
  ),
};

const productMarkVariants = cva(
  "inline-flex shrink-0 items-center justify-center text-product [&>svg]:size-[62%]",
  {
    variants: {
      variant: {
        tile: "rounded-md border bg-background",
        plain: "",
      },
      size: {
        sm: "size-6",
        default: "size-8",
        lg: "size-10",
      },
    },
    defaultVariants: { variant: "tile", size: "default" },
  },
);

/** Props for {@link ProductMark}. */
type ProductMarkProps = Omit<React.ComponentProps<"span">, "children"> &
  VariantProps<typeof productMarkVariants> & { product: EraProduct };

/**
 * A product's mark: one glyph in the product's signal colour, on a neutral
 * tile by default. It is decorative; pair it with the name, as
 * `ProductWordmark` does, or give it an `aria-label`.
 */
function ProductMark({ product, variant, size, className, ...props }: ProductMarkProps) {
  const labelled = props["aria-label"] !== undefined;
  return (
    <span
      data-slot="product-mark"
      data-product={product}
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      className={cn(productMarkVariants({ variant, size }), className)}
      {...props}
    >
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        aria-hidden="true"
      >
        {glyphs[product]}
      </svg>
    </span>
  );
}

/** Props for {@link ProductWordmark}. */
type ProductWordmarkProps = React.ComponentProps<"span"> & {
  product: EraProduct;
  size?: "sm" | "default" | "lg";
};

/**
 * The mark and the product name, for headers and footers. Children render
 * after the name, for example a workspace or a stage.
 */
function ProductWordmark({
  product,
  size = "default",
  className,
  children,
  ...props
}: ProductWordmarkProps) {
  return (
    <span
      data-slot="product-wordmark"
      className={cn(
        "inline-flex min-w-0 items-center gap-2.5",
        size === "lg" ? "text-lg" : "text-sm",
        className,
      )}
      {...props}
    >
      <ProductMark product={product} size={size === "lg" ? "default" : "sm"} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="font-semibold tracking-title">{productNames[product]}</span>
        {children}
      </span>
    </span>
  );
}

/** The Era Suite mark: three beds of growing width. Decorative unless labelled. */
function SuiteMark({ className, ...props }: React.ComponentProps<"svg">) {
  const labelled = props["aria-label"] !== undefined;
  return (
    <svg
      viewBox="0 0 32 32"
      data-slot="suite-mark"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      className={cn("size-6 shrink-0", className)}
      {...props}
    >
      <rect width="32" height="32" rx="7" className="fill-foreground" />
      <rect x="8" y="9" width="10" height="3" rx="1.5" className="fill-background" />
      <rect x="8" y="14.5" width="13" height="3" rx="1.5" className="fill-background" />
      <rect x="8" y="20" width="16" height="3" rx="1.5" className="fill-background" />
    </svg>
  );
}

export {
  ProductMark,
  ProductWordmark,
  SuiteMark,
  productMarkVariants,
  productNames,
  type ProductMarkProps,
  type ProductWordmarkProps,
};
