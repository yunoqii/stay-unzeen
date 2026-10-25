import { Suspense } from "react";
import { notFound } from "next/navigation";
import { LaunchRoute } from "@/components/launch/launch-route";
import { Skeleton } from "@/components/ui/skeleton";

export default function LaunchByIdPage({ params }: PageProps<"/launch/[id]">) {
  // A public build has no launch pages at all: /launch/<anything> is a plain 404.
  if (process.env.NEXT_PUBLIC_FAIR_LAUNCH_BUILD !== "1") notFound();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-10 sm:px-6 sm:pt-14">
      <Suspense fallback={<Skeleton className="h-72 rounded-2xl" />}>
        <LaunchRoute params={params} />
      </Suspense>
    </div>
  );
}
