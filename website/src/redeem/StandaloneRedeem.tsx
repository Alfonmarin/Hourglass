'use client'

import { useMemo, useRef, useState } from 'react'
import { createPublicClient, http, isAddress, erc20Abi, formatUnits, type Address, type PublicClient, type WalletClient } from 'viem'
import { useAccount, useWalletClient, useConnect, useSwitchChain } from 'wagmi'
import { importDelegationsJson, type StoredDelegation } from './lib/storage'
import { useIncomingDelegations } from './hooks/useIncomingDelegations'
import { ipfsToHttp } from './lib/subscriptionTerms'
import { redeemSubscriptionDirect } from './lib/redeemDirect'
import { streamedAvailable } from './lib/streamTerms'
import { MAX_UINT256 } from './lib/streamRate'
import { useClaimState } from './hooks/useClaimState'
import { ClaimProgress } from './ui/ClaimProgress'
import { AnimatedAmount } from './ui/AnimatedAmount'
import { ErrorNotice } from './ui/ErrorNotice'
import { toUserError, validationError, type UserError } from './lib/errors'
import { SELECTABLE_CHAINS, findChain, chainName, explorerTx, rpcUrl } from './config/supported-chains'
import { Card, Btn, StatusBadge, Payee, Mono } from './ui/components'
import { IconCheck, IconExt, IconAlert, IconLock, IconRepeat, IconDoc, IconCube, IconArrowL } from './ui/icons'

