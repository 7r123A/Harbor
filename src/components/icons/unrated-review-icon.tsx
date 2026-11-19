export function UnratedReviewIcon({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 36"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7 2h18a5 5 0 0 1 0 10h-6l-3 4-3-4H7A5 5 0 0 1 7 2Z" />
      {[8, 16, 24].map((x) => (
        <path
          key={x}
          transform={`translate(${x} 7)`}
          d="m0-2.2.7 1.4 1.5.2-1.1 1.1.3 1.5L0 1.3l-1.4.7.3-1.5L-2.2-.6l1.5-.2Z"
          strokeWidth={1.2}
        />
      ))}
      <circle cx={16} cy={26} r={8} />
      <circle cx={16} cy={23.5} r={2.5} />
      <path d="M10 31c1-6 11-6 12 0" />
      <path
        d="m11 21 10 10m0-10L11 31"
        stroke="var(--color-danger, #ef7474)"
        strokeWidth={2.6}
        opacity={0.9}
      />
    </svg>
  );
}
