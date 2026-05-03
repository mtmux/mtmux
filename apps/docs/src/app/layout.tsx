import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "ccremote — Access Claude Code from Any Browser",
    template: "ccremote — %s",
  },
  description:
    "Access Claude Code from any browser or mobile device. Self-hosted remote terminal with tmux session management, file browsing, and mobile support over WebSocket.",
  keywords: [
    "Claude Code",
    "remote terminal",
    "tmux",
    "browser terminal",
    "mobile terminal",
    "self-hosted",
    "WebSocket terminal",
    "Claude Code remote",
    "terminal in browser",
  ],
  openGraph: {
    type: "website",
    title: "ccremote — Access Claude Code from Any Browser",
    description:
      "Self-hosted remote terminal with tmux session management, file browsing, and mobile support.",
    siteName: "ccremote",
  },
  twitter: {
    card: "summary_large_image",
    title: "ccremote — Access Claude Code from Any Browser",
    description:
      "Self-hosted remote terminal with tmux session management, file browsing, and mobile support.",
  },
  metadataBase: new URL("https://ccremote.dev"),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} flex min-h-screen flex-col`}>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
