interface Props {
  className?: string;
  size?: number;
}

export const SuzaniStar = ({ className = "", size = 360 }: Props) => (
  <svg
    viewBox="0 0 200 200"
    width={size}
    height={size}
    className={className}
    aria-hidden
  >
    <g fill="none" stroke="currentColor" strokeWidth="0.6">
      {/* 8-pointed star */}
      <path d="M100 10 L115 75 L185 65 L130 105 L185 145 L115 135 L100 200 L85 135 L15 145 L70 105 L15 65 L85 75 Z" />
      <circle cx="100" cy="105" r="32" />
      <circle cx="100" cy="105" r="55" />
      <path d="M100 50 L100 160 M45 105 L155 105 M62 67 L138 143 M138 67 L62 143" />
      {/* Small floral dots around */}
      <circle cx="100" cy="35" r="3" fill="currentColor" />
      <circle cx="165" cy="105" r="3" fill="currentColor" />
      <circle cx="100" cy="175" r="3" fill="currentColor" />
      <circle cx="35" cy="105" r="3" fill="currentColor" />
    </g>
  </svg>
);
