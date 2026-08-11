import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type Tone = "success" | "warning" | "destructive" | "info" | "muted";

const DOT_TONE: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  info: "bg-info",
  muted: "bg-subtle-foreground",
};

/**
 * A coloured dot that pulses only while something is genuinely in flight. The
 * pulse is the console's single piece of load-bearing motion, so it is spent
 * carefully: a still dot means settled, not disconnected.
 */
export function StatusDot({
  tone,
  live = false,
  className,
}: {
  tone: Tone;
  live?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        DOT_TONE[tone],
        live && "status-pulse",
        className,
      )}
    />
  );
}

/** Says out loud that the table below is a live subscription, not a snapshot. */
export function LiveBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("h-8 gap-2 px-2.5 text-xs", className)}>
      <StatusDot tone="success" live />
      Live updates
    </Badge>
  );
}
