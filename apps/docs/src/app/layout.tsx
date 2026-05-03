import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://ccremote.dev"),
  title: {
    default: "ccremote — Your Claude. Your terminal. Anywhere.",
    template: "%s · ccremote",
  },
  description:
    "Self-hosted browser terminal for Claude Code. Connect to tmux from any device — phone, tablet, laptop. One npm install away.",
  applicationName: "ccremote",
  authors: [{ name: "Nicholas Griffin" }],
  keywords: [
    "Claude Code",
    "Claude Code remote",
    "tmux web client",
    "browser terminal",
    "self-hosted terminal",
    "remote terminal mobile",
    "WebSocket tmux",
    "xterm.js",
    "Anthropic Claude",
    "developer tools",
  ],
  openGraph: {
    type: "website",
    url: "https://ccremote.dev",
    siteName: "ccremote",
    title: "ccremote — Your Claude. Your terminal. Anywhere.",
    description: "Self-hosted browser terminal for Claude Code. One npm install away.",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "ccremote",
    description: "Your Claude. Your terminal. Anywhere.",
    creator: "@nicholasgriffin",
  },
  robots: { index: true, follow: true },
  alternates: { canonical: "https://ccremote.dev" },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "ccremote",
  description: "Self-hosted browser terminal for Claude Code.",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Linux, macOS, Windows",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  url: "https://ccremote.dev",
  author: { "@type": "Person", name: "Nicholas Griffin" },
  license: "https://opensource.org/licenses/MIT",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} flex min-h-screen flex-col`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
