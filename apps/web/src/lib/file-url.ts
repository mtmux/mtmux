import { resolveRelayHttpBase } from "@/lib/relay-url";

export function getFileUrl(path: string, download?: boolean): string {
  const httpBase = resolveRelayHttpBase();
  const token =
    typeof window !== "undefined" ? (localStorage.getItem("ccremote-token") ?? "") : "";
  const params = new URLSearchParams({ path, token });
  if (download) params.set("download", "1");
  return `${httpBase}/file?${params.toString()}`;
}
