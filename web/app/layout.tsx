import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Toaster } from "sonner";
import { MotionProvider } from "@/components/motion/motion-provider";
import { SiteHeader } from "@/components/layout/site-header";
import { BottomNav } from "@/components/layout/bottom-nav";
import { SiteFooter } from "@/components/layout/site-footer";
import { ChaosMount } from "@/components/dev/chaos-mount";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "unzeen · Launch anywhere. Stay unzeen.", template: "%s · unzeen" },
  description: "Private trading on Solana launchpads, paid in shielded ZEC.",
  referrer: "no-referrer",
  // Absolute OG URLs need a base: the deploy sets NEXT_PUBLIC_SITE_URL; locally it falls back to localhost.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  openGraph: {
    title: "unzeen · Launch anywhere. Stay unzeen.",
    description: "Private trading on Solana launchpads, paid in shielded ZEC.",
    images: [{ url: "/og.jpg", width: 1200, height: 630, alt: "A dark eclipse with a thin gold rim: unzeen" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "unzeen · Launch anywhere. Stay unzeen.",
    description: "Private trading on Solana launchpads, paid in shielded ZEC.",
    images: ["/og.jpg"],
  },
  robots: { index: false },
};

export const viewport: Viewport = {
  themeColor: "#060607",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`dark ${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="grain flex min-h-full flex-col">
        <MotionProvider>
          <SiteHeader />
          <main className="relative flex-1">{children}</main>
          <div className="pb-safe-nav">
            <SiteFooter />
          </div>
          <BottomNav />
          <ChaosMount />
        </MotionProvider>
        <Toaster theme="dark" position="top-center" toastOptions={{ className: "font-sans" }} />
      </body>
    </html>
  );
}
