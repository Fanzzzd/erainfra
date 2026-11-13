import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  FlexRender,
  type Cell,
  type ColumnDef,
  type Row,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { cva } from "class-variance-authority";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, EllipsisIcon } from "lucide-react";
import * as React from "react";

import { EmptyState, EmptyStateTitle } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** Per-column layout options, set as `meta` on a column. */
type DataTableColumnMeta = {
  /** Right-align numbers and durations. */
  align?: "start" | "end";
  /** Extra classes for the header cell. */
  headerClassName?: string;
  /** Extra classes for each body cell. */
  cellClassName?: string;
  /**
   * The column's place when the rows stack on a narrow container: `primary`
   * values form the item's title, `secondary` values sit under it with their
   * header as a label, and `hidden` columns are left out. The first column
   * defaults to `primary`, the rest to `secondary`.
   */
  mobile?: "primary" | "secondary" | "hidden";
  /** The label of a secondary value when the header is not plain text. */
  mobileLabel?: string;
};

/** A type-only slot: TanStack reads its type, not its value. */
const columnMeta: DataTableColumnMeta = {};

/**
 * The TanStack Table features every Era data table registers: client-side
 * sorting with the built-in comparators, and the column meta above. It is
 * module-level and stable, as TanStack Table v9 requires.
 */
const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
  columnMeta,
});

/** The feature set of {@link dataTableFeatures}. */
type DataTableFeatures = typeof dataTableFeatures;

/** A column of a data table. Build columns with {@link createDataTableColumns}. */
type DataTableColumn<TData extends RowData> = ColumnDef<DataTableFeatures, TData, any>;

/**
 * Returns TanStack's column helper bound to the Era feature set. Define the
 * columns at module level or in `useMemo`, so they stay stable.
 *
 * @example
 * const column = createDataTableColumns<Run>()
 * const columns = column.columns([
 *   column.accessor("state", { header: "State", cell: (c) => <Status state={c.getValue()} /> }),
 *   column.accessor("waitSeconds", { header: "Queued", meta: { align: "end" } }),
 * ])
 */
function createDataTableColumns<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>();
}

/** `data-*` attributes, which React passes through to the element. */
type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

/** Props for {@link DataTable}. */
type DataTableProps<TData extends RowData> = {
  /** Stable columns from {@link createDataTableColumns}. */
  columns: DataTableColumn<TData>[];
  data: TData[];
  /** The table's accessible name, also used for its scroll region. */
  "aria-label": string;
  /** A stable id per row, such as the run id. Defaults to the row index. */
  getRowId?: (row: TData, index: number) => string;
  /**
   * Extra attributes for each row, such as `data-*` hooks for end-to-end
   * tests: `(run) => ({ "data-run-id": run.id })`. They go on the table row,
   * and on the list item when the rows stack. Classes merge with the row's.
   */
  getRowProps?: (row: TData) => React.HTMLAttributes<HTMLElement> & DataAttributes;
  /** The sort order on first render, such as `[{ id: "startedAt", desc: true }]`. */
  defaultSorting?: SortingState;
  /** While true, the body shows skeleton rows and the table reports `aria-busy`. */
  loading?: boolean;
  /** How many skeleton rows to show while loading. */
  loadingRows?: number;
  /** Shown in place of the rows when there are none. Pass an `EmptyState`. */
  empty?: React.ReactNode;
  /**
   * A menu of actions at the end of each row. `label` names the menu button
   * for screen readers, for example `(run) => \`Actions for ${run.job}\``.
   * `items` returns `DropdownMenuItem`s.
   */
  rowActions?: {
    label: (row: TData) => string;
    items: (row: TData) => React.ReactNode;
  };
  /**
   * The container width below which the rows stack into a list: Tailwind's
   * `sm` (24rem), `md` (28rem), `lg` (32rem), `xl` (36rem) or `2xl` (42rem).
   * `false` keeps the table at every width. Defaults to `lg`.
   */
  stackBelow?: StackBelow | false;
  /** Classes for the table. */
  className?: string;
  /** Classes for the scroll container. Give it a max height, such as `max-h-[480px]`, for a sticky header. */
  containerClassName?: string;
};

function SortIcon({ direction }: { direction: false | "asc" | "desc" }) {
  if (direction === "asc") return <ArrowUpIcon aria-hidden="true" />;
  if (direction === "desc") return <ArrowDownIcon aria-hidden="true" />;
  return <ChevronsUpDownIcon aria-hidden="true" className="opacity-50" />;
}

