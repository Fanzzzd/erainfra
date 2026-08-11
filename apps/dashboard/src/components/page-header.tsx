import type { ReactNode } from "react";

/**
 * One heading shape for every route, so the eye lands in the same place after
 * a navigation and the action for the page is always top-right.
 */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-foreground">{title}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
