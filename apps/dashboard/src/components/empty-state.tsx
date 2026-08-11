import type { ComponentType, ReactNode } from "react";

/**
 * An empty table is ambiguous on its own — nothing has happened yet, or a
 * filter is hiding everything. Every empty state here says which, and offers
 * the next action when there is one.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-14 text-center">
      <div className="grid size-9 place-items-center rounded-md border border-border bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <p className="mt-4 text-sm font-medium text-secondary-foreground">{title}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      {children !== undefined && <div className="mt-4">{children}</div>}
    </div>
  );
}
