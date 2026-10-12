import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Toaster } from "sonner";
import { MotionProvider } from "@/components/motion/motion-provider";
import { SiteHeader } from "@/components/layout/site-header";
import { BottomNav } from "@/components/layout/bottom-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "unzeen · Launch anywhere. Stay unzeen.", template: "%s · unzeen" },
  description: "Private trading on Solana launchpads, paid in shielded ZEC.",
  referrer: "no-referrer",
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
          <main className="pb-safe-nav relative flex-1">{children}</main>
          <BottomNav />
        </MotionProvider>
        <Toaster theme="dark" position="top-center" toastOptions={{ className: "font-sans" }} />
      </body>
    </html>
  );
}
