import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-md border border-white/[0.12] bg-[#0a0a0b] px-3 py-1 text-sm text-zinc-100 outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-[#7c7c85] focus-visible:border-emerald-400/70 focus-visible:ring-2 focus-visible:ring-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
