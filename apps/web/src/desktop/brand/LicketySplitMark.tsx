import type { JSX } from "react";

export function LicketySplitMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}): JSX.Element {
  const dimension = Number.isFinite(size) && size > 0 ? size : 24;
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
