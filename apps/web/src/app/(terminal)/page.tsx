"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMediaQuery } from "@repo/ui/hooks/use-media-query";
import { Sheet, SheetContent } from "@repo/ui/components/ui/sheet";
import { TerminalView, type TerminalViewHandle } from "@/components/terminal/terminal-view";
import { TerminalToolbar } from "@/components/terminal/terminal-toolbar";
import { SessionList } from "@/components/session/session-list";
import { SessionCreateDialog } from "@/components/session/session-create-dialog";
import { FileTree } from "@/components/files/file-tree";
import { FilePreview } from "@/components/files/file-preview";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { SwipeSessionSwitcher } from "@/components/mobile/swipe-session-switcher";
import { WindowTabs } from "@/components/mobile/window-tabs";
import { TmuxFab } from "@/components/mobile/tmux-fab";
import { PaneListPanel } from "@/components/mobile/pane-list-panel";
import { PaneResizeControls } from "@/components/mobile/pane-resize-controls";
import { PinchZoomHandler } from "@/components/mobile/pinch-zoom-handler";
import { useSessionStore } from "@/stores/session-store";
import { useFileStore } from "@/stores/file-store";
import { useUiStore } from "@/stores/ui-store";
import { getRelayClient } from "@/hooks/use-websocket";

export default function TerminalPage() {
  const router = useRouter();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const { activeSessionId } = useSessionStore();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const { setSelectedFile } = useFileStore();
  const { mobileTab, setMobileTab } = useUiStore();
  const terminalRef = useRef<TerminalViewHandle>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { currentPath, setCurrentPath, setIsLoading } = useFileStore();

  // #3: Auto-switch to terminal tab on session attach
  useEffect(() => {
    if (activeSessionId && isMobile) {
      setMobileTab("terminal");
    }
  }, [activeSessionId, isMobile, setMobileTab]);

  // #2: Navigate handler for inline breadcrumb
  const handleBreadcrumbNavigate = useCallback(
    (path: string) => {
      setCurrentPath(path);
      setIsLoading(true);
      getRelayClient()?.send({ type: "file:list", path });
    },
    [setCurrentPath, setIsLoading],
  );

  const handleFileSelect = useCallback(
    (path: string) => {
      setSelectedFile(path);
      setPreviewFile(path);
    },
    [setSelectedFile],
  );

  const handleSearch = useCallback((term: string) => {
    terminalRef.current?.search(term);
  }, []);

  const handleSearchNext = useCallback(() => {
    terminalRef.current?.findNext();
  }, []);

  const handleSearchPrevious = useCallback(() => {
    terminalRef.current?.findPrevious();
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  const handleOpenSettings = useCallback(() => {
    if (isMobile) {
      setMobileTab("settings");
    } else {
      router.push("/settings");
    }
  }, [isMobile, setMobileTab, router]);

  if (isMobile) {
    return (
      <>
        {mobileTab === "terminal" && (
          <SwipeSessionSwitcher className="h-[100dvh] max-h-full">
            {/* #6: Hide TerminalToolbar on mobile — search moved to keyboard toolbar */}
            <div className="flex h-full flex-col">
              <WindowTabs />
              <div className="flex-1 overflow-hidden">
                <PinchZoomHandler className="h-full">
                  <TerminalView
                    ref={terminalRef}
                    sessionName={activeSessionId}
                    className="h-full"
                    onCreateSession={() => setShowCreateDialog(true)}
                  />
                </PinchZoomHandler>
              </div>
            </div>
          </SwipeSessionSwitcher>
        )}
        {mobileTab === "sessions" && (
          <div className="flex h-full flex-col">
            <SessionList
              onCreateClick={() => setShowCreateDialog(true)}
              className="flex-1"
            />
          </div>
        )}
        {mobileTab === "files" && (
          <div className="flex h-full flex-col">
            {/* #2: Consolidated — breadcrumb rendered inline inside FileTree */}
            <FileTree
              onFileSelect={handleFileSelect}
              className="flex-1"
              breadcrumbPath={currentPath}
              onNavigate={handleBreadcrumbNavigate}
            />
          </div>
        )}
        {mobileTab === "settings" && (
          <SettingsPanel className="h-full" />
        )}
        {/* #18: File preview on mobile via bottom sheet */}
        {isMobile && (
          <Sheet open={!!previewFile} onOpenChange={(open) => { if (!open) setPreviewFile(null); }}>
            <SheetContent side="bottom" className="h-[70vh] p-0">
              <FilePreview
                path={previewFile}
                onClose={() => setPreviewFile(null)}
                className="h-full"
              />
            </SheetContent>
          </Sheet>
        )}
        <TmuxFab />
        <PaneListPanel />
        <PaneResizeControls />
        <SessionCreateDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
        />
      </>
    );
  }

  // Desktop layout: sidebar + terminal + optional file preview
  return (
    <div className="flex h-full">
      {/* Session sidebar */}
      <div className="flex w-64 shrink-0 flex-col border-r">
        <SessionList
          onCreateClick={() => setShowCreateDialog(true)}
          className="flex-1"
        />
      </div>

      {/* Main terminal area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TerminalToolbar
          onSearch={handleSearch}
          onSearchNext={handleSearchNext}
          onSearchPrevious={handleSearchPrevious}
          onToggleFullscreen={handleToggleFullscreen}
          onOpenSettings={handleOpenSettings}
          isFullscreen={isFullscreen}
        />
        <div className="flex-1 overflow-hidden">
          <TerminalView
            ref={terminalRef}
            sessionName={activeSessionId}
            className="h-full"
            onCreateSession={() => setShowCreateDialog(true)}
          />
        </div>
      </div>

      {/* File preview panel (when open) */}
      {previewFile && (
        <FilePreview
          path={previewFile}
          onClose={() => setPreviewFile(null)}
          className="w-80 shrink-0"
        />
      )}

      <SessionCreateDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
      />
    </div>
  );
}
