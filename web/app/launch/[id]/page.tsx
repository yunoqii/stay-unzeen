import { Suspense } from "react";
import { LaunchRoute } from "@/components/launch/launch-route";
import { Skeleton } from "@/components/ui/skeleton";

export default function LaunchByIdPage({ params }: PageProps<"/launch/[id]">) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-10 sm:px-6 sm:pt-14">
      <Suspense fallback={<Skeleton className="h-72 rounded-2xl" />}>
        <LaunchRoute params={params} />
      </Suspense>
    </div>
  );
}
