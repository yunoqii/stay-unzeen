import { Suspense } from "react";
import { TokenView, TokenViewSkeleton } from "@/components/tokens/token-view";

export default function TokenPage({ params }: PageProps<"/token/[mint]">) {
  return (
    <Suspense fallback={<TokenViewSkeleton />}>
      <TokenView params={params} />
    </Suspense>
  );
}