const isStream = (d: StoredDelegation) => d.meta.scopeType === 'erc20Streaming'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const tintFor = (addr: string) => {
  const palette = ['#3B82F6', '#22D3EE', '#8B5CF6', '#34D399', '#FB7185', '#FBBF24']
  let h = 0
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

export function StandaloneRedeem() {
  const [chainId, setChainId] = useState(84532)
  const [mode, setMode] = useState<'auto' | 'manual'>('auto')
  const [jsonInput, setJsonInput] = useState('')
  const [sub, setSub] = useState<StoredDelegation | null>(null)
  const [recipient, setRecipient] = useState('')
  const [charging, setCharging] = useState(false)
  const [error, setError] = useState<UserError | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [chargedAmount, setChargedAmount] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  // The live claim amount (raw wei), updated each animation frame so the redeem
  // bills exactly what the ticking counter shows.
  const liveAmountRef = useRef(0n)

  // Claimed / claimable / cap for the loaded delegation, read from the caveat
  // enforcer (stream lifetime cap, or subscription per-period cap).
  const claim = useClaimState(sub)

  const { address, isConnected, chainId: walletChainId } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { connect, connectors } = useConnect()
  const { switchChain, isPending: switching } = useSwitchChain()
  const incoming = useIncomingDelegations()

  function connectWallet() {
    const connector = connectors[0]
    if (connector) connect({ connector })
  }

  function selectDelegation(d: StoredDelegation) {
    setError(null)
    setTxHash(null)
    setSub(d)
    setRecipient(d.meta.recipient ?? '')
    if (SELECTABLE_CHAINS.some((c) => c.id === d.meta.chainId)) setChainId(d.meta.chainId)
  }

  // chainId always comes from the selector (a SELECTABLE_CHAINS id), so it resolves.
  const chain = useMemo(() => findChain(chainId)!, [chainId])

  function parse(text: string) {
    setError(null)
    setTxHash(null)
    try {
      const parsed = importDelegationsJson(text)[0]
      if (!parsed) throw new Error('No subscription found in JSON')
      setSub(parsed)
      setRecipient(parsed.meta.recipient ?? '')
      if (parsed.meta.chainId && SELECTABLE_CHAINS.some((c) => c.id === parsed.meta.chainId)) setChainId(parsed.meta.chainId)
    } catch {
      setSub(null)
      setError(validationError('Invalid delegation', 'Paste the full delegation JSON, including its meta and delegation fields.'))
    }
  }

  function handleFile(file: File) {
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      setJsonInput(text)
      parse(text)
    }
    reader.readAsText(file)
  }

  // Only the delegate (the payee the subscriber signed for) can redeem this delegation.
  const isDelegate = isConnected && !!sub && address?.toLowerCase() === sub.delegation.delegate.toLowerCase()
  const wrongChain = isConnected && walletChainId !== chainId
  const canRedeem = isDelegate && !wrongChain && !!walletClient && !charging

  async function handleRedeem() {
    if (!sub) return
    if (!walletClient) return setError(validationError('Connect your wallet first', 'Connect the payee wallet to redeem.'))
    if (address?.toLowerCase() !== sub.delegation.delegate.toLowerCase())
      return setError(validationError('Wrong wallet', 'Only the payee (delegate) can redeem this delegation.'))
    if (walletChainId !== chainId) return setError(validationError('Wrong network', `Switch your wallet to ${chainName(chainId)} and retry.`))
    if (!isAddress(recipient)) return setError(validationError('Invalid recipient address', 'Enter a valid 0x… address to pay to.'))
    if (liveAmountRef.current <= 0n) return setError(validationError('Nothing to claim yet', 'The claimable amount is zero right now.'))
    setCharging(true)
    setError(null)
    try {
      // Base/baseSepolia carry an OP-stack tx formatter whose client type isn't the
      // generic PublicClient the SDK helper expects.
      const publicClient = createPublicClient({ chain, transport: http(rpcUrl(chainId)) }) as unknown as PublicClient

      // The live counter extrapolates with Date.now(), which runs ahead of the chain's
      // block.timestamp — claiming it overshoots the enforcer's allowance and reverts
      // with allowance-exceeded. Clamp to what the enforcer unlocks at the latest block
      // (always <= the mining block's timestamp, so the redeem stays within allowance).
      let amountRaw = liveAmountRef.current
      if (isStream(sub)) {
        const block = await publicClient.getBlock()
        const unlocked = streamedAvailable({
          amountPerSecondRaw: sub.meta.amountPerSecond ?? '0',
          initialAmountRaw: sub.meta.initialAmount ?? '0',
          maxAmountRaw: sub.meta.maxAmount ?? MAX_UINT256.toString(),
          startTime: sub.meta.startTime ?? 0,
          nowSeconds: Number(block.timestamp),
        })
        const safe = unlocked > claim.claimed ? unlocked - claim.claimed : 0n
        if (amountRaw > safe) amountRaw = safe
      }
      if (amountRaw <= 0n) throw new Error('Nothing to claim yet — try again in a moment.')
      const amountStr = formatUnits(amountRaw, claim.decimals)

      const tokenAddress = sub.meta.tokenAddress
      if (!tokenAddress) throw new Error('Subscription has no token address')
      let decimals = 6
      try {
        decimals = await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' })
      } catch {
        // default USDC decimals
      }
      const hash = await redeemSubscriptionDirect({
        // wagmi's wallet client is a viem WalletClient at runtime.
        walletClient: walletClient as unknown as WalletClient,
        publicClient,
        chainId,
        delegation: sub.delegation,
        token: { address: tokenAddress, decimals },
        amount: amountStr,
        recipient: recipient as Address,
      })
      setChargedAmount(amountStr)
      setTxHash(hash)
    } catch (err) {
      setError(toUserError(err, 'redeem'))
    } finally {
      setCharging(false)
    }
  }

  const httpUri = sub?.meta.agreement && !sub.meta.agreement.uri.startsWith('ipfs://local-') ? ipfsToHttp(sub.meta.agreement.uri) : undefined

  return (
    <div className="og-redeem">
      <main className="max-w-3xl mx-auto px-5 py-10 rise">
        {!txHash && (
          <div className="mb-6 flex items-center justify-end gap-2">
            <label htmlFor="redeem-network" className="text-xs text-faint">Network</label>
            <select id="redeem-network" value={chainId} onChange={(e) => setChainId(Number(e.target.value))} className="h-9 text-sm" style={{ width: 'auto' }}>
              {SELECTABLE_CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
        )}
        {txHash && sub ? (
          <div className="max-w-xl mx-auto">
            <Card className="p-6 text-center">
              <div className="grid place-items-center w-12 h-12 rounded-2xl mx-auto" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', boxShadow: 'inset 0 0 0 1px var(--accent-line)' }}>
                <IconCheck size={24} />
              </div>
              <h2 className="text-lg font-bold text-ink mt-4">Charged</h2>
              <p className="text-sm text-dim mt-1">{chargedAmount} USDC redeemed on-chain — capped by the signed caveat.</p>
              <div className="mt-5 rounded-xl glass-soft ring-1 ring-line p-4 text-left">
                <div className="flex items-center justify-between"><span className="text-xs text-faint">Recipient</span><Mono className="text-xs text-dim">{short(recipient)}</Mono></div>
                <div className="flex items-center justify-between mt-2"><span className="text-xs text-faint">Transaction</span><Mono className="text-xs text-dim">{short(txHash)}</Mono></div>
              </div>
              <div className="mt-5 flex items-center justify-center gap-2">
                {txHash.startsWith('0x') && txHash.length === 66 && (
                  <a href={explorerTx(chainId, txHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-xl glass-soft ring-1 ring-line2 px-3 h-9 text-sm text-ink hover:bg-[#212B43] transition">
                    View on explorer <IconExt size={13} className="opacity-60" />
                  </a>
                )}
                <Btn kind="ghost" onClick={() => { setTxHash(null); setSub(null); setJsonInput(''); setRecipient(''); setChargedAmount(''); liveAmountRef.current = 0n }}>Charge another</Btn>
              </div>
            </Card>
          </div>
        ) : !sub ? (
          <div className="max-w-xl mx-auto">
            <h1 className="text-2xl font-extrabold tracking-tight text-ink">Charge a subscription</h1>
            <p className="text-dim text-sm mt-1">Delegations made to your connected wallet, discovered on Intuition. Pick one to bill this period — or import a signed delegation manually.</p>

            {mode === 'auto' ? (
              <div className="mt-5 space-y-3">
                {!isConnected ? (
                  <Card className="p-6 text-center">
                    <p className="text-sm text-dim">Connect your wallet to see the delegations made to you.</p>
                    <div className="mt-4"><Btn onClick={connectWallet}>Connect wallet</Btn></div>
                  </Card>
                ) : incoming.loading ? (
                  <Card className="p-6 text-center"><p className="text-sm text-faint">Reading delegations from Intuition…</p></Card>
                ) : incoming.error ? (
                  <Card className="p-6 text-center">
                    <p className="text-sm text-dim">Couldn’t read delegations from Intuition.</p>
                    <div className="mt-4"><Btn kind="secondary" onClick={incoming.refetch}>Retry</Btn></div>
                  </Card>
                ) : incoming.delegations.length > 0 ? (
                  incoming.delegations.map((d) => (
                    <button key={d.meta.delegationHash} onClick={() => selectDelegation(d)} className="w-full text-left">
                      <Card className="p-4 flex items-center justify-between gap-4 hover:bg-[#212B43] transition">
                        <Payee logo={d.delegation.delegator.slice(2, 4).toUpperCase()} tint={tintFor(d.delegation.delegator)} name={d.meta.label} addr={`from ${short(d.delegation.delegator)}`} />
                        <span className="font-mono font-semibold text-ink whitespace-nowrap">{isStream(d) ? d.meta.ratePerPeriod : d.meta.amount} <span className="text-dim text-sm">USDC / {isStream(d) ? d.meta.ratePeriod : d.meta.period}</span></span>
                      </Card>
                    </button>
                  ))
                ) : (
                  <Card className="p-6 text-center">
                    <p className="text-sm text-dim">No active delegations found for <Mono className="text-dim">{short(address!)}</Mono>.</p>
                    <p className="text-xs text-faint mt-1">They appear here once a delegation to this wallet is recorded on Intuition. Check that you are connected to the right network.</p>
                  </Card>
                )}
                <div className="text-center pt-1">
                  <button onClick={() => setMode('manual')} className="text-xs text-faint hover:text-dim transition">Import a delegation manually</button>
                </div>
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                <Card className="p-6 space-y-5">
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
                    onClick={() => fileRef.current?.click()}
                    className="rounded-2xl p-8 text-center cursor-pointer transition-colors"
                    style={{ boxShadow: 'inset 0 0 0 1.5px var(--color-line)' }}
                  >
                    <div className="grid place-items-center w-11 h-11 rounded-2xl glass-soft ring-1 ring-line mx-auto text-faint"><IconDoc size={20} /></div>
                    <p className="text-sm text-dim mt-3">Drop the subscription JSON or <span style={{ color: 'var(--accent)' }}>click to browse</span></p>
                    <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
                  </div>
                  <div>
                    <label htmlFor="redeem-json" className="text-sm font-medium text-ink block mb-1.5">Or paste JSON</label>
                    <textarea id="redeem-json" value={jsonInput} onChange={(e) => setJsonInput(e.target.value)} rows={6} placeholder='{"delegation": {…}, "meta": {…}}' className="font-mono text-xs" />
                    <div className="mt-2"><Btn kind="secondary" onClick={() => parse(jsonInput)} disabled={!jsonInput.trim()}>Load subscription</Btn></div>
                  </div>
                  {error && <ErrorNotice error={error} />}
                </Card>
                <div className="text-center pt-1">
                  <button onClick={() => setMode('auto')} className="text-xs text-faint hover:text-dim transition">Back to my delegations</button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-xl mx-auto">
            <button onClick={() => { setSub(null); setError(null) }} className="inline-flex items-center gap-1.5 text-sm text-dim hover:text-ink transition mb-4">
              <IconArrowL size={16} /> Load another
            </button>
            <Card className="p-6">
              <div className="flex items-start justify-between gap-4">
                <Payee logo={(sub.meta.recipient ?? sub.delegation.delegate).slice(2, 4).toUpperCase()} tint={tintFor(sub.meta.recipient ?? sub.delegation.delegate)} name={sub.meta.label} addr={short(sub.meta.recipient ?? sub.delegation.delegate)} />
                <StatusBadge status={sub.meta.status === 'revoked' ? 'revoked' : 'active'} size="sm" />
              </div>

              {isStream(sub) ? (
                <div className="mt-5 rounded-xl glass-soft ring-1 ring-line p-4 flex items-center justify-between">
                  <span className="text-xs text-faint flex items-center gap-1.5"><IconRepeat size={13} /> Accrues</span>
                  <span className="font-mono font-bold text-ink">{sub.meta.ratePerPeriod} <span className="text-dim text-sm font-semibold">USDC / {sub.meta.ratePeriod}</span></span>
                </div>
              ) : (
                <div className="mt-5 rounded-xl glass-soft ring-1 ring-line p-4 flex items-center justify-between">
                  <span className="text-xs text-faint flex items-center gap-1.5"><IconLock size={13} /> Period cap</span>
                  <span className="font-mono font-bold text-ink">{sub.meta.amount} <span className="text-dim text-sm font-semibold">USDC / {sub.meta.period}</span></span>
                </div>
              )}

              <ClaimProgress view={claim} symbol="USDC" />

              {httpUri && (
                <a href={httpUri} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-xs font-mono text-[color:var(--accent)] hover:underline"><IconCube size={12} /> {sub.meta.agreement!.cid.slice(0, 18)}… <IconExt size={10} className="opacity-60" /></a>
              )}

              {!isConnected && (
                <div className="mt-4 rounded-xl px-3 py-3 text-xs leading-relaxed" style={{ background: 'rgba(251,191,36,.08)', boxShadow: 'inset 0 0 0 1px rgba(251,191,36,.25)', color: '#FBBF24' }}>
                  <div className="flex items-center gap-1.5 font-semibold mb-1"><IconAlert size={13} /> Wallet not connected</div>
                  Connect the payee wallet ({short(sub.delegation.delegate)}) to redeem this period on-chain.
                </div>
              )}
              {isConnected && !isDelegate && (
                <div className="mt-4 rounded-xl px-3 py-3 text-xs leading-relaxed" style={{ background: 'rgba(251,191,36,.08)', boxShadow: 'inset 0 0 0 1px rgba(251,191,36,.25)', color: '#FBBF24' }}>
                  <div className="flex items-center gap-1.5 font-semibold mb-1"><IconAlert size={13} /> Wrong wallet</div>
                  Only the payee (delegate) can redeem. This subscription's payee is {short(sub.delegation.delegate)}; you are connected as {short(address!)}.
                </div>
              )}
              {isDelegate && wrongChain && (
                <div className="mt-4 rounded-xl px-3 py-3 text-xs leading-relaxed" style={{ background: 'rgba(251,191,36,.08)', boxShadow: 'inset 0 0 0 1px rgba(251,191,36,.25)', color: '#FBBF24' }}>
                  <div className="flex items-center gap-1.5 font-semibold mb-1"><IconAlert size={13} /> Wrong network</div>
                  <p>This delegation lives on {chainName(chainId)}. Switch your wallet to redeem.</p>
                  <button
                    type="button"
                    onClick={() => switchChain({ chainId })}
                    disabled={switching}
                    className="mt-2 inline-flex h-8 items-center rounded-lg px-3 text-xs font-semibold transition disabled:opacity-60"
                    style={{ background: 'rgba(251,191,36,.16)', boxShadow: 'inset 0 0 0 1px rgba(251,191,36,.4)', color: '#FBBF24' }}
                  >
                    {switching ? 'Switching…' : `Switch to ${chainName(chainId)}`}
                  </button>
                </div>
              )}
              {error && <ErrorNotice error={error} />}

              <div className="mt-5 space-y-4">
                <div>
                  <label htmlFor="redeem-recipient" className="text-sm font-medium text-ink block mb-1.5">Pay to</label>
                  <input id="redeem-recipient" type="text" placeholder="0x… recipient of the funds" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
                  {recipient && !isAddress(recipient) && <p className="text-xs text-danger mt-1">Invalid address</p>}
                </div>
                <div>
                  <label className="text-sm font-medium text-ink block mb-1.5">Claim amount</label>
                  <div className="flex items-baseline gap-2">
                    {claim.loading ? (
                      <span className="font-mono font-bold text-faint tnum" style={{ fontSize: 30 }}>—</span>
                    ) : (
                      <span style={{ fontSize: 30 }} className="leading-none">
                        <AnimatedAmount
                          base={claim.claimable}
                          ratePerSecondRaw={isStream(sub) ? BigInt(sub.meta.amountPerSecond ?? '0') : 0n}
                          decimals={claim.decimals}
                          max={claim.cap !== null ? (claim.cap > claim.claimed ? claim.cap - claim.claimed : 0n) : null}
                          onValue={(raw) => { liveAmountRef.current = raw }}
                        />
                      </span>
                    )}
                    <span className="text-sm text-faint">USDC</span>
                  </div>
                  <p className="text-xs text-faint mt-1">
                    {isStream(sub) ? 'Accrues live by the second. Claims the full amount shown — capped on-chain by the caveat; you pay gas in ETH.' : 'The claimable amount this period. Capped on-chain by the caveat; you pay gas in ETH.'}
                  </p>
                </div>
              </div>

              <div className="mt-6 flex justify-center">
                <Btn onClick={handleRedeem} disabled={!canRedeem}>
                  {charging ? 'Redeeming…' : isStream(sub) ? 'Claim on-chain' : 'Charge on-chain'}
                </Btn>
              </div>
            </Card>
          </div>
        )}
      </main>
    </div>
  )
}
