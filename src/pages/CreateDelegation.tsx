import { useEffect, useMemo, useRef, useState } from 'react'
import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk'
import { createPublicClient, http, isAddress, parseUnits, formatUnits, type Address, type Hex } from 'viem'
import { createDelegation } from '@metamask/smart-accounts-kit'
import { DeleGatorModuleFactoryABI } from '../config/abis'
import { getAddresses } from '../config/addresses'
import { DEFAULT_SALT } from '../lib/module'
import { buildDelegationTypedData, computeDelegationHash, type DelegationStruct } from '../lib/delegations'
import {
  buildTerms,
  buildAgreementDocument,
  pinAgreement,
  offlinePin,
  ipfsToHttp,
  type AgreementDocument,
  type PinResult,
} from '../lib/subscriptionTerms'
import { periodToSeconds, periodLabel, periodNoun, type PeriodType } from '../lib/enforcers'
import { getEnvironment } from '../lib/environment'
import { saveDelegation, setDelegationIntuition, type StoredDelegation } from '../lib/storage'
import { usePublishToIntuition } from '../hooks/usePublishToIntuition'
import { OrgPicker } from '../ui/OrgPicker'
import { orgSelectionToInput, type OrgSelection } from '../lib/orgSelection'
import { Card, Btn, GaslessButton, USDC, Mono, CopyChip, Payee } from '../ui/components'
import { Block, Field, Segmented, Row, PreviewRow } from '../ui/form'
import { IconCube, IconLock, IconCheck, IconExt, IconHash } from '../ui/icons'
import { findChain, USDC_ADDRESS, rpcUrl, chainName } from '../config/supported-chains'
import { readErc20Meta } from '../lib/erc20'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const trimAmount = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s)
const trimNum = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '')
const dec = (v: string) => v.replace(',', '.').replace(/[^\d.]/g, '')
const dateStr = (sec: number) => new Date(sec * 1000).toLocaleDateString()
const toDateInput = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)

