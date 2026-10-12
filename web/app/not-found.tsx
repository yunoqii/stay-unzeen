import Link from "next/link";
import { EmptyState, PageShell } from "@/components/layout/page-shell";

export default function NotFound() {
  return (
    <PageShell eyebrow="404" title="Nothing to see here.">
      <EmptyState title="This page stayed unzeen.">
        <Link href="/" className="text-foreground underline underline-offset-4">
          Back to the feed
        </Link>
      </EmptyState>
    </PageShell>
  );
}
