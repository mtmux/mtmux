import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.mtmux.com"),
  title: {
    default: "mtmux docs — tmux in your browser",
    template: "%s · mtmux docs",
  },
  description:
    "Documentation for mtmux, the npm CLI that serves your tmux sessions to any browser. Install, pair a phone, understand the sealed tunnel, and self-host the whole thing.",
  applicationName: "mtmux",
  keywords: [
    "mtmux",
    "tmux web client",
    "browser terminal",
    "self-hosted terminal",
    "remote terminal mobile",
    "tmux from phone",
    "WebSocket tmux",
    "xterm.js",
    "Claude Code remote",
    "developer tools",
  ],
  openGraph: {
    type: "website",
    url: "https://docs.mtmux.com",
    siteName: "mtmux docs",
    title: "mtmux docs — tmux in your browser",
    description:
      "Install the mtmux CLI, pair a device, and understand the sealed tunnel.",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "mtmux docs",
    description: "tmux in your browser. One command, any device.",
  },
  robots: { index: true, follow: true },
  alternates: { canonical: "https://docs.mtmux.com" },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "mtmux",
  description:
    "tmux in your browser. One command serves your terminal to any device.",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Linux, macOS",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  url: "https://mtmux.com",
  codeRepository: "https://github.com/GagnDeep/tmuxremote",
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
