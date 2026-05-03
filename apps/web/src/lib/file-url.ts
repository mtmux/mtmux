import { env } from "@/env";

export function getFileUrl(path: string, download?: boolean): string {
  const httpBase = env.NEXT_PUBLIC_RELAY_URL
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:");
  const token =
    typeof window !== "undefined"
      ? (localStorage.getItem("ccremote-token") ?? "")
      : "";
  const params = new URLSearchParams({ path, token });
  if (download) params.set("download", "1");
  return `${httpBase}/file?${params.toString()}`;
}
