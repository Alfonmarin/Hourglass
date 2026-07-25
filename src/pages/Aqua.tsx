import { useState } from 'react'
import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk'
import { createPublicClient, erc20Abi, formatUnits, http, parseUnits, type Address, type Hex, type PublicClient } from 'viem'
import { findChain, rpcUrl } from '../config/supported-chains'
import { useSafeTokens } from '../hooks/useSafeTokens'
import { useAquaPositions, type AquaPosition } from '../hooks/useAquaPositions'
import type { HeldToken } from '../lib/safe-balances'
import {
  AQUA_ADDRESS,
  AQUA_SWAPVM_ADDRESS,
  APPROVAL_HEADROOM_MULTIPLIER,
  FEE_PRESETS,
  isAquaSupported,
  withHeadroom,
} from '../config/aqua'
import { buildAmmProgram, randomSalt } from '../lib/aqua/program'
import { buildAquaOrder, strategyHash } from '../lib/aqua/order'
import { buildShipTxs, buildDockTxs, buildTopUpTxs } from '../lib/aqua/ship'
import { saveAquaStrategy, setAquaStrategyStatus } from '../lib/aqua/positions'
import { Card, Btn, CopyChip } from '../ui/components'
import { Block, Field, PreviewRow, Segmented } from '../ui/form'
import { IconCube, IconCheck, IconAlert, IconLock } from '../ui/icons'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const dec = (v: string) => v.replace(',', '.').replace(/[^\d.]/g, '')

type ShipStep = 'idle' | 'sending' | 'done'