const ariaSort = { asc: "ascending", desc: "descending" } as const;

/** The default sort order: none. A module constant, so it stays the same object. */
const noSorting: SortingState = [];

/**
 * Right-aligns the cells of a column whose meta sets `align: "end"`. Class
 * strings outside JSX live in cva, so a prefixed install prefixes them.
 */
const alignClasses = cva("", { variants: { align: { start: "", end: "text-right" } } });

/** Right-aligns the cells of a column whose meta sets `align: "end"`. */
function alignEnd(meta: DataTableColumnMeta | undefined) {
  return alignClasses({ align: meta?.align ?? "start" });
}

/** Hides the table below the `stackBelow` container width. */
const stackTableClasses = cva("", {
  variants: {
    stackBelow: {
      sm: "@max-sm:hidden",
      md: "@max-md:hidden",
      lg: "@max-lg:hidden",
      xl: "@max-xl:hidden",
      "2xl": "@max-2xl:hidden",
    },
  },
});

/** Hides the stacked list from the `stackBelow` container width up. */
const stackListClasses = cva("", {
  variants: {
    stackBelow: {
      sm: "@sm:hidden",
      md: "@md:hidden",
      lg: "@lg:hidden",
      xl: "@xl:hidden",
      "2xl": "@2xl:hidden",
    },
  },
});

/** The container widths `stackBelow` accepts. */
type StackBelow = "sm" | "md" | "lg" | "xl" | "2xl";

/** A column's place in the stacked layout. The first column defaults to primary. */
function mobileRole(meta: DataTableColumnMeta | undefined, index: number) {
  return meta?.mobile ?? (index === 0 ? "primary" : "secondary");
}

/** The label of a secondary value in the stacked layout. */
function mobileLabel<TData extends RowData>(cell: Cell<DataTableFeatures, TData>) {
  const { header, meta } = cell.column.columnDef;
  return meta?.mobileLabel ?? (typeof header === "string" ? header : cell.column.id);
}

