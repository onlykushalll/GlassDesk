import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GlassDesk — two people, one PC made of glass",
  description:
    "A browser-based AnyDesk-style collaboration app. Two people share one software-defined virtual PC — windows, files, apps and a YouTube watch-party, all synced live — with a P2P video call docked in the sidebar.",
  keywords: ["GlassDesk", "shared desktop", "virtual PC", "collaboration", "watch party", "WebRTC"],
  // no `icons` entry — src/app/icon.svg (the GlassDesk prism) is
  // auto-served by the App Router as the favicon.
  openGraph: {
    title: "GlassDesk",
    description: "Two people. One PC made of glass. Zero-latency co-control + video call.",
    siteName: "GlassDesk",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
