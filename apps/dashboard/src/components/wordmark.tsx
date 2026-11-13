import { cn } from "@/lib/utils";

/** The product name in the Era display face. Every Era product sets its wordmark this way. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-display text-(length:--era-text-lg) font-bold leading-none text-foreground",
        className,
      )}
    >
      EraInfra
    </span>
  );
}
