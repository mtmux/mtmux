export function SkipLink({ label }: { label: string }) {
  return (
    <a
      href="#content"
      className="sr-only z-100 rounded-md bg-brand px-4 py-2 font-mono text-sm font-semibold text-brand-contrast focus-visible:not-sr-only focus-visible:fixed focus-visible:start-4 focus-visible:top-4"
    >
      {label}
    </a>
  );
}