export default function Aqua() {
  const { sdk, safe } = useSafeAppsSDK()
  const chainId = safe.chainId
  const safeAddress = safe.safeAddress as Address
  const supported = isAquaSupported(chainId)
  const safeTokens = useSafeTokens(safeAddress, chainId)
  const positions = useAquaPositions(safeAddress, chainId)

  const [token0, setToken0] = useState<HeldToken | null>(null)
  const [token1, setToken1] = useState<HeldToken | null>(null)
  const [amount0, setAmount0] = useState('')
  const [amount1, setAmount1] = useState('')
  const [feeBps, setFeeBps] = useState(FEE_PRESETS[1].feeBps)
  // On by default: an exact approval is spent after roughly one turnover.
  const [headroom, setHeadroom] = useState(true)
  const [step, setStep] = useState<ShipStep>('idle')
  const [shippedHash, setShippedHash] = useState<Hex | null>(null)
  const [error, setError] = useState<string | null>(null)

  const raw = (value: string, token: HeldToken | null): bigint => {
    if (!value || !token) return 0n
    try {
      return parseUnits(value, token.decimals)
    } catch {
      return 0n
    }
  }
  const amount0Raw = raw(amount0, token0)
  const amount1Raw = raw(amount1, token1)
  const samePair = Boolean(token0 && token1 && token0.address === token1.address)
  // Shipping above the Safe's balance is allowed on purpose — see `aboveBalance`
  // in TokenLeg for why it is a strategy choice rather than a mistake.
  const aboveBalance0 = Boolean(token0 && amount0Raw > token0.balance)
  const aboveBalance1 = Boolean(token1 && amount1Raw > token1.balance)

  const preview =
    token0 && token1 && !samePair
      ? (() => {
          const program = buildAmmProgram({ feeBps, salt: '0x00000000' })
          return { program, hash: strategyHash(buildAquaOrder(safeAddress, program)) }
        })()
      : null

  const canShip = Boolean(
    supported && token0 && token1 && !samePair && amount0Raw > 0n && amount1Raw > 0n && step === 'idle',
  )

  /** The Safe's live allowance to Aqua. Read fresh: it is shared across strategies. */
  async function readAllowances(aqua: Address, tokens: Address[]): Promise<bigint[]> {
    const chain = findChain(chainId)
    if (!chain) throw new Error(`Unsupported chain: ${chainId}`)
    const client = createPublicClient({ chain, transport: http(rpcUrl(chainId)) }) as PublicClient
    return Promise.all(
      tokens.map((token) =>
        client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [safeAddress, aqua] }),
      ),
    )
  }

  async function handleShip() {
    if (!token0 || !token1) return
    setError(null)
    setStep('sending')
    try {
      const aqua = AQUA_ADDRESS[chainId]
      const app = AQUA_SWAPVM_ADDRESS[chainId]
      if (!aqua || !app) throw new Error(`Aqua is not wired for chain ${chainId}`)

      // A fresh salt every ship: Aqua burns a strategy hash permanently on dock,
      // so identical terms must still produce a distinct strategy.
      const program = buildAmmProgram({ feeBps, salt: randomSalt() })
      const order = buildAquaOrder(safeAddress, program)
      const hash = strategyHash(order)
      const [allowance0, allowance1] = await readAllowances(aqua, [token0.address, token1.address])
      const approve0 = withHeadroom(amount0Raw, headroom)
      const approve1 = withHeadroom(amount1Raw, headroom)
      const legs = [
        { address: token0.address, amount: amount0Raw, currentAllowance: allowance0, approve: approve0 },
        { address: token1.address, amount: amount1Raw, currentAllowance: allowance1, approve: approve1 },
      ]

      await sdk.txs.send({ txs: buildShipTxs({ aqua, app, order, legs }) })

      saveAquaStrategy({
        chainId,
        safeAddress,
        app,
        strategyHash: hash,
        order: { maker: order.maker, traits: order.traits.toString(), data: order.data },
        tokens: [
          {
            address: token0.address,
            symbol: token0.symbol,
            decimals: token0.decimals,
            shipped: amount0Raw.toString(),
            approved: approve0.toString(),
          },
          {
            address: token1.address,
            symbol: token1.symbol,
            decimals: token1.decimals,
            shipped: amount1Raw.toString(),
            approved: approve1.toString(),
          },
        ],
        feeBps,
        createdAt: new Date().toISOString(),
        status: 'shipped',
      })
      setShippedHash(hash)
      setStep('done')
      positions.refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to ship the strategy')
      setStep('idle')
    }
  }

  async function handleDock(position: AquaPosition) {
    setError(null)
    try {
      const aqua = AQUA_ADDRESS[chainId]
      if (!aqua) throw new Error(`Aqua is not wired for chain ${chainId}`)
      const tokens = position.tokens.map((t) => t.address)
      const allowances = await readAllowances(aqua, tokens)
      await sdk.txs.send({
        txs: buildDockTxs({
          aqua,
          app: position.strategy.app,
          strategyHash: position.strategy.strategyHash,
          // Release only this strategy's share — the allowance backs the others too.
          legs: position.tokens.map((token, i) => ({
            address: token.address,
            currentAllowance: allowances[i],
            release: token.approved ?? token.virtual,
          })),
          releaseAllowance: true,
        }),
      })
      setAquaStrategyStatus(position.strategy.strategyHash, 'docked')
      positions.refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dock the strategy')
    }
  }

  /** Raise the shared allowance back to what every active strategy needs. */
  async function handleTopUp() {
    setError(null)
    try {
      const aqua = AQUA_ADDRESS[chainId]
      if (!aqua) throw new Error(`Aqua is not wired for chain ${chainId}`)
      const shortfall = positions.demand.filter((d) => d.allowance < d.required)
      const txs = buildTopUpTxs(
        aqua,
        shortfall.map((d) => ({
          address: d.address,
          currentAllowance: d.allowance,
          // Same headroom rule as a ship, so a top-up does not immediately run dry.
          required: withHeadroom(d.required, headroom),
        })),
      )
      if (txs.length === 0) return
      await sdk.txs.send({ txs })
      positions.refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore the approvals')
    }
  }

  function reset() {
    setAmount0('')
    setAmount1('')
    setShippedHash(null)
    setStep('idle')
  }

  if (!supported) {
    return (
      <div className="rise">
        <Header />
        <Card className="p-6">
          <p className="text-sm text-dim leading-relaxed">
            Aqua is not available on this chain. It is deployed on Base and eleven other mainnets, with no testnet
            deployment; this app wires Base only, because the strategy encoding was verified against that deployment.
            Switch your Safe to Base to use this page.
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="rise">
      <Header />

      {error && (
        <div className="flex items-center gap-2 text-pending text-sm mb-6">
          <IconAlert size={16} /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(300px,360px)] gap-6 items-stretch">
        <div className="space-y-5">
          <Block title="Pair">
            <p className="text-xs text-dim -mt-1 leading-relaxed">
              Both tokens stay in the Safe. Aqua records a virtual balance and takes an allowance; nothing is
              transferred until a taker swaps.
            </p>
            {safeTokens.loading ? (
              <p className="text-xs text-faint mt-1">Reading tokens held by the Safe…</p>
            ) : safeTokens.tokens.length < 2 ? (
              <p className="text-xs text-faint mt-1">
                This Safe holds fewer than two vetted tokens on this chain, so there is no pair to provide.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <TokenLeg
                  label="First token"
                  tokens={safeTokens.tokens}
                  selected={token0}
                  onSelect={setToken0}
                  amount={amount0}
                  onAmount={setAmount0}
                  aboveBalance={aboveBalance0}
                />
                <TokenLeg
                  label="Second token"
                  tokens={safeTokens.tokens}
                  selected={token1}
                  onSelect={setToken1}
                  amount={amount1}
                  onAmount={setAmount1}
                  aboveBalance={aboveBalance1}
                />
              </div>
            )}
            {samePair && (
              <p className="text-xs text-danger mt-1">A strategy needs two different tokens.</p>
            )}
          </Block>

          <Block
            title="Approval"
            action={
              <Segmented
                value={headroom}
                onChange={setHeadroom}
                options={[
                  { key: true, label: `Headroom ×${APPROVAL_HEADROOM_MULTIPLIER}` },
                  { key: false, label: 'Exact' },
                ]}
              />
            }
          >
            <p className="text-xs text-dim -mt-1 leading-relaxed">
              A swap spends the approval of the token it takes out, and never gives it back — tokens arriving from
              swaps, fees included, sit outside the approval. So an exact approval runs out after roughly one turnover
              and the strategy stops filling. Headroom buys about {APPROVAL_HEADROOM_MULTIPLIER.toString()} turnovers
              before a top-up is needed. Either way the amount is bounded and visible; it is never unlimited.
            </p>
            {token0 && token1 && amount0Raw > 0n && amount1Raw > 0n && (
              <div className="space-y-1">
                {[
                  { token: token0, amount: amount0Raw },
                  { token: token1, amount: amount1Raw },
                ].map(({ token, amount }) => (
                  <div key={token.address} className="flex items-center justify-between text-xs">
                    <span className="text-dim">{token.symbol}</span>
                    <span className="font-mono text-faint tnum">
                      approve <span className="text-ink">{formatUnits(withHeadroom(amount, headroom), token.decimals)}</span>{' '}
                      for {formatUnits(amount, token.decimals)} shipped
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Block>

          <Block title="Fee">
            <p className="text-xs text-dim -mt-1 leading-relaxed">
              Charged on the input of every swap, before the constant-product curve prices it.
            </p>
            <div className="flex gap-2">
              {FEE_PRESETS.map((preset) => (
                <button
                  key={preset.feeBps}
                  type="button"
                  onClick={() => setFeeBps(preset.feeBps)}
                  aria-pressed={feeBps === preset.feeBps}
                  className={`px-3 py-1.5 rounded-xl text-sm font-mono tnum ring-1 transition ${
                    feeBps === preset.feeBps ? 'ring-line2 text-ink glass-soft' : 'ring-line text-dim'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </Block>
        </div>

        <Card className="p-5 flex flex-col">
          <div className="flex items-center gap-2 text-xs font-semibold text-faint uppercase tracking-wide">
            <IconLock size={15} /> Summary
          </div>

          <div className="mt-4 space-y-3 text-sm">
            <div className="rounded-xl bg-raised ring-1 ring-line p-3">
              <div className="text-faint text-xs">Liquidity · stays in the Safe</div>
              {token0 && token1 && amount0Raw > 0n && amount1Raw > 0n ? (
                <div className="font-mono font-bold text-ink tnum mt-0.5" style={{ fontSize: 16 }}>
                  {amount0} {token0.symbol} + {amount1} {token1.symbol}
                </div>
              ) : (
                <div className="text-sm font-semibold text-faint mt-0.5">pick a pair and amounts</div>
              )}
            </div>

            <PreviewRow label="Program">
              {preview ? (
                <CopyChip value={preview.program} className="max-w-full" />
              ) : (
                <span className="text-[11px] text-faint">—</span>
              )}
            </PreviewRow>
            <PreviewRow label="Strategy">
              {preview ? (
                // Shows the short form but copies the full 32 bytes — a truncated
                // hash is not something you can paste into an explorer or a cast call.
                <CopyChip value={preview.hash} label={short(preview.hash)} className="max-w-full" />
              ) : (
                <span className="text-[11px] text-faint">—</span>
              )}
            </PreviewRow>
            <p className="text-[11px] text-faint leading-relaxed">
              The preview uses a zero salt. Each ship draws a fresh one, so the hash it lands under will differ.
            </p>
          </div>

          <div className="mt-auto pt-4 border-t border-line space-y-3">
            {step === 'done' ? (
              <div className="rounded-xl glass-soft ring-1 ring-line p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-active">
                  <IconCheck size={16} /> Strategy shipped.
                </div>
                {shippedHash && (
                  <div className="space-y-1">
                    <div className="text-[11px] text-faint">Shipped under</div>
                    <CopyChip value={shippedHash} label={short(shippedHash)} className="max-w-full" />
                  </div>
                )}
                <Btn kind="secondary" onClick={reset} className="w-full">
                  Ship another
                </Btn>
              </div>
            ) : (
              <Btn kind="primary" size="lg" onClick={handleShip} disabled={!canShip} className="w-full">
                {step === 'sending' ? 'Sending…' : 'Approve and ship'}
              </Btn>
            )}
            <p className="text-[11px] text-faint leading-relaxed">
              One Safe transaction: an approval per token, then the ship.
            </p>
          </div>
        </Card>
      </div>

      <Positions positions={positions} onDock={handleDock} onTopUp={handleTopUp} />
    </div>
  )
}

function Header() {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-extrabold tracking-tight text-ink">Aqua</h1>
      <p className="text-dim text-sm mt-1 max-w-2xl leading-relaxed">
        Provide liquidity to 1inch Aqua without moving funds out of the Safe. You ship a strategy — a token pair, an
        amount and a fee — and Aqua records it as a virtual balance backed by an allowance.
      </p>
      <div className="mt-3 flex items-start gap-2 text-xs text-dim max-w-2xl leading-relaxed rounded-xl ring-1 ring-line p-3">
        <IconAlert size={14} />
        <span>
          A shipped strategy is not tradable yet. Orders become active once submitted to the 1inch API, which requires
          KYB — out of scope here. Until then the position earns nothing, and docking it costs only gas.
        </span>
      </div>
    </div>
  )
}

/**
 * `aboveBalance` is deliberately not an error.
 *
 * Aqua prices against the virtual balance, and pulls the real tokens from the
 * Safe at swap time. Shipping more than the Safe currently holds quotes deeper
 * liquidity — tighter prices — and only reverts on a fill large enough to
 * outrun the wallet. Meanwhile the fee on every swap is pushed straight into
 * the Safe, so the real balance grows toward the shipped size on its own.
 */
function TokenLeg({
  label,
  tokens,
  selected,
  onSelect,
  amount,
  onAmount,
  aboveBalance,
}: {
  label: string
  tokens: HeldToken[]
  selected: HeldToken | null
  onSelect: (token: HeldToken | null) => void
  amount: string
  onAmount: (value: string) => void
  aboveBalance: boolean
}) {
  return (
    <div className="space-y-2">
      <Field label={label} required>
        <select
          aria-label={label}
          value={selected?.address ?? ''}
          onChange={(e) => onSelect(tokens.find((t) => t.address === e.target.value) ?? null)}
          className="px-2"
        >
          <option value="" disabled>
            Select a token…
          </option>
          {tokens.map((t) => (
            <option key={t.address} value={t.address}>
              {t.symbol}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Amount" required>
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => onAmount(dec(e.target.value))}
          aria-label={`${label} amount`}
          className="font-mono"
        />
      </Field>
      {selected && (
        <p className="text-xs text-faint">
          Safe holds {formatUnits(selected.balance, selected.decimals)} {selected.symbol}
        </p>
      )}
      {aboveBalance && (
        <p className="text-xs text-dim leading-relaxed">
          Above the balance — quotes deeper liquidity than the Safe holds. Large fills revert until fees close the gap.
        </p>
      )}
    </div>
  )
}

function Positions({
  positions,
  onDock,
  onTopUp,
}: {
  positions: ReturnType<typeof useAquaPositions>
  onDock: (position: AquaPosition) => void
  onTopUp: () => void
}) {
  const uncovered = positions.demand.filter((d) => d.required > 0n && !d.isCovered)
  const underApproved = uncovered.filter((d) => d.allowance < d.required)
  if (positions.loading) {
    return <p className="text-xs text-faint mt-8">Reading strategies…</p>
  }
  if (positions.positions.length === 0) {
    return (
      <div className="mt-10">
        <h2 className="text-sm font-semibold text-ink mb-2">Strategies</h2>
        <p className="text-xs text-faint leading-relaxed max-w-2xl">
          Nothing shipped from this browser yet. Strategies you ship appear here with their live Aqua balance. The list
          is local — Aqua emits unindexed events, so a strategy shipped from another browser will not show up, though it
          stays live on-chain either way.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-10">
      <h2 className="text-sm font-semibold text-ink mb-3">Strategies</h2>

      {positions.demand.some((d) => d.required > 0n) && (
        <Card className="p-4 mb-3">
          <div className="text-xs font-semibold text-faint uppercase tracking-wide">Coverage</div>
          <p className="text-[11px] text-dim mt-1 leading-relaxed">
            One allowance per token serves every strategy at once, so these totals are what matter, not any single
            strategy's share. A fill is capped by the smaller of the balance and the approval — shipping above them is a
            valid choice, and the fee from each swap lands straight in the Safe, closing the gap over time.
          </p>
          <div className="mt-3 space-y-1">
            {positions.demand
              .filter((d) => d.required > 0n)
              .map((d) => (
                <div key={d.address} className="flex items-center justify-between text-xs">
                  <span className="text-dim">{d.symbol}</span>
                  <span className="font-mono text-faint tnum">
                    needs <span className="text-ink">{formatUnits(d.required, d.decimals)}</span> · held{' '}
                    <span className={d.held < d.required ? 'text-pending' : ''}>{formatUnits(d.held, d.decimals)}</span>{' '}
                    · approved{' '}
                    <span className={d.allowance < d.required ? 'text-pending' : ''}>
                      {formatUnits(d.allowance, d.decimals)}
                    </span>
                  </span>
                </div>
              ))}
          </div>
          {underApproved.length > 0 && (
            <div className="mt-3 pt-3 border-t border-line">
              <p className="text-[11px] text-dim leading-relaxed mb-2">
                {underApproved.some((d) => d.allowance === 0n)
                  ? 'One token has no approval left, so no fill can be served on it. '
                  : 'The approval is below the shipped total, so fills are capped by it rather than by the strategy. '}
                Every pull spends allowance, so this is normal maintenance rather than a fault. Topping up moves no
                tokens.
              </p>
              <Btn kind="primary" onClick={onTopUp}>
                Top up approval
              </Btn>
            </div>
          )}
        </Card>
      )}

      <div className="space-y-2">
        {positions.positions.map((position) => (
          <Card key={position.strategy.strategyHash} className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink flex items-center gap-2">
                  <IconCube size={14} />
                  {position.strategy.tokens.map((t) => t.symbol).join(' / ')}
                  <span className="text-faint font-normal">
                    · {(position.strategy.feeBps / 10_000_000).toFixed(2)}%
                  </span>
                </div>
                <CopyChip
                  value={position.strategy.strategyHash}
                  label={short(position.strategy.strategyHash)}
                  className="mt-1"
                />
              </div>
              <div className="shrink-0 text-right">
                {position.isDocked ? (
                  <span className="text-[11px] text-faint">docked</span>
                ) : position.isBacked ? (
                  <span className="text-[11px] text-active inline-flex items-center gap-1">
                    <IconCheck size={12} /> fully covered
                  </span>
                ) : (
                  <span className="text-[11px] text-faint">partially covered</span>
                )}
              </div>
            </div>

            <div className="mt-3 space-y-1">
              {position.tokens.map((token) => (
                <div key={token.address} className="flex items-center justify-between text-xs">
                  <span className="text-dim">{token.symbol}</span>
                  <span className="font-mono text-faint tnum">
                    <span className="text-ink">{formatUnits(token.virtual, token.decimals)}</span> on Aqua
                  </span>
                </div>
              ))}
            </div>

            {!position.isDocked && !position.isBacked && (
              <p className="text-[11px] text-faint mt-2 leading-relaxed">
                Fills on this pair are capped by the Safe's balance and approval — see Coverage above.
              </p>
            )}

            <div className="mt-3 pt-3 border-t border-line flex items-center gap-2 flex-wrap">
              {!position.isDocked && (
                <Btn kind="secondary" onClick={() => onDock(position)}>
                  Dock and revoke
                </Btn>
              )}
              {/* Everything an independent check needs: rawBalances() takes the
                  hash, and SwapVM.quote() needs the whole order to price it. */}
              <CopyChip
                value={JSON.stringify(
                  {
                    chainId: position.strategy.chainId,
                    aqua: AQUA_ADDRESS[position.strategy.chainId],
                    app: position.strategy.app,
                    strategyHash: position.strategy.strategyHash,
                    order: position.strategy.order,
                    tokens: position.strategy.tokens.map((t) => t.address),
                  },
                  null,
                  2,
                )}
                label="Copy order JSON"
              />
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
