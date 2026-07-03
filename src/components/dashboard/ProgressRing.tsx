interface ProgressRingProps {
  /** 0–100 */
  value: number;
  size?: number;
  stroke?: number;
  className?: string;
  /** Center label; defaults to `${value}%`. Pass null to hide. */
  label?: React.ReactNode;
}

/**
 * A compact circular progress indicator (teal accent) for course/module
 * completion. Animates the arc on value change; respects reduced motion via CSS.
 */
export function ProgressRing({ value, size = 56, stroke = 5, className, label }: ProgressRingProps) {
  const v = Math.max(0, Math.min(100, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (v / 100) * c;
  return (
    <div className={`relative inline-flex items-center justify-center ${className ?? ""}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="hsl(var(--primary))" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 600ms cubic-bezier(0.16,1,0.3,1)" }}
        />
      </svg>
      {label !== null && (
        <span className="absolute inset-0 flex items-center justify-center text-[13px] font-semibold tabular-nums">
          {label ?? `${v}%`}
        </span>
      )}
    </div>
  );
}

export default ProgressRing;
