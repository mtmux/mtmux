/**
 * Keeping the platform's keyboard down while ours is up.
 *
 * Two keyboards on screen at once is not a cosmetic problem. The native one
 * covers the lower half of the viewport, including our board, and `AppShell`
 * sizes itself to the visual viewport — so the footer our keyboard lives in
 * gets squeezed to nothing the moment the native one opens over it.
 *
 * `inputmode="none"` is the one mechanism that does this without breaking
 * anything else. Blurring xterm's hidden textarea would work for exactly as
 * long as it takes the user to tap the terminal again, and would also lose the
 * cursor and stop tmux believing the pane is focused. `inputmode="none"` keeps
 * focus exactly where it was and tells the platform not to raise a keyboard
 * for it, which is precisely the distinction we want.
 *
 * It has to be re-applied, which is why this is a module with a listener
 * rather than a one-line effect: xterm's textarea is created by xterm, a
 * second one appears for every new terminal instance, and a session switch
 * tears the old one down. The `focusin` listener catches all of that without
 * needing to know when it happens.
 */

/** xterm's own hidden textarea. The class is xterm's, and it is stable. */
const XTERM_INPUT = "textarea.xterm-helper-textarea";

let suppressed = false;

function apply(el: Element | null): void {
  if (!(el instanceof HTMLTextAreaElement)) return;
  if (!el.matches(XTERM_INPUT)) return;
  // Setting it to `text` rather than removing the attribute: xterm does not
  // set one itself, and `text` is the default a textarea has anyway, so this
  // restores the platform behaviour without having to remember whether the
  // attribute was there to begin with.
  el.inputMode = suppressed ? "none" : "text";
}

function applyAll(): void {
  document.querySelectorAll(XTERM_INPUT).forEach(apply);
}

/**
 * Catch a textarea that did not exist when we were switched on.
 *
 * `focusin` rather than a `MutationObserver`: the only moment a textarea's
 * input mode matters is when it is focused, and that event fires for a
 * terminal mounted a minute from now without watching every DOM mutation in
 * the app to find it.
 */
function onFocusIn(event: FocusEvent): void {
  apply(event.target as Element | null);
}

export function setNativeKeyboardSuppressed(next: boolean): void {
  if (typeof document === "undefined" || next === suppressed) return;
  suppressed = next;
  applyAll();
  if (next) {
    document.addEventListener("focusin", onFocusIn);
  } else {
    document.removeEventListener("focusin", onFocusIn);
  }
}

/**
 * Put the native keyboard away *now*, if it is up.
 *
 * `inputmode` is only consulted when an element is focused, so a keyboard that
 * is already open stays open until something changes. Blurring once, at the
 * moment our board opens, is what closes it — and the next tap on the terminal
 * re-focuses the textarea under the new input mode, so it does not come back.
 */
export function dismissNativeKeyboard(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

/** Test seam: forget the module's state between cases. */
export function resetNativeKeyboardSuppression(): void {
  if (typeof document !== "undefined") {
    document.removeEventListener("focusin", onFocusIn);
  }
  suppressed = false;
}
