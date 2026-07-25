import { useEffect, useState } from 'react'
import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk'
import { createPublicClient, http, parseUnits, formatUnits, erc20Abi, type Address, type Hex } from 'viem'
import { useUniswapPools } from '../hooks/useUniswapPools'
import { buildDepositPlan } from '../lib/uniswapPosition'
import { buildYieldDelegations, buildStoredYieldPlan, type StoredYieldPlan } from '../lib/yieldDelegations'
import { buildDelegationTypedData } from '../lib/delegations'
import { getEnvironment } from '../lib/environment'
import { getAddresses } from '../config/addresses'
import { DeleGatorModuleFactoryABI } from '../config/abis'
import { DEFAULT_SALT } from '../lib/module'
import { findChain, rpcUrl } from '../config/supported-chains'
import type { PoolInfo } from '../lib/uniswapDiscovery'
import { Card, Btn, Mono, CopyChip } from '../ui/components'
import { Block, Field } from '../ui/form'
import { IconTrend, IconAlert, IconCheck } from '../ui/icons'

const feeLabel = (fee: number) => `${(fee / 10_000).toFixed(2)}%`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

// A signed delegation grants a real permission; keep the window it stays
// redeemable short rather than open-ended.
const DEADLINE_SECONDS = 3600

type DelegateStep = 'idle' | 'preparing' | 'signing' | 'done'

