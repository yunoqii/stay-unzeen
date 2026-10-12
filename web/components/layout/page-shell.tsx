import { cn } from "@/lib/utils";

interface Props {
  eyebrow?: string;
  title: string;
  lead?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function PageShell({ eyebrow, title, lead, children, className }: Props) {
  return (
    <div className={cn("mx-auto w-full max-w-6xl px-4 pt-10 sm:px-6 sm:pt-14", className)}>
      <header className="max-w-2xl">
        {eyebrow && <p className="mb-3 font-mono text-xs tracking-wider text-faint-foreground uppercase">{eyebrow}</p>}
        <h1 className="text-3xl font-medium tracking-tight text-balance sm:text-4xl">{title}</h1>
        {lead && <p className="mt-3 text-base text-pretty text-muted-foreground">{lead}</p>}
      </header>
      <div className="mt-10">{children}</div>
    </div>
  );
}

/** Quiet empty state: a silhouette, not an illustration. */
export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed border-border px-6 py-14 text-center",
        className,
      )}
    >
      <div aria-hidden className="absolute top-1/2 left-1/2 size-48 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/[0.025] blur-3xl" />
      {icon && <div className="relative mb-4 text-muted-foreground">{icon}</div>}
      <p className="relative text-sm font-medium">{title}</p>
      {children && <div className="relative mt-2 max-w-sm text-sm text-pretty text-muted-foreground">{children}</div>}
    </div>
  );
}