/** The menu at the end of a row, in the table and in the stacked layout. */
function RowActionsMenu<TData extends RowData>({
  row,
  rowActions,
}: {
  row: TData;
  rowActions: NonNullable<DataTableProps<TData>["rowActions"]>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={rowActions.label(row)} />}
      >
        <EllipsisIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {rowActions.items(row)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The fallback for `empty`. */
const nothingToShow = (
  <EmptyState>
    <EmptyStateTitle>Nothing to show</EmptyStateTitle>
  </EmptyState>
);

/**
 * The stacked layout for narrow containers: one item per row, the primary
 * columns as its title, the secondary columns as labelled values under it,
 * and the row actions menu at the end. It keeps the table's sort order.
 */
function StackedRows<TData extends RowData>({
  rows,
  label,
  loading,
  loadingRows,
  empty,
  rowActions,
  getRowProps,
  className,
}: {
  rows: Row<DataTableFeatures, TData>[];
  label: string;
  loading: boolean;
  loadingRows: number;
  empty: React.ReactNode;
  rowActions: DataTableProps<TData>["rowActions"];
  getRowProps: DataTableProps<TData>["getRowProps"];
  className: string;
}) {
  if (!loading && rows.length === 0) return <div className={className}>{empty}</div>;
  return (
    <ul
      data-slot="data-table-stack"
      aria-label={label}
      aria-busy={loading || undefined}
      className={cn("divide-y text-sm", className)}
    >
      {loading
        ? Array.from({ length: loadingRows }, (_row, index) => (
            <li key={`loading-${index}`} className="space-y-2 px-4 py-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3.5 w-48" />
            </li>
          ))
        : rows.map((row) => {
            const cells = row.getAllCells();
            const role = (index: number) => mobileRole(cells[index]?.column.columnDef.meta, index);
            const primary = cells.filter((_cell, index) => role(index) === "primary");
            const secondary = cells.filter((_cell, index) => role(index) === "secondary");
            const rowProps = getRowProps?.(row.original);
            return (
              <li
                key={row.id}
                {...rowProps}
                className={cn("flex items-start gap-3 px-4 py-3", rowProps?.className)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                    {primary.map((cell) => (
                      <FlexRender key={cell.id} cell={cell} />
                    ))}
                  </div>
                  {secondary.length > 0 ? (
                    <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
                      {secondary.map((cell) => (
                        <div key={cell.id} className="contents">
                          <dt className="text-muted-foreground">{mobileLabel(cell)}</dt>
                          <dd className="min-w-0">
                            <FlexRender cell={cell} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </div>
                {rowActions ? (
                  <div className="-my-1 -mr-2 shrink-0">
                    <RowActionsMenu row={row.original} rowActions={rowActions} />
                  </div>
                ) : null}
              </li>
            );
          })}
    </ul>
  );
}

/**
 * A data table on TanStack Table v9 with the Era table look. It sorts by
 * clicking or pressing Enter on a header, shows skeleton rows while loading,
 * shows `empty` when there are no rows, and puts a row actions menu at the end
 * of each row. The header sticks when the container has a height. Wide tables
 * scroll sideways, and the scroll region is focusable so it works by keyboard.
 *
 * Below the `stackBelow` container width the rows stack into a list, set per
 * column with `meta.mobile`. The table measures its own width, so it needs a
 * parent that gives it one, such as a card or a block element; inside a
 * `w-fit` parent it collapses.
 */
function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  getRowProps,
  defaultSorting = noSorting,
  loading = false,
  loadingRows = 5,
  empty = nothingToShow,
  rowActions,
  stackBelow = "lg",
  className,
  containerClassName,
  "aria-label": label,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>(defaultSorting);
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    state: { sorting },
    onSortingChange: setSorting,
    ...(getRowId ? { getRowId } : {}),
  });

  const rows = table.getRowModel().rows;
  const columnCount = table.getAllLeafColumns().length + (rowActions ? 1 : 0);
  const stack =
    stackBelow === false
      ? undefined
      : { table: stackTableClasses({ stackBelow }), list: stackListClasses({ stackBelow }) };

  return (
    <div data-slot="data-table" className={cn(stack && "@container")}>
      <Table
        aria-label={label}
        aria-busy={loading || undefined}
        className={className}
        containerClassName={cn(stack?.table, containerClassName)}
      >
        <TableHeader className="sticky top-0 z-10 bg-card [&_tr]:border-b-0">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {group.headers.map((header) => {
                const meta = header.column.columnDef.meta;
                const sorted = header.column.getIsSorted();
                const canSort = header.column.getCanSort();
                return (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    aria-sort={canSort ? (sorted ? ariaSort[sorted] : "none") : undefined}
                    className={cn(
                      "shadow-[inset_0_-1px_0_var(--border)]",
                      alignEnd(meta),
                      meta?.headerClassName,
                    )}
                  >
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          "-mx-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 hover:bg-muted hover:text-foreground [&_svg]:size-3.5",
                          sorted && "text-foreground",
                          meta?.align === "end" && "flex-row-reverse",
                        )}
                      >
                        <FlexRender header={header} />
                        <SortIcon direction={sorted} />
                      </button>
                    ) : (
                      <FlexRender header={header} />
                    )}
                  </TableHead>
                );
              })}
              {rowActions ? (
                <TableHead className="w-12 shadow-[inset_0_-1px_0_var(--border)]">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: loadingRows }, (_row, index) => (
              <TableRow key={`loading-${index}`} className="hover:bg-transparent">
                {Array.from({ length: columnCount }, (_cell, cell) => (
                  <TableCell key={cell}>
                    <Skeleton className={cn("h-4", cell === 0 ? "w-20" : "w-full max-w-32")} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columnCount} className="h-auto p-0 whitespace-normal">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id} {...getRowProps?.(row.original)}>
                {row.getAllCells().map((cell) => {
                  const meta = cell.column.columnDef.meta;
                  return (
                    <TableCell key={cell.id} className={cn(alignEnd(meta), meta?.cellClassName)}>
                      <FlexRender cell={cell} />
                    </TableCell>
                  );
                })}
                {rowActions ? (
                  <TableCell className="w-12 pr-2 text-right">
                    <RowActionsMenu row={row.original} rowActions={rowActions} />
                  </TableCell>
                ) : null}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {stack ? (
        <StackedRows
          rows={rows}
          label={label}
          loading={loading}
          loadingRows={loadingRows}
          empty={empty}
          rowActions={rowActions}
          getRowProps={getRowProps}
          className={stack.list}
        />
      ) : null}
    </div>
  );
}

export {
  DataTable,
  createDataTableColumns,
  dataTableFeatures,
  type DataTableColumn,
  type DataTableColumnMeta,
  type DataTableFeatures,
  type DataTableProps,
};
