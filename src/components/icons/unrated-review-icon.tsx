import { useId } from "react";

export function UnratedReviewIcon({ size = 28 }: { size?: number }) {
  const crossMask = useId();
  return (
    <svg
      width={size}
      height={size}
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
      <defs>
        <mask id={crossMask} maskUnits="userSpaceOnUse" x={0} y={0} width={32} height={32}>
          <rect width={32} height={32} fill="white" stroke="none" />
          <circle cx={17.5} cy={27} r={2.8} fill="black" stroke="none" />
        </mask>
      </defs>
      <g mask={`url(#${crossMask})`}>
        <circle cx={16} cy={25} r={6} />
        <circle cx={16} cy={23} r={1.8} />
        <path d="M12 29c.7-4 7.3-4 8 0" />
      </g>
      <path d="m15.7 25.2 3.6 3.6m0-3.6-3.6 3.6" strokeWidth={1.8} />
    </svg>
  );
}
