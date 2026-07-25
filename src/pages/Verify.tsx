import { getAddresses } from '../config/addresses'
import { SELECTABLE_CHAINS } from '../config/supported-chains'
import { Logo, Card, CopyChip } from '../ui/components'
import { IconShield, IconCheck, IconX, IconExt, IconCube, IconDoc } from '../ui/icons'

// Public, statically-served provenance page. No Safe SDK, no wallet, no chain
// calls — it only renders the canonical (audited) addresses the app uses, so it
// can be hosted anywhere (incl. IPFS) and read even if the main app is down.

const CHAINS = SELECTABLE_CHAINS

const FRAMEWORK_REPO = 'https://github.com/MetaMask/delegation-framework'
const DEPLOYMENTS_DOC = 'https://github.com/MetaMask/delegation-framework/blob/main/documents/Deployments.md'

const AUDITS = [
  { label: 'Consensys Diligence — Aug 2024', url: 'https://diligence.security/audits/2024/08/metamask-delegation-framework/' },
  { label: 'Consensys Diligence — DeleGator, Jun 2024', url: 'https://diligence.consensys.io/audits/2024/06/metamask-delegator/' },
  { label: 'Consensys Diligence — Apr 2025', url: 'https://diligence.security/audits/2025/04/metamask-delegation-framework-april-2025/' },
]

