/** Original LicketySplit mark, kept at the requested display size. */
export function Logo({ className = "", size }: { className?: string; size?: number }) {
  return <img src="/icons/licketysplit-mark.png" alt="" aria-hidden="true" className={className} width={size} height={size} />;
}
