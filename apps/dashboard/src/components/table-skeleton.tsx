import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

// Varied widths so a loading table reads as "rows are coming" rather than as a
// rendering glitch.
const WIDTHS = ["w-20", "w-32", "w-16", "w-24", "w-12", "w-28", "w-14"];

/**
 * Placeholder rows for a live query that has not resolved yet. Sized to the
 * table it replaces so the layout does not jump when the real rows arrive.
 */
export function TableRowsSkeleton({ columns, rows = 4 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_unused, row) => (
        <TableRow key={`skeleton-row-${row}`} className="hover:bg-transparent">
          {Array.from({ length: columns }, (_alsoUnused, column) => (
            <TableCell key={`skeleton-cell-${column}`}>
              <Skeleton className={cn("h-3.5", WIDTHS[(row * 3 + column) % WIDTHS.length])} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