function AddressRow({ label, addr, shared, explorer }: { label: string; addr: string; shared?: boolean; explorer: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-line last:border-0">
      <div className="min-w-0">
        <div className="text-sm text-ink font-medium flex items-center gap-2">
          {label}
          {shared && <span className="text-[10px] font-semibold uppercase tracking-wide text-faint ring-1 ring-line rounded px-1.5 py-0.5">deterministic</span>}
        </div>
        <a
          href={`${explorer}/address/${addr}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 font-mono text-xs text-dim hover:text-[color:var(--accent)] transition break-all mt-0.5"
        >
          {addr}
          <IconExt size={11} className="opacity-60 shrink-0" />
        </a>
      </div>
      <CopyChip value={addr} label="Copy" className="shrink-0" />
    </div>
  )
}

export default function Verify() {
  return (
    <div className="min-h-screen">
      <div className="max-w-[760px] mx-auto px-5 py-10">
        <header className="flex items-center justify-between gap-4 mb-10">
          <Logo />
          <a href="/" className="text-xs text-dim hover:text-ink transition">hourglass.box</a>
        </header>

        <div className="flex items-center gap-2.5 text-[color:var(--accent)] mb-3">
          <IconShield size={20} />
          <span className="text-xs font-semibold uppercase tracking-wide">Provenance &amp; verification</span>
        </div>
        <h1 className="text-3xl font-extrabold tracking-tight text-ink leading-tight">
          OurGlass deploys no custom contracts.
        </h1>
        <p className="text-dim text-[15px] leading-relaxed mt-4">
          Every subscription runs entirely on the{' '}
          <a href={FRAMEWORK_REPO} target="_blank" rel="noreferrer" className="text-ink underline decoration-line hover:decoration-[color:var(--accent)]">
            MetaMask Delegation Framework
          </a>
          {' '}— a set of smart contracts audited by Consensys Diligence. Your signature authorizes exactly one
          thing: a periodic ERC-20 transfer, capped on-chain by an audited enforcer.
        </p>

        {/* What the signature can / cannot do */}
        <Card className="p-6 mt-8">
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">What it allows</div>
              <ul className="space-y-2 text-sm text-dim">
                <li className="flex items-start gap-2"><IconCheck size={15} className="text-active mt-0.5 shrink-0" /> Pull up to a fixed cap, once per period, of one token.</li>
                <li className="flex items-start gap-2"><IconCheck size={15} className="text-active mt-0.5 shrink-0" /> Revocable by you at any time, on-chain.</li>
              </ul>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">What it cannot do</div>
              <ul className="space-y-2 text-sm text-dim">
                <li className="flex items-start gap-2"><IconX size={15} className="text-danger mt-0.5 shrink-0" /> Pull more than the cap, or twice in one period.</li>
                <li className="flex items-start gap-2"><IconX size={15} className="text-danger mt-0.5 shrink-0" /> Move any other asset, or touch the rest of your funds.</li>
              </ul>
            </div>
          </div>
        </Card>

        {/* Contracts */}
        <h2 className="text-lg font-bold text-ink mt-12 mb-1">Contracts in use</h2>
        <p className="text-sm text-dim mb-5">
          These are the exact addresses the app calls. The{' '}
          <span className="text-ink">DelegationManager</span> and enforcer are MetaMask&apos;s deterministic
          deployments — identical on every chain, listed in their official{' '}
          <a href={DEPLOYMENTS_DOC} target="_blank" rel="noreferrer" className="text-[color:var(--accent)] hover:underline">Deployments</a>.
          Only the module factory is deployed per chain.
        </p>

        <div className="space-y-4">
          {CHAINS.map((c) => {
            const a = getAddresses(c.id)
            return (
              <Card key={c.id} className="p-5">
                <div className="text-sm font-semibold text-ink mb-1">{c.label}</div>
                <AddressRow label="DelegationManager" addr={a.delegationManager} shared explorer={c.explorer} />
                <AddressRow label="ERC20PeriodTransferEnforcer" addr={a.erc20PeriodTransferEnforcer} shared explorer={c.explorer} />
                <AddressRow label="DeleGatorModuleFactory" addr={a.delegatorModuleFactory} explorer={c.explorer} />
              </Card>
            )
          })}
        </div>

        {/* Audits */}
        <h2 className="text-lg font-bold text-ink mt-12 mb-1">Audits</h2>
        <p className="text-sm text-dim mb-5">The framework is reviewed by Consensys Diligence. Reports are public.</p>
        <Card className="p-5">
          {AUDITS.map((x) => (
            <a
              key={x.url}
              href={x.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-3 py-2.5 border-b border-line last:border-0 text-sm text-dim hover:text-ink transition"
            >
              <span className="flex items-center gap-2"><IconDoc size={15} className="text-faint" /> {x.label}</span>
              <IconExt size={13} className="opacity-60 shrink-0" />
            </a>
          ))}
        </Card>

        {/* Verify yourself */}
        <h2 className="text-lg font-bold text-ink mt-12 mb-1">Verify it yourself</h2>
        <Card className="p-6 mt-5">
          <ol className="space-y-3 text-sm text-dim">
            <li className="flex gap-3"><span className="font-mono text-faint">1.</span> Open any address above on its block explorer — the verified source is the audited framework, not our code.</li>
            <li className="flex gap-3"><span className="font-mono text-faint">2.</span> Cross-check the DelegationManager and enforcer against MetaMask&apos;s <a href={DEPLOYMENTS_DOC} target="_blank" rel="noreferrer" className="text-[color:var(--accent)] hover:underline">Deployments</a>. They match, byte for byte.</li>
            <li className="flex gap-3"><span className="font-mono text-faint">3.</span> When you sign, confirm in the <span className="text-ink">Safe</span> screen — not in this app — that the <span className="text-ink">delegate</span> and <span className="text-ink">salt</span> are what you expect. Safe renders that screen, so a tampered front-end cannot fake it.</li>
          </ol>
        </Card>

        <div className="mt-12 pt-6 border-t border-line">
          <div className="text-xs font-semibold uppercase tracking-wide text-faint mb-2 flex items-center gap-2"><IconCube size={13} /> What OurGlass itself adds</div>
          <p className="text-sm text-dim leading-relaxed">
            Only an interface and an IPFS-pinned, human-readable copy of each agreement. No custom contract, no
            upgradeable proxy, and no admin key that can move your funds. The on-chain authority is the audited
            framework — nothing else.
          </p>
        </div>
      </div>
    </div>
  )
}
