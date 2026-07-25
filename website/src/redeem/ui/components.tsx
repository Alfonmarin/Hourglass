// OurGlass design-system primitives. Ported from the design handoff.
import { type ButtonHTMLAttributes, type ReactNode } from 'react'

export type Status = 'active' | 'pending' | 'revoked'

const STATUS: Record<Status, { label: string; color: string; dot: string; soft: string; line: string }> = {
  active: { label: 'Active', color: '#34D399', dot: '#34D399', soft: 'rgba(52,211,153,.12)', line: 'rgba(52,211,153,.30)' },
  pending: { label: 'Pending', color: '#FBBF24', dot: '#FBBF24', soft: 'rgba(251,191,36,.12)', line: 'rgba(251,191,36,.30)' },
  revoked: { label: 'Revoked', color: '#FB7185', dot: '#FB7185', soft: 'rgba(251,113,133,.12)', line: 'rgba(251,113,133,.28)' },
}

/** The Ripl mark — a fan of strokes that fades grey → white, the streaming-payments signature.
    The viewBox is padded so the rotated lines and their round caps are never clipped;
    the svg renders at 1.5× `size` to compensate, keeping the visual mark ≈ `size`. */
const LogoMark = ({ size = 26 }: { size?: number }) => (
  <svg width={Math.round(size * 1.5)} height={Math.round(size * 1.5)} viewBox="-13 -15 126 126" fill="none" aria-hidden="true" className="block shrink-0">
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
)

export const Logo = ({ size = 40, withWordmark = true }: { size?: number; withWordmark?: boolean }) => (
  <div className="flex items-center gap-2.5 select-none">
    <LogoMark size={size} />
    {withWordmark && (
      <div className="leading-none">
        <div className="font-extrabold tracking-tight text-ink" style={{ fontSize: size * 0.85 }}>
          <span className="text-glow" style={{ color: 'var(--accent)' }}>Hour</span>Glass
        </div>
      </div>
    )}
  </div>
)

export function StatusBadge({ status, size = 'md', variant = 'soft' }: { status: Status; size?: 'sm' | 'md'; variant?: 'soft' | 'outline' }) {
  const s = STATUS[status] || STATUS.pending
  const pad = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'
  const pulse = status === 'active'
  const dot = <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.dot, animation: pulse ? 'spark 1.8s infinite' : 'none' }} />
  if (variant === 'outline') {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${pad}`} style={{ color: s.color, boxShadow: `inset 0 0 0 1px ${s.line}` }}>
        {dot}
        {s.label}
      </span>
    )
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${pad}`} style={{ color: s.color, background: s.soft, boxShadow: `inset 0 0 0 1px ${s.line}` }}>
      {dot}
      {s.label}
    </span>
  )
}

type BtnProps = {
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>

export function Btn({ kind = 'secondary', size = 'md', icon, children, className = '', ...p }: BtnProps) {
  const sz = size === 'lg' ? 'h-12 px-6 text-[15px]' : size === 'sm' ? 'h-9 px-4 text-[13px]' : 'h-11 px-5 text-sm'
  const base = `inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-all duration-150 active:scale-[.98] disabled:opacity-40 disabled:pointer-events-none ${sz} ${className}`
  const styles: Record<string, string> = {
    primary: 'text-[#0a0a0b] bg-[#f5f5f7] hover:bg-white',
    secondary: 'text-ink bg-raised hover:bg-[#232327] ring-1 ring-line2',
    ghost: 'text-dim hover:text-ink hover:bg-raised',
    danger: 'text-danger bg-[rgba(251,113,133,.10)] hover:bg-[rgba(251,113,133,.18)] ring-1 ring-[rgba(251,113,133,.30)]',
  }
  return (
    <button className={`${base} ${styles[kind]}`} {...p}>
      {icon}
      {children}
    </button>
  )
}

export const Card = ({ className = '', hover = false, children, ...p }: { className?: string; hover?: boolean; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) => (
  <div className={`rounded-2xl glass ring-1 ring-line shadow-card ${hover ? 'glow-hover duration-200 hover:ring-line2 hover:-translate-y-0.5' : ''} ${className}`} {...p}>
    {children}
  </div>
)

export const Mono = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <span className={`font-mono ${className}`}>{children}</span>
)

export const Payee = ({ logo, tint, name, addr, size = 40 }: { logo: string; tint: string; name?: string; addr?: string; size?: number }) => (
  <div className="flex items-center gap-3">
    <div className="grid place-items-center rounded-xl font-bold shrink-0" style={{ width: size, height: size, fontSize: size * 0.34, color: tint, background: `${tint}1f`, boxShadow: `inset 0 0 0 1px ${tint}40` }}>
      {logo}
    </div>
    {name && (
      <div className="leading-tight min-w-0">
        <div className="font-semibold text-ink truncate">{name}</div>
        <div className="font-mono text-xs text-faint truncate">{addr}</div>
      </div>
    )}
  </div>
)
