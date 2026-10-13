import Link from "next/link";

const LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/tokens", label: "Tokens" },
  { href: "/stats", label: "Stats" },
  { href: "/verify", label: "Verify" },
];

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border/60">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-6 text-sm sm:px-6">
        <p className="text-faint-foreground">
          Launch anywhere. <span className="text-muted-foreground">Stay unzeen.</span>
        </p>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="text-muted-foreground transition-colors hover:text-foreground">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
