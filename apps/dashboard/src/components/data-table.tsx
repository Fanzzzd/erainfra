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
  type ColumnDef,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
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

/** Props for {@link DataTable}. */
type DataTableProps<TData extends RowData> = {
  /** Stable columns from {@link createDataTableColumns}. */
  columns: DataTableColumn<TData>[];
  data: TData[];
  /** The table's accessible name, also used for its scroll region. */
  "aria-label": string;
  /** A stable id per row, such as the run id. Defaults to the row index. */
  getRowId?: (row: TData, index: number) => string;
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

/**
 * A data table on TanStack Table v9 with the Era table look. It sorts by
 * clicking or pressing Enter on a header, shows skeleton rows while loading,
 * shows `empty` when there are no rows, and puts a row actions menu at the end
 * of each row. The header sticks when the container has a height. Wide tables
 * scroll sideways, and the scroll region is focusable so it works by keyboard.
 */
function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  defaultSorting = [],
  loading = false,
  loadingRows = 5,
  empty,
  rowActions,
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
  const alignEnd = (meta: DataTableColumnMeta | undefined) => meta?.align === "end" && "text-right";

  return (
    <Table
      aria-label={label}
      aria-busy={loading || undefined}
      className={className}
      containerClassName={containerClassName}
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
                      <table.FlexRender header={header} />
                      <SortIcon direction={sorted} />
                    </button>
                  ) : (
                    <table.FlexRender header={header} />
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
          Array.from({ length: loadingRows }, (_, index) => (
            <TableRow key={`loading-${index}`} className="hover:bg-transparent">
              {Array.from({ length: columnCount }, (_, cell) => (
                <TableCell key={cell}>
                  <Skeleton className={cn("h-4", cell === 0 ? "w-20" : "w-full max-w-32")} />
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : rows.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columnCount} className="h-auto p-0 whitespace-normal">
              {empty ?? (
                <EmptyState>
                  <EmptyStateTitle>Nothing to show</EmptyStateTitle>
                </EmptyState>
              )}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              {row.getAllCells().map((cell) => {
                const meta = cell.column.columnDef.meta;
                return (
                  <TableCell key={cell.id} className={cn(alignEnd(meta), meta?.cellClassName)}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                );
              })}
              {rowActions ? (
                <TableCell className="w-12 pr-2 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={rowActions.label(row.original)}
                        />
                      }
                    >
                      <EllipsisIcon aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      {rowActions.items(row.original)}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              ) : null}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
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
