import type { JSX } from "react";

export function MotionBrandMark({
  size = 26,
  className,
}: {
  size?: number;
  className?: string;
}): JSX.Element {
  const dimension = Number.isFinite(size) && size > 0 ? size : 26;
  return (
    <img
      src="/icons/licketysplit-mark.png"
      width={dimension}
      height={dimension}
      className={className}
      alt="LicketySplit"
      draggable={false}
    />
  );
}
