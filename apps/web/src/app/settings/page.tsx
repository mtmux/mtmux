"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, LogOut } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { getRelayClient } from "@/hooks/use-websocket";
import { useSessionStore } from "@/stores/session-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useCommandStore } from "@/stores/command-store";
import { useFileStore } from "@/stores/file-store";
import { LAST_SESSION_KEY, TOKEN_KEY, clearStored } from "@/lib/storage-keys";

export default function SettingsPage() {
  const router = useRouter();

  const handleLogout = () => {
    // Disconnect WebSocket
    getRelayClient()?.disconnect();

    // Reset all Zustand stores
    useSessionStore.getState().setSessions([]);
    useSessionStore.getState().setActiveSession(null);
    useConnectionStore.getState().setStatus("disconnected");
    useConnectionStore.getState().resetReconnect();
    useCommandStore.getState().clearHistory();
    useFileStore.getState().setEntries([]);
    useFileStore.getState().setSelectedFile(null);
    useFileStore.getState().setFileContent(null);

    // Clear localStorage
    clearStored(TOKEN_KEY);
    clearStored(LAST_SESSION_KEY);

    router.push("/login");
  };

  return (
    <div className="flex h-[100dvh] flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => router.back()}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="flex-1 text-sm font-semibold">Settings</h1>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={handleLogout}
        >
          <LogOut className="mr-1 h-3.5 w-3.5" />
          Logout
        </Button>
      </header>
      <SettingsPanel className="flex-1" />
    </div>
  );
}