export default function Yield() {
  const { sdk, safe } = useSafeAppsSDK()
  const { loading, error, pools } = useUniswapPools(safe.chainId)
  const [selectedPool, setSelectedPool] = useState<PoolInfo | null>(null)
  const [amount0, setAmount0] = useState('')
  const [amount1, setAmount1] = useState('')
  const [balances, setBalances] = useState<{ token0: bigint; token1: bigint } | null>(null)
  const [step, setStep] = useState<DelegateStep>('idle')
  const [signingIndex, setSigningIndex] = useState(0)
  const [planError, setPlanError] = useState<string | null>(null)
  const [storedPlan, setStoredPlan] = useState<StoredYieldPlan | null>(null)

  const recommended = pools[0] ?? null
  const pool = selectedPool ?? recommended
  // Vite env vars are untyped strings; this one is optional (panel stays
  // disabled below when unset) and never validated as a real address beyond that.
  const agentAddress = import.meta.env.VITE_YIELD_AGENT_ADDRESS as Address | undefined

  useEffect(() => {
    if (!pool) {
      setBalances(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const chain = findChain(safe.chainId)
      if (!chain) return
      const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
      // safe.safeAddress from the Safe Apps SDK is typed as a plain string, not viem's Address.
      const safeAddress = safe.safeAddress as Address
      const [token0, token1] = await Promise.all([
        client.readContract({ address: pool.token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [safeAddress] }),
        client.readContract({ address: pool.token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [safeAddress] }),
      ])
      if (!cancelled) setBalances({ token0, token1 })
    })()
    return () => {
      cancelled = true
    }
  }, [pool, safe.chainId, safe.safeAddress])

  const amount0Raw = pool && amount0 ? parseUnits(amount0, pool.token0.decimals) : 0n
  const amount1Raw = pool && amount1 ? parseUnits(amount1, pool.token1.decimals) : 0n
  const hasBalance0 = balances ? amount0Raw <= balances.token0 : false
  const hasBalance1 = balances ? amount1Raw <= balances.token1 : false
  const canDelegate = Boolean(pool && agentAddress && amount0Raw > 0n && amount1Raw > 0n && hasBalance0 && hasBalance1)

  async function handleDelegate() {
    if (!pool || !agentAddress) return
    setPlanError(null)
    setStoredPlan(null)
    setStep('preparing')
    try {
      const chain = findChain(safe.chainId)
      if (!chain) throw new Error(`Unsupported chain: ${safe.chainId}`)
      const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
      const addrs = getAddresses(safe.chainId)
      // safe.safeAddress from the Safe Apps SDK is typed as a plain string, not viem's Address.
      const safeAddress = safe.safeAddress as Address
      // readContract's return type is generic over the ABI; predictAddress's single
      // output is known (from DeleGatorModuleFactoryABI) to be an address.
      const moduleAddress = (await client.readContract({
        address: addrs.delegatorModuleFactory,
        abi: DeleGatorModuleFactoryABI,
        functionName: 'predictAddress',
        args: [safeAddress, DEFAULT_SALT],
      })) as Address

      const plan = buildDepositPlan({
        pool,
        amount0: amount0Raw,
        amount1: amount1Raw,
        recipient: safeAddress,
        chainId: safe.chainId,
        deadlineSeconds: DEADLINE_SECONDS,
      })

      const environment = getEnvironment(safe.chainId)
      const yieldDelegations = buildYieldDelegations({
        plan,
        moduleAddress,
        agentAddress,
        environment,
        deadlineSeconds: DEADLINE_SECONDS,
      })

      setStep('signing')
      const signatures: Hex[] = []
      for (let i = 0; i < yieldDelegations.length; i++) {
        setSigningIndex(i)
        const typedData = buildDelegationTypedData(yieldDelegations[i].delegation, safe.chainId)
        // sdk.txs.signTypedMessage's parameter type doesn't match our EIP-712 typed-data
        // shape (same cast as the existing CreateDelegation.tsx signing flow); its
        // resolved value is likewise typed loosely by the SDK, narrowed to the two
        // fields this app actually reads off it.
        const result = (await sdk.txs.signTypedMessage(typedData as never)) as { signature?: Hex; safeTxHash?: Hex }
        // Both fields are already hex strings from the SDK; '0x' is the empty-signature fallback.
        signatures.push((result?.signature || result?.safeTxHash || '0x') as Hex)
      }

      setStoredPlan(
        buildStoredYieldPlan({
          plan,
          yieldDelegations,
          signatures,
          chainId: safe.chainId,
          safeAddress,
          moduleAddress,
          agentAddress,
        }),
      )
      setStep('done')
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Failed to build the delegation plan')
      setStep('idle')
    }
  }

  function downloadPlan() {
    if (!storedPlan) return
    const blob = new Blob([JSON.stringify(storedPlan, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `yield-plan-${storedPlan.pool.address.slice(2, 8)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rise">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Yield</h1>
        <p className="text-dim text-sm mt-1">
          Real Uniswap v3 pools on Base Sepolia, ranked by fee APY and depth. Depositing needs both tokens in the Safe
          already and a signed delegation the agent redeems on its own.
        </p>
      </div>

      {loading ? (
        <div className="text-dim text-sm mb-6 flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-line border-t-[color:var(--accent)] rounded-full animate-spin" /> Scanning pools…
        </div>
      ) : error ? (
        <Card className="p-4 mb-6">
          <div className="flex items-center gap-2 text-pending text-sm font-medium">
            <IconAlert size={16} /> {error}
          </div>
        </Card>
      ) : pools.length === 0 ? (
        <Card className="p-5 mb-6">
          <div className="text-sm font-semibold text-ink">No pools found</div>
          <p className="text-xs text-dim mt-1 leading-relaxed">
            No Uniswap v3 pool exists yet on Base Sepolia for the token pairs OurGlass tracks (WETH / USDC). Nothing to
            recommend.
          </p>
        </Card>
      ) : (
        <div className="space-y-2 mb-6">
          {pools.map((p) => {
            const active = pool?.poolAddress === p.poolAddress
            const isRecommended = p.poolAddress === recommended?.poolAddress
            return (
              <Card
                key={p.poolAddress}
                hover
                onClick={() => setSelectedPool(p)}
                className={`p-4 cursor-pointer flex items-center justify-between gap-4 ${active ? 'ring-line2' : ''}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="grid place-items-center w-9 h-9 rounded-xl shrink-0" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                    <IconTrend size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-ink flex items-center gap-2">
                      {p.token0.symbol} / {p.token1.symbol}
                      <span className="text-faint font-normal">· {feeLabel(p.fee)}</span>
                      {isRecommended && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>
                          <IconCheck size={12} /> recommended
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-faint truncate">{short(p.poolAddress)}</div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono text-sm text-ink tnum">{p.apy !== null ? `${(p.apy * 100).toFixed(1)}% APY` : 'insufficient data'}</div>
                  <div className="text-[11px] text-faint mt-0.5">
                    {formatUnits(p.tvlToken0, p.token0.decimals)} {p.token0.symbol} + {formatUnits(p.tvlToken1, p.token1.decimals)} {p.token1.symbol}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {pool && (
        <Block title="Delegate to agent">
          <p className="text-xs text-dim -mt-1 leading-relaxed">
            Signs 3 single-use delegations — approve {pool.token0.symbol}, approve {pool.token1.symbol}, mint a full-range
            position — each pinned to an exact, pre-built transaction. The agent wallet redeems them itself; it cannot
            change the target, method, amount, or recipient.
          </p>

          {!agentAddress && (
            <div className="flex items-center gap-2 text-pending text-sm">
              <IconAlert size={16} /> Set VITE_YIELD_AGENT_ADDRESS to enable delegating to the agent.
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field label={`${pool.token0.symbol} amount`} required missing={amount0Raw > 0n && !hasBalance0}>
              <input
                value={amount0}
                onChange={(e) => setAmount0(e.target.value)}
                placeholder="0.00"
                aria-label={`${pool.token0.symbol} amount`}
                className={`font-mono ${amount0Raw > 0n && !hasBalance0 ? 'ring-1 ring-danger' : ''}`}
              />
              {balances && (
                <p className="text-xs text-faint mt-1">
                  Safe holds {formatUnits(balances.token0, pool.token0.decimals)} {pool.token0.symbol}
                </p>
              )}
            </Field>
            <Field label={`${pool.token1.symbol} amount`} required missing={amount1Raw > 0n && !hasBalance1}>
              <input
                value={amount1}
                onChange={(e) => setAmount1(e.target.value)}
                placeholder="0.00"
                aria-label={`${pool.token1.symbol} amount`}
                className={`font-mono ${amount1Raw > 0n && !hasBalance1 ? 'ring-1 ring-danger' : ''}`}
              />
              {balances && (
                <p className="text-xs text-faint mt-1">
                  Safe holds {formatUnits(balances.token1, pool.token1.decimals)} {pool.token1.symbol}
                </p>
              )}
            </Field>
          </div>

          {planError && (
            <div className="flex items-center gap-2 text-pending text-sm">
              <IconAlert size={16} /> {planError}
            </div>
          )}

          {step === 'done' && storedPlan ? (
            <div className="rounded-xl glass-soft ring-1 ring-line p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-active">
                <IconCheck size={16} /> Plan signed — 3 delegations ready for the agent.
              </div>
              <div className="text-xs text-dim">
                Agent wallet: <Mono>{short(storedPlan.agentAddress)}</Mono>
              </div>
              <div className="flex items-center gap-2">
                <Btn kind="primary" onClick={downloadPlan}>
                  Download plan.json
                </Btn>
                <CopyChip value={JSON.stringify(storedPlan)} label="Copy plan JSON" />
              </div>
            </div>
          ) : (
            <Btn kind="primary" size="lg" onClick={handleDelegate} disabled={!canDelegate || step !== 'idle'}>
              {step === 'preparing' ? 'Preparing…' : step === 'signing' ? `Signing ${signingIndex + 1} of 3…` : 'Sign delegations'}
            </Btn>
          )}
        </Block>
      )}
    </div>
  )
}
