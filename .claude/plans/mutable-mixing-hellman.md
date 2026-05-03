# Session Card Polish + File Tree Click Fix

## Context
After the previous batch of UI changes, two issues need fixing:
1. **Session card** is too cluttered and has wrong default behavior (auto-expands single-window sessions). User wants: collapsed by default, icon-based display instead of text, clickable panes/windows in expanded view, icon for attached/detached status.
2. **File tree** click doesn't work on mobile — the per-item `DropdownMenu` trigger button is `opacity-0` but still captures touch events, blocking the entry click handler.

---

## Change A: Session Card Overhaul
**File:** `apps/web/src/components/session/session-card.tsx`

### A1. Remove auto-expand
- Delete the `useEffect` (lines 73-80) that auto-expands single-window sessions
- Sessions always start collapsed; only the chevron button expands

### A2. Replace text badge with icon indicator
- Remove the `<Badge>` for attached/detached (line 167-169)
- Add a small colored dot indicator:
  - Attached: green dot (`bg-green-500`)
  - Detached: gray dot (`bg-muted-foreground/40`)
- Placed before the session name, small `h-2 w-2 rounded-full`

### A3. Simplify expanded view — icon-based, less text
Replace the current expanded tree (lines 243-261) with a cleaner icon-based layout:
- **Windows**: Show `TerminalSquare` icon + window index + name (no pane count badge)
- **Panes**: Show small `>` or `SquareTerminal` icon + short label (just the command name, no path). Use `text-[11px]` to keep compact
- Remove the `Badge` for pane counts per window — the panes themselves are visible

### A4. Make panes/windows clickable
- **Pane click**: Attach to that session, then send `pane:select` + `pane:zoom` (mobile) or just `pane:select` (desktop)
  - Need to call `onAttach(session.name)` first to attach, then send pane commands
  - Use `useMediaQuery` to detect mobile
- **Window click (desktop only)**: Attach to that session, then send `window:select`
  - On mobile, window row is not clickable (user interacts with panes directly)
- Add `cursor-pointer hover:bg-accent/50 rounded` styling to clickable items

### A5. Imports update
- Add `useMediaQuery` from `@repo/ui/hooks/use-media-query`
- Add `Circle` or remove `Badge` import as needed
- Keep `TerminalSquare` for window icons

---

## Change B: File Tree — Fix Mobile Click
**File:** `apps/web/src/components/files/file-tree.tsx`

### Problem
Line 502: The per-item dropdown trigger `<Button>` has `opacity-0 group-hover:opacity-100`. On mobile:
- `group-hover` never activates, so the button stays invisible
- But it still occupies layout space and captures touch events
- User taps near the right side of an entry → hits the invisible button → nothing visible happens

### Fix
- Add `pointer-events-none` to the dropdown trigger button when not hovered
- Change class to: `opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity`
- This ensures on mobile the invisible button doesn't intercept touches
- On desktop, hover reveals the button AND enables pointer events

---

## Files to Modify
1. `apps/web/src/components/session/session-card.tsx` — Changes A1-A5
2. `apps/web/src/components/files/file-tree.tsx` — Change B

## Verification
1. `pnpm typecheck` — must pass
2. Mobile: file tree entries are clickable, folders navigate, files open editor
3. Session cards start collapsed, expand only via chevron click
4. Expanded view shows clean icon-based window/pane tree
5. Clicking a pane in expanded view attaches + zooms (mobile) or attaches + selects (desktop)
6. Attached/detached shown as colored dot, not text badge
