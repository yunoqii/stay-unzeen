import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-11 w-full min-w-0 rounded-lg border border-input bg-surface-1 px-3 text-base text-foreground transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-faint-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive/70 aria-invalid:ring-destructive/20 sm:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
