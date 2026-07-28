"use client";

import { Separator } from "@repo/ui/components/ui/separator";
import { Label } from "@repo/ui/components/ui/label";
import { Input } from "@repo/ui/components/ui/input";
import { ScrollArea } from "@repo/ui/components/ui/scroll-area";
import { Switch } from "@repo/ui/components/ui/switch";
import { ThemeToggle } from "@repo/ui/components/theme-toggle";
import { cn } from "@repo/ui/lib/utils";
import { terminalThemes } from "@repo/ui/terminal-themes";
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";

/** Raw buttons here need the same focus ring the shared Button component has. */
const focusRing =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface SettingsPanelProps {
  className?: string;
}

export function SettingsPanel({ className }: SettingsPanelProps) {
  const terminal = useTerminalStore();
  const settings = useSettingsStore();
  return (
    <ScrollArea className={cn("h-full", className)}>
      <div className="space-y-6 p-4">
        {/* #12: Appearance / Theme toggle */}
        <section>
          <h3 className="text-sm font-semibold mb-3">Appearance</h3>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Theme</Label>
            <ThemeToggle />
          </div>
        </section>

        <Separator />

        {/* Terminal Settings */}
        <section>
          <h3 className="text-sm font-semibold mb-3">Terminal</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Font Size</Label>
              <div className="flex items-center gap-2">
                <button
                  className={cn("h-11 w-11 rounded border text-sm", focusRing)}
                  aria-label="Decrease font size"
                  onClick={() =>
                    terminal.setFontSize(Math.max(8, terminal.fontSize - 1))
                  }
                >
                  -
                </button>
                <span className="w-8 text-center text-sm">
                  {terminal.fontSize}
                </span>
                <button
                  className={cn("h-11 w-11 rounded border text-sm", focusRing)}
                  aria-label="Increase font size"
                  onClick={() =>
                    terminal.setFontSize(Math.min(24, terminal.fontSize + 1))
                  }
                >
                  +
                </button>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Cursor Style</Label>
              <div className="flex gap-1">
                {(["block", "underline", "bar"] as const).map((style) => (
                  <button
                    key={style}
                    className={cn(
                      "min-h-11 rounded-md border px-3 py-1 text-xs capitalize transition-colors",
                      focusRing,
                      terminal.cursorStyle === style
                        ? "border-primary bg-primary/10"
                        : "hover:bg-accent",
                    )}
                    onClick={() => terminal.setCursorStyle(style)}
                  >
                    {style}
                  </button>
                ))}
              </div>
            </div>
            {/* #11: Switch component replaces manual toggle */}
            <div className="flex items-center justify-between">
              <Label className="text-xs">Cursor Blink</Label>
              <Switch
                checked={terminal.cursorBlink}
                onCheckedChange={(checked) => terminal.setCursorBlink(checked)}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-xs">Auto-zoom Panes</Label>
                <p className="text-[10px] text-muted-foreground">
                  Auto-zoom into active pane on attach and split (mobile only)
                </p>
              </div>
              <Switch
                checked={settings.autoZoom}
                onCheckedChange={(checked) => settings.setAutoZoom(checked)}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-xs">GPU Rendering</Label>
                <p className="text-[10px] text-muted-foreground">
                  Turn off if only part of each line is visible. Applies after
                  reload.
                </p>
              </div>
              <Switch
                checked={terminal.gpuRendering}
                onCheckedChange={(checked) => terminal.setGpuRendering(checked)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Scrollback Lines</Label>
              <Input
                type="number"
                value={terminal.scrollback}
                onChange={(e) => terminal.setScrollback(Number(e.target.value))}
                onBlur={(e) => {
                  const v = Math.max(
                    100,
                    Math.min(50000, Number(e.target.value) || 1000),
                  );
                  terminal.setScrollback(v);
                }}
                className="h-8 text-sm"
                min={100}
                max={50000}
                step={500}
              />
            </div>
          </div>
        </section>

        <Separator />

        {/* Terminal Theme Settings */}
        <section>
          <h3 className="text-sm font-semibold mb-3">Terminal Theme</h3>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(terminalThemes).map(([key, theme]) => (
              <button
                key={key}
                className={cn(
                  "rounded-lg border p-2 transition-colors text-left",
                  focusRing,
                  terminal.themeName === key
                    ? "border-primary ring-1 ring-primary"
                    : "hover:border-foreground/30",
                )}
                onClick={() => terminal.setThemeName(key)}
              >
                <div
                  className="mb-1.5 rounded-md px-2 py-1 font-mono text-[10px]"
                  style={{
                    backgroundColor: theme.background,
                    color: theme.foreground,
                  }}
                >
                  <span style={{ color: theme.green }}>$</span>{" "}
                  <span style={{ color: theme.cyan }}>hello</span>
                </div>
                <span className="text-xs">{theme.name}</span>
              </button>
            ))}
          </div>
        </section>

        <Separator />

        {/* Keyboard Toolbar */}
        <section>
          <h3 className="text-sm font-semibold mb-3">Keyboard Toolbar</h3>
          <div className="flex flex-wrap gap-1.5">
            {settings.toolbarKeys.map((key) => (
              <button
                key={key.id}
                className={cn(
                  "min-h-11 rounded-md border px-2.5 py-1 text-xs transition-colors",
                  focusRing,
                  key.visible ? "border-primary bg-primary/10" : "opacity-50",
                )}
                onClick={() => settings.toggleToolbarKey(key.id)}
              >
                {key.label}
              </button>
            ))}
          </div>
        </section>

        <Separator />

        {/* Gestures — #11: Switch replaces manual toggles */}
        <section>
          <h3 className="text-sm font-semibold mb-3">Gestures</h3>
          <div className="space-y-2">
            {(
              [
                ["swipeToSwitchSessions", "Swipe to switch sessions"],
                ["swipeToSwitchPanes", "Swipe to switch panes"],
                ["doubleTapToCopy", "Double-tap to copy"],
                ["longPressContextMenu", "Long-press context menu"],
                ["twoFingerScroll", "Two-finger scroll"],
                ["pinchToZoom", "Pinch to zoom"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between">
                <Label className="text-xs">{label}</Label>
                <Switch
                  checked={settings.gestures[key]}
                  onCheckedChange={(checked) =>
                    settings.setGesture(key, checked)
                  }
                />
              </div>
            ))}
          </div>
        </section>

        <Separator />

        {/* Haptics — #11: Switch replaces manual toggle */}
        <section>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">Haptic Feedback</h3>
              <p className="text-xs text-muted-foreground">
                Vibrate on key press
              </p>
            </div>
            <Switch
              checked={settings.hapticEnabled}
              onCheckedChange={(checked) => settings.setHapticEnabled(checked)}
            />
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}
