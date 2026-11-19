export function UnratedReviewIcon() {
  return (
    <svg
      width={28}
      height={28}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 2h22a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4 4-4-4H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
      {[9, 16, 23].map((x) => (
        <path
          key={x}
          transform={`translate(${x} 8)`}
          d="m0-2.5.8 1.6 1.8.3-1.3 1.2.3 1.8L0 1.5l-1.6.9.3-1.8-1.3-1.2 1.8-.3Z"
        />
      ))}
      <path d="M16 31a6 6 0 1 1 6-6" />
      <circle cx={16} cy={24} r={1.8} />
      <path d="M12.5 29a3.8 3.8 0 0 1 5.5-2M18.5 26.5l4 4m0-4-4 4" />
    </svg>
  );
}
