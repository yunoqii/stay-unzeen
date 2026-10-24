import type { Metadata } from "next";
import { HomeClient } from "@/components/feed/home-client";

export const metadata: Metadata = {
  title: "Feed",
};

export default function FeedPage() {
  return <HomeClient />;
}
