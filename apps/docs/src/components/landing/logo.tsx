type Props = { size?: number; className?: string };

export function Logo({ size = 32, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="ccremote logo"
    >
      <rect x="2" y="2" width="60" height="60" rx="14" fill="oklch(0.66 0.20 35)" />
      <path
        d="M20 20 L36 32 L20 44"
        stroke="oklch(0.98 0.01 80)"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="40" y="40" width="10" height="6" rx="1.5" fill="oklch(0.98 0.01 80)" />
    </svg>
  );
}

export function LogoMark({ size = 32 }: { size?: number }) {
  return <Logo size={size} />;
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      <Logo size={28} className="inline-block align-text-bottom mr-2" />
      <span className="font-semibold tracking-tight">ccremote</span>
    </span>
  );
}
