import type { Metadata } from "next";
import { Landing } from "@/components/landing/landing";

export const metadata: Metadata = {
  // The root layout's default title ("unzeen · Launch anywhere. Stay unzeen.") is the landing's own.
  description: "Private trading for launchpads, paid in shielded ZEC. Shared pool vaults sign every trade: the feed says “unzeen bought”, never who.",
};

export default function HomePage() {
  return <Landing />;
}
