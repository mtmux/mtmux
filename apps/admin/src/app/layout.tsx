import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ThemeProvider } from "@repo/ui/providers/theme-provider";
import { ToastProvider } from "@repo/ui/providers/toast-provider";
import { TRPCProvider } from "@/lib/trpc";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Admin Dashboard",
  description: "Monorepo Starter Admin",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} bg-background text-foreground`}>
        <ThemeProvider>
          <TRPCProvider>
            {children}
            <ToastProvider />
          </TRPCProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
