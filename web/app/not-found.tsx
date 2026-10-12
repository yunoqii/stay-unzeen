import Link from "next/link";
import { PageShell } from "@/components/layout/page-shell";
import { Redacted } from "@/components/layout/redacted";

export default function NotFound() {
  return (
    <PageShell eyebrow="Not found" title="Nothing to see here.">
      <div className="ledger sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid place-items-center px-6 py-14">
          <Redacted text="404" className="font-mono text-7xl tracking-tight sm:text-8xl" />
        </div>
        <div className="flex flex-col justify-center gap-3 px-6 py-10">
          <p className="text-lg font-medium">This page stayed unzeen.</p>
          <p className="text-sm text-pretty text-muted-foreground">The address is wrong, or the page was never here. The feed is.</p>
          <Link href="/" className="mt-2 text-sm text-foreground underline underline-offset-4 hover:text-zec">
            Back to the feed
          </Link>
        </div>
      </div>
      <div aria-hidden className="hatch h-3" />
    </PageShell>
  );
}