// The four charge periods, shown as an interlinked table — editing any cell sets
// the subscription period and the per-period amount; the others reflect the same
// charge rate proportionally (display only).
const PERIOD_SCALES: { key: PeriodType; label: string }[] = [
  { key: 'weekly', label: 'Weekly' },
  { key: 'biweekly', label: 'Bi-weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'yearly', label: 'Yearly' },
]

const DURATION_UNITS = [
  { key: 'year', label: 'years', seconds: 31_104_000 },
  { key: 'month', label: 'months', seconds: 2_592_000 },
  { key: 'week', label: 'weeks', seconds: 604_800 },
  { key: 'day', label: 'days', seconds: 86_400 },
]

type SignStep = 'idle' | 'building' | 'pinning' | 'signing'
type BoundMode = 'revocation' | 'hardcap'

function StepRow({ done, active, label, sub }: { done?: boolean; active?: boolean; label: string; sub?: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="grid place-items-center w-6 h-6 rounded-full shrink-0 transition"
        style={{
          background: done ? 'rgba(52,211,153,.16)' : active ? 'var(--accent-soft)' : '#1A2236',
          color: done ? '#34D399' : active ? 'var(--accent)' : '#646E86',
          boxShadow: active ? '0 0 0 1px var(--accent-line)' : 'none',
        }}
      >
        {done ? (
          <IconCheck size={14} />
        ) : active ? (
          <span className="w-2.5 h-2.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
        )}
      </div>
      <div className="min-w-0">
        <div className={`text-sm font-medium ${done || active ? 'text-ink' : 'text-faint'}`}>{label}</div>
        {sub && <div className="text-[11px] font-mono text-faint truncate">{sub}</div>}
      </div>
    </div>
  )
}

export default function CreateDelegation() {
  const { sdk, safe } = useSafeAppsSDK()

  // Block 0/1 — Sender + Beneficiary
  const [payeeName, setPayeeName] = useState('')
  const [org, setOrg] = useState<OrgSelection>(null)
  const [recipient, setRecipient] = useState('')

  // Block 2 — Payment details
  const [useCustomToken, setUseCustomToken] = useState(false)
  const [customToken, setCustomToken] = useState('')
  const [tokenMeta, setTokenMeta] = useState<{ name: string; symbol: string; decimals: number } | null>(null)
  const [tokenStatus, setTokenStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [amount, setAmount] = useState('')
  const [period, setPeriod] = useState<PeriodType>('monthly')
  const amountRef = useRef<HTMLInputElement>(null)
  const [rateHint, setRateHint] = useState(false)

  // Block 3 — Security / limit (proportional hard cap = end date / duration / budget)
  const [boundMode, setBoundMode] = useState<BoundMode>('revocation')
  const [capDurationN, setCapDurationN] = useState('')
  const [activeTotal, setActiveTotal] = useState<string | null>(null)
  // Internal pivot unit for the cap; End date and Total budget both drive it.
  const capDurationUnit = 'month'

  const [signing, setSigning] = useState(false)
  const [step, setStep] = useState<SignStep>('idle')
  const [pinnedCid, setPinnedCid] = useState<string | null>(null)
  const [signed, setSigned] = useState<StoredDelegation | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A required field turns red only once touched (focused then left) and still invalid.
  const [touchedBene, setTouchedBene] = useState(false)
  const [touchedAmount, setTouchedAmount] = useState(false)
  const [touchedCap, setTouchedCap] = useState(false)

  const { publish: publishToIntuition, status: intuitionStatus, enabled: intuitionEnabled } =
    usePublishToIntuition()

  // Persist the published DelegationJson atom so the overview can deep-link to the
  // Intuition portal instead of the (possibly offline) IPFS link.
  useEffect(() => {
    if (signed && intuitionStatus.state === 'done' && intuitionStatus.atomId && intuitionStatus.network) {
      setDelegationIntuition(signed.meta.delegationHash, {
        atomId: intuitionStatus.atomId,
        network: intuitionStatus.network,
      })
    }
  }, [signed, intuitionStatus])

  // Resolve a custom token's name / symbol / decimals straight from the contract
  // (read-only — never a manual decimals field).
  useEffect(() => {
    if (!useCustomToken || !isAddress(customToken)) { setTokenMeta(null); setTokenStatus('idle'); return }
    const chain = findChain(safe.chainId)
    if (!chain) { setTokenStatus('error'); return }
    const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
    let cancelled = false
    setTokenStatus('loading')
    ;(async () => {
      try {
        const meta = await readErc20Meta(client, customToken as Address)
        if (!cancelled) { setTokenMeta(meta); setTokenStatus('ok') }
      } catch {
        if (!cancelled) { setTokenMeta(null); setTokenStatus('error') }
      }
    })()
    return () => { cancelled = true }
  }, [useCustomToken, customToken, safe.chainId])

  const defaultUsdc = USDC_ADDRESS[safe.chainId]
  const tokenAddress = useCustomToken ? customToken : defaultUsdc
  const decimals = useCustomToken ? (tokenMeta?.decimals ?? 6) : 6
  const tokenSymbol = useCustomToken ? (tokenMeta?.symbol ?? 'tokens') : 'USDC'

  const recipientValid = isAddress(recipient)
  const tokenValid = useCustomToken ? (isAddress(customToken) && tokenStatus === 'ok') : (!!tokenAddress && isAddress(tokenAddress))
  const periodSeconds = Number(periodToSeconds(period))

  const fmt = (raw: bigint) => trimAmount(formatUnits(raw, decimals))
  const amountRaw = useMemo<bigint>(() => {
    try { return amount ? parseUnits(amount, decimals) : 0n } catch { return 0n }
  }, [amount, decimals])
  const amountValid = amountRaw > 0n && tokenValid

  // ---- Hard-cap table (pivot = capDurationSeconds). Budget = amount × periods. ----
  const capDurationSeconds = useMemo(() => {
    const u = DURATION_UNITS.find((d) => d.key === capDurationUnit)
    const n = parseFloat(capDurationN)
    return u && n > 0 ? Math.round(n * u.seconds) : 0
  }, [capDurationN, capDurationUnit])

  const capBudgetRaw = useMemo<bigint>(
    () => (amountRaw > 0n && periodSeconds > 0 ? (amountRaw * BigInt(capDurationSeconds)) / BigInt(periodSeconds) : 0n),
    [amountRaw, capDurationSeconds, periodSeconds],
  )
  const capTotalValue = activeTotal !== null ? activeTotal : capDurationSeconds > 0 ? fmt(capBudgetRaw) : ''
  function onTotalChange(raw: string) {
    const v = dec(raw)
    setActiveTotal(v)
    try {
      const budgetRaw = parseUnits(v, decimals)
      if (amountRaw > 0n && budgetRaw > 0n) {
        const secs = Number((budgetRaw * BigInt(periodSeconds)) / amountRaw)
        const u = DURATION_UNITS.find((d) => d.key === capDurationUnit)!
        setCapDurationN(trimNum(secs / u.seconds))
      }
    } catch {
      /* partial input */
    }
  }
  function onEndDateChange(v: string) {
    const endSec = Math.floor(new Date(v).getTime() / 1000)
    const nowSec = Math.floor(Date.now() / 1000)
    if (Number.isFinite(endSec) && endSec > nowSec) {
      const u = DURATION_UNITS.find((d) => d.key === capDurationUnit)!
      setCapDurationN(trimNum((endSec - nowSec) / u.seconds))
    }
  }

  // ---- Validation ----
  const capValid = boundMode === 'revocation' || capDurationSeconds > 0
  const ready = recipientValid && amountValid && tokenValid && capValid
  const errs = {
    beneficiary: touchedBene && !recipientValid,
    amount: touchedAmount && !amountValid,
    cap: touchedCap && boundMode === 'hardcap' && capDurationSeconds <= 0,
  }
  // A hard cap is defined relative to the charge, so an amount must exist first.
  function onLimitChange(mode: BoundMode) {
    if (mode === 'hardcap' && !amountValid) {
      setRateHint(true)
      amountRef.current?.focus()
      return
    }
    setRateHint(false)
    setBoundMode(mode)
  }
  function onSignClick() {
    if (!ready) { setTouchedBene(true); setTouchedAmount(true); setTouchedCap(true); return }
    handleSign()
  }

  const now = Math.floor(Date.now() / 1000)
  const periodsCount = capDurationSeconds > 0 && periodSeconds > 0 ? capDurationSeconds / periodSeconds : 0

  // Live agreement preview — recomputed as the form changes, so the contract
  // hash the subscriber commits to is visible before signing.
  const preview = useMemo<AgreementDocument | null>(() => {
    if (!amountValid || !tokenValid || !recipientValid) return null
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      const endDate = boundMode === 'hardcap' && capDurationSeconds > 0 ? nowSec + capDurationSeconds : null
      const terms = buildTerms({
        organization: { name: payeeName || 'Organization', recipient: recipient as Address, delegate: recipient as Address },
        subscriber: { label: 'Safe', account: safe.safeAddress as Address },
        token: { address: tokenAddress as Address, symbol: tokenSymbol, decimals },
        amountPerPeriod: amount,
        periodSeconds,
        endDate,
      })
      return buildAgreementDocument({ id: 'preview', chainId: safe.chainId, terms })
    } catch {
      return null
    }
  }, [amount, amountValid, tokenValid, recipientValid, tokenAddress, decimals, tokenSymbol, payeeName, recipient, periodSeconds, boundMode, capDurationSeconds, safe.chainId, safe.safeAddress])

  async function handleSign() {
    setSigning(true)
    setStep('building')
    setPinnedCid(null)
    setError(null)
    try {
      // The payee is the delegate: it redeems the delegation directly on-chain.
      const delegate = recipient as Address
      const chain = findChain(safe.chainId)
      if (!chain) throw new Error(`Unsupported chain: ${safe.chainId}`)
      const client = createPublicClient({ chain, transport: http(rpcUrl(safe.chainId)) })
      const addrs = getAddresses(safe.chainId)

      const moduleAddress = (await client.readContract({
        address: addrs.delegatorModuleFactory,
        abi: DeleGatorModuleFactoryABI,
        functionName: 'predictAddress',
        args: [safe.safeAddress as Address, DEFAULT_SALT],
      })) as Address

      const environment = getEnvironment(safe.chainId)
      const nowSec = Math.floor(Date.now() / 1000)
      // The hard cap is an end date enforced by the timestamp caveat; the budget is
      // its implied total (amount × periods), informational only.
      const expiryTs = boundMode === 'hardcap' && capDurationSeconds > 0 ? nowSec + capDurationSeconds : undefined

      // Pin the human-readable contract and bind the signature to it: salt = keccak256(terms).
      const terms = buildTerms({
        organization: { name: payeeName || 'Organization', recipient: recipient as Address, delegate },
        subscriber: { label: 'Safe', account: safe.safeAddress as Address },
        token: { address: tokenAddress as Address, symbol: tokenSymbol, decimals },
        amountPerPeriod: amount,
        periodSeconds,
        startDate: nowSec,
        endDate: expiryTs ?? null,
      })
      const agreement = buildAgreementDocument({
        id: `sub_${nowSec}_${(safe.safeAddress as string).slice(2, 10).toLowerCase()}`,
        chainId: safe.chainId,
        terms,
      })
      setStep('pinning')
      const jwt = import.meta.env.VITE_PINATA_JWT
      const pin: PinResult = jwt ? await pinAgreement(agreement, jwt) : offlinePin(agreement)
      setPinnedCid(pin.cid)
      const salt = agreement.termsHash

      const additionalCaveats = expiryTs
        ? [{ type: 'timestamp' as const, afterThreshold: nowSec, beforeThreshold: expiryTs }]
        : undefined

      const sdkDelegation = createDelegation({
        to: delegate,
        from: moduleAddress,
        environment: environment as never,
        scope: {
          type: 'erc20PeriodTransfer',
          tokenAddress: tokenAddress as Address,
          periodAmount: parseUnits(amount, decimals),
          periodDuration: periodSeconds,
          startDate: nowSec,
        } as never,
        caveats: additionalCaveats as never,
        salt,
      }) as { delegate: Address; delegator: Address; authority: Hex; caveats: { enforcer: Address; terms: Hex }[]; salt: Hex }

      const delegation: DelegationStruct = {
        delegate: sdkDelegation.delegate,
        delegator: sdkDelegation.delegator,
        authority: sdkDelegation.authority,
        caveats: sdkDelegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
        salt: sdkDelegation.salt,
        signature: '0x',
      }

      setStep('signing')
      const typedData = buildDelegationTypedData(delegation, safe.chainId)
      const result = (await sdk.txs.signTypedMessage(typedData as never)) as { signature?: Hex; safeTxHash?: Hex }
      const delegationHash = computeDelegationHash(delegation)

      const stored: StoredDelegation = {
        delegation: { ...delegation, signature: (result?.signature || result?.safeTxHash || '0x') as Hex },
        meta: {
          label: payeeName || `${amount} ${tokenSymbol} ${periodLabel(period)}`,
          scopeType: 'erc20SpendingLimit',
          createdAt: new Date().toISOString(),
          chainId: safe.chainId,
          safeAddress: safe.safeAddress as Address,
          moduleAddress,
          status: 'signed',
          delegationHash,
          agreement: { cid: pin.cid, uri: pin.uri, termsHash: agreement.termsHash },
          amount,
          period,
          tokenAddress: tokenAddress as Address,
          expiryDate: expiryTs ? new Date(expiryTs * 1000).toISOString() : undefined,
          recipient: recipient as Address,
        },
      }
      saveDelegation(stored)
      setSigned(stored)

      // Record the signed delegation on the Intuition graph (fire-and-forget via
      // the publisher backend — failures never block the create flow).
      publishToIntuition({
        delegation: stored.delegation,
        chainId: safe.chainId,
        details: { kind: 'subscription', amount, tokenSymbol, period: periodNoun(period) },
        organization: orgSelectionToInput(org),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign subscription')
    } finally {
      setSigning(false)
      setStep('idle')
    }
  }

  function reset() {
    setSigned(null)
    setPayeeName('')
    setOrg(null)
    setRecipient('')
    setAmount('')
    setPeriod('monthly')
    setUseCustomToken(false)
    setCustomToken('')
    setTokenMeta(null)
    setTokenStatus('idle')
    setBoundMode('revocation')
    setCapDurationN('')
    setActiveTotal(null)
    setError(null)
    setTouchedBene(false)
    setTouchedAmount(false)
    setTouchedCap(false)
    setRateHint(false)
  }

  if (signed) {
    const httpUri = signed.meta.agreement && !signed.meta.agreement.uri.startsWith('ipfs://local-')
      ? ipfsToHttp(signed.meta.agreement.uri)
      : undefined
    return (
      <div className="rise max-w-2xl">
        <Card className="p-6">
          <div className="flex items-center gap-3">
            <div className="grid place-items-center w-9 h-9 rounded-xl" style={{ background: 'rgba(52,211,153,.14)', color: '#34D399' }}>
              <IconCheck size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-ink">Subscription signed</h2>
              <p className="text-sm text-dim">Bound on-chain to the IPFS contract. The biller can now charge it every period.</p>
            </div>
          </div>

          <div className="mt-5 rounded-xl bg-raised ring-1 ring-line divide-y divide-line">
            <Row label="Beneficiary"><Payee logo={((signed.meta.recipient ?? signed.delegation.delegate).slice(2, 4)).toUpperCase()} tint="#3B82F6" name={signed.meta.label} addr={short(signed.meta.recipient ?? signed.delegation.delegate)} size={32} /></Row>
            <Row label="Charge"><span className="font-mono font-semibold text-ink">{signed.meta.amount} {signed.meta.tokenAddress ? 'USDC' : ''} / {signed.meta.period}</span></Row>
            <Row label="Contract hash"><Mono className="text-xs text-dim">{short(signed.meta.agreement!.termsHash)}</Mono></Row>
            <Row label="Delegation hash"><Mono className="text-xs text-dim">{short(signed.meta.delegationHash)}</Mono></Row>
            <Row label="Intuition">
              <Mono className="text-xs text-dim">
                {!intuitionEnabled && 'publishing not configured'}
                {intuitionEnabled && intuitionStatus.state === 'publishing' && 'recording on graph…'}
                {intuitionEnabled && intuitionStatus.state === 'done' && 'recorded on graph'}
                {intuitionEnabled && intuitionStatus.state === 'error' && `not recorded — ${intuitionStatus.message}`}
                {intuitionEnabled && intuitionStatus.state === 'idle' && '—'}
              </Mono>
            </Row>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {httpUri && (
              <a href={httpUri} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-raised ring-1 ring-line2 px-3 h-9 text-sm text-ink hover:bg-[#212B43] transition">
                <IconCube size={15} /> View IPFS contract <IconExt size={13} className="opacity-60" />
              </a>
            )}
            <CopyChip value={JSON.stringify(signed, null, 2)} label="Copy delegation JSON" />
            <Btn kind="ghost" onClick={reset}>Create another</Btn>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="rise grid grid-cols-1 lg:grid-cols-[1fr_minmax(300px,360px)] gap-6 items-stretch">
      {/* Form */}
      <div className="space-y-5">
        {error && (
          <div className="rounded-xl px-3 py-2 text-sm text-danger" style={{ background: 'rgba(251,113,133,.10)', boxShadow: 'inset 0 0 0 1px rgba(251,113,133,.30)' }}>
            {error}
          </div>
        )}

        {/* Block 0 — Sender (this Safe and the org that owns it) */}
        <Block title="Sender">
          <Field label="Organization" hint="The org that owns this Safe — reuse one from Intuition or create it. Recorded as “org owns Safe”. Optional.">
            <OrgPicker safeAddress={safe.safeAddress as Address} safeChainId={safe.chainId} value={org} onChange={setOrg} />
          </Field>
        </Block>

        {/* Block 1 — Beneficiary */}
        <Block title="Beneficiary">
          <Field label="Name" hint="Shown in your subscriptions list. Optional.">
            <input type="text" placeholder="Acme Inc." value={payeeName} onChange={(e) => setPayeeName(e.target.value)} />
          </Field>
          <Field label="Address" required missing={errs.beneficiary}>
            <input type="text" placeholder="0x…" value={recipient} onChange={(e) => setRecipient(e.target.value)} onBlur={() => setTouchedBene(true)} className={errs.beneficiary || (recipient && !recipientValid) ? 'ring-1 ring-danger' : ''} />
            {recipient && !recipientValid && <p className="text-xs text-danger mt-1">Invalid address</p>}
          </Field>
        </Block>

        {/* Block 2 — Payment details */}
        <Block
          title="Payment details"
          action={
            <Segmented
              value={useCustomToken}
              onChange={setUseCustomToken}
              options={[{ key: false, label: <USDC size={15} /> }, { key: true, label: 'Custom ERC-20' }]}
            />
          }
        >
          {useCustomToken ? (
            <div>
              <input type="text" placeholder="Token 0x…" value={customToken} onChange={(e) => setCustomToken(e.target.value)} />
              {tokenStatus === 'loading' && <p className="text-xs text-faint mt-1">Resolving token…</p>}
              {tokenStatus === 'ok' && tokenMeta && (
                <p className="text-xs text-faint mt-1"><span className="text-ink font-semibold">{tokenMeta.symbol}</span> · {tokenMeta.name} · {tokenMeta.decimals} decimals</p>
              )}
              {tokenStatus === 'error' && customToken && <p className="text-xs text-danger mt-1">Not a readable ERC-20 on {chainName(safe.chainId)} — make sure the token is deployed on this chain.</p>}
            </div>
          ) : (
            <p className="text-xs text-faint"><span className="text-ink font-semibold">USDC</span> · USD Coin · 6 decimals</p>
          )}

          <Field label="Cap per period" required missing={errs.amount} hint="The most that can be charged in one period. It resets each period — unused amounts don't roll over.">
            <div className="grid grid-cols-[1fr_140px] gap-2">
              <div className="relative">
                <input
                  ref={amountRef}
                  type="text" inputMode="decimal" placeholder="100"
                  value={amount}
                  onChange={(e) => setAmount(dec(e.target.value))}
                  onFocus={(e) => { e.target.select(); setRateHint(false) }}
                  onBlur={() => setTouchedAmount(true)}
                  className={`pr-12 ${errs.amount ? 'ring-1 ring-danger' : ''}`}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">{tokenSymbol}</span>
              </div>
              <select value={period} onChange={(e) => setPeriod(e.target.value as PeriodType)} className="px-2">
                {PERIOD_SCALES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
            {rateHint && <p className="text-xs text-pending mt-2">Set a cap first to fix a limit.</p>}
          </Field>
        </Block>

        {/* Block 3 — Security / limit */}
        <Block
          title="Security / limit"
          action={
            <Segmented
              value={boundMode}
              onChange={onLimitChange}
              options={[{ key: 'revocation', label: 'Revocation only' }, { key: 'hardcap', label: 'Hard cap' }]}
            />
          }
        >
          {boundMode === 'hardcap' && (
            <div className={`mt-1 grid grid-cols-2 rounded-xl ring-1 divide-x divide-line ${errs.cap ? 'ring-danger' : 'ring-line'}`}>
              <div className="p-3">
                <div className="text-[11px] text-faint mb-1.5 text-center uppercase tracking-wide">End date</div>
                <input type="date" lang="en" value={capDurationSeconds > 0 ? toDateInput(now + capDurationSeconds) : ''} onChange={(e) => onEndDateChange(e.target.value)} onBlur={() => setTouchedCap(true)} className="w-full" />
              </div>
              <div className="p-3">
                <div className="text-[11px] text-faint mb-1.5 text-center uppercase tracking-wide">Total budget</div>
                <div className="relative">
                  <input type="text" inputMode="decimal" placeholder="600" value={capTotalValue} onChange={(e) => onTotalChange(e.target.value)} onBlur={() => { setActiveTotal(null); setTouchedCap(true) }} className="w-full pr-12" />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-faint">{tokenSymbol}</span>
                </div>
              </div>
            </div>
          )}
        </Block>
      </div>

      {/* What the erc20PeriodTransfer caveat enforces on-chain — not a mirror of the form */}
      <Card className="p-5 flex flex-col">
        <div className="flex items-center gap-2 text-xs font-semibold text-faint uppercase tracking-wide"><IconLock size={15} /> Enforced on-chain</div>

        <div className="mt-4 space-y-3 text-sm">
          <PreviewRow label="Beneficiary">
            {recipientValid ? <Mono className="text-xs text-dim">{short(recipient)}</Mono> : <span className={`text-[11px] ${errs.beneficiary ? 'text-danger' : 'text-faint'}`}>{errs.beneficiary ? 'address required' : 'not set'}</span>}
          </PreviewRow>

          <div className="rounded-xl bg-raised ring-1 ring-line p-3">
            <div className="text-faint text-xs">Charge</div>
            {amountValid ? (
              <div className="font-mono font-bold text-ink tnum mt-0.5" style={{ fontSize: 20 }}>{trimAmount(amount)} <span className="text-dim text-sm font-semibold">{tokenSymbol} / {periodNoun(period)}</span></div>
            ) : (
              <div className={`text-sm font-semibold mt-0.5 ${errs.amount ? 'text-danger' : 'text-faint'}`}>{errs.amount ? 'amount required' : 'set a charge amount'}</div>
            )}
          </div>

          <PreviewRow label="Cap">
            {amountValid ? (
              <>
                <span className="font-mono text-ink">{trimAmount(amount)} {tokenSymbol}</span>
                <span className="text-faint text-[11px] block">resets each {periodNoun(period)}, never twice</span>
              </>
            ) : (
              <span className="text-[11px] text-faint">per-period cap</span>
            )}
          </PreviewRow>

          <PreviewRow label="Budget">
            {boundMode === 'revocation' ? (
              <span className="font-mono text-ink">Unlimited</span>
            ) : capDurationSeconds > 0 && amountValid ? (
              <>
                <span className="font-mono text-ink">{fmt(capBudgetRaw)} {tokenSymbol}</span>
                <span className="text-faint text-[11px] block">≈ {Math.round(periodsCount)} × {trimAmount(amount)} {tokenSymbol}, ends {dateStr(now + capDurationSeconds)}</span>
              </>
            ) : (
              <span className={`text-[11px] ${errs.cap ? 'text-danger' : 'text-faint'}`}>{errs.cap ? 'cap required' : 'set an end date'}</span>
            )}
          </PreviewRow>

          <PreviewRow label="Token">
            <span className="text-ink text-xs">{tokenSymbol}</span>
            {tokenValid && <Mono className="text-[10px] text-faint block">{short(tokenAddress as string)}</Mono>}
          </PreviewRow>

          <div className="pt-3 border-t border-line">
            <p className="text-[11px] text-faint leading-relaxed">The exact terms the <a href="https://docs.metamask.io/smart-accounts-kit/reference/delegation/caveats#erc20periodtransfer" target="_blank" rel="noreferrer" className="text-[color:var(--accent)] hover:underline">erc20PeriodTransfer</a> caveat enforces: token, amount per period, period. Total budget is the implied cap until the end date; the beneficiary is chosen at charge time, not by the caveat.</p>
            {preview && (
              <div className="mt-2">
                <div className="flex items-center gap-1.5 text-xs text-faint"><IconHash size={12} /> Bound contract hash</div>
                <Mono className="text-[11px] text-dim break-all mt-1 block">{preview.termsHash}</Mono>
              </div>
            )}
          </div>
        </div>

        <div className="mt-auto pt-4 border-t border-line space-y-3">
          {step === 'idle' ? (
            <>
              <div className="flex items-center gap-2 text-xs text-dim">
                <IconCube size={14} style={{ color: 'var(--accent)' }} /> Pinned to IPFS, hash bound to your signature.
              </div>
              <GaslessButton size="lg" onClick={onSignClick} disabled={signing} className="w-full">Pin &amp; sign</GaslessButton>
              {!ready && <p className="text-[11px] text-faint text-center">Fill the required fields to sign.</p>}
            </>
          ) : (
            <div className="space-y-3 py-1">
              <StepRow done={step === 'pinning' || step === 'signing'} active={step === 'building'} label="Building human-readable contract" />
              <StepRow
                done={step === 'signing'}
                active={step === 'pinning'}
                label="Pinning to IPFS"
                sub={step === 'pinning' ? 'pinning…' : pinnedCid ? `CID ${short(pinnedCid)}` : undefined}
              />
              <StepRow active={step === 'signing'} label="Safe signature" sub={step === 'signing' ? 'waiting for signers…' : undefined} />
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
