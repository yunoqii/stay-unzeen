"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";

/** App chrome (footer, bottom nav) that the landing at `/` draws itself. */
export function OffLanding({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={null}>
      <OffLandingPath>{children}</OffLandingPath>
    </Suspense>
  );
}

function OffLandingPath({ children }: { children: React.ReactNode }) {
  if (usePathname() === "/") return null;
  return children;
}
