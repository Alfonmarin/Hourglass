/**
 * OurGlass mark: a sablier (hourglass) drawn as fanned strokes that brighten
 * from back to front — the "tokens streaming through glass" motif. Ported from
 * the Safe App's `LogoMark` so the website and the app share one identity.
 */
export function LogoMark({ size = 24 }: { size?: number }) {
  const px = Math.round(size * 1.4);
  return (
    <svg
      width={px}
      height={px}
      viewBox="-13 -15 126 126"
      fill="none"
      aria-hidden="true"
      className="block shrink-0"
    >
      <g strokeLinecap="round" strokeWidth="9" fill="none">
        <line x1="50" y1="-8" x2="50" y2="108" stroke="#7a7a7a" transform="rotate(45 50 48)" />
        <line x1="50" y1="-8" x2="50" y2="108" stroke="#909090" transform="rotate(30 50 48)" />
        <line x1="50" y1="-8" x2="50" y2="108" stroke="#a6a6a6" transform="rotate(15 50 48)" />
        <line x1="50" y1="-8" x2="50" y2="108" stroke="#bcbcbc" transform="rotate(0 50 48)" />
        <line x1="50" y1="-8" x2="50" y2="108" stroke="#d2d2d2" transform="rotate(-15 50 48)" />
        <line x1="50" y1="-8" x2="50" y2="108" stroke="#e8e8e8" transform="rotate(-30 50 48)" />
        <line x1="50" y1="-8" x2="50" y2="108" stroke="#ffffff" transform="rotate(-45 50 48)" />
      </g>
    </svg>
  );
}

export function Logo({ size = 24, withWordmark = true }: { size?: number; withWordmark?: boolean }) {
  return (
    <span className="flex items-center gap-2 select-none">
      <LogoMark size={size} />
      {withWordmark && (
        <span className="font-extrabold tracking-tight" style={{ fontSize: size * 0.82 }}>
          <span style={{ color: 'var(--accent)' }}>Hour</span>Glass
        </span>
      )}
    </span>
  );
}
