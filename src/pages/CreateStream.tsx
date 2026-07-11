import { useEffect, useMemo, useRef, useState } from 'react'
import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk'
import { createPublicClient, http, isAddress, parseUnits, formatUnits, type Address, type Hex } from 'viem'
import { createDelegation } from '@metamask/smart-accounts-kit'
import { DeleGatorModuleFactoryABI } from '../config/abis'
import { getAddresses } from '../config/addresses'
import { findChain, USDC_ADDRESS, chainName, rpcUrl } from '../config/supported-chains'
import { DEFAULT_SALT } from '../lib/module'
import { buildDelegationTypedData, computeDelegationHash, type DelegationStruct } from '../lib/delegations'
import { ipfsToHttp, type PinResult } from '../lib/subscriptionTerms'
import {
  buildStreamTerms,
  buildStreamAgreement,
  pinStreamAgreement,
  offlinePinStream,
} from '../lib/streamTerms'
import { MAX_UINT256, perSecondForTotal } from '../lib/streamRate'
import { readErc20Meta } from '../lib/erc20'
import { getEnvironment } from '../lib/environment'
import { saveDelegation, getDelegations, setDelegationIntuition, type StoredDelegation } from '../lib/storage'
import { usePublishToIntuition } from '../hooks/usePublishToIntuition'
import { OrgPicker } from '../ui/OrgPicker'
import { orgSelectionToInput, type OrgSelection } from '../lib/orgSelection'
import { Card, Btn, GaslessButton, USDC, Mono, CopyChip, Payee } from '../ui/components'
import { Block, Field, Segmented, Row, PreviewRow } from '../ui/form'
import { IconCube, IconLock, IconCheck, IconExt, IconHash, IconCal } from '../ui/icons'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const trimAmount = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s)
const trimNum = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '')
// Lock an amount field to a dot decimal: comma → dot, strip anything that isn't
// a digit or a dot (point everywhere, no letters/symbols).
const dec = (v: string) => v.replace(',', '.').replace(/[^\d.]/g, '')
// Duration is a positive number capped at 999 (per unit).
const clampDur = (v: string) => { const n = parseFloat(v); return Number.isFinite(n) && n > 999 ? '999' : v }

const MONTH = 2_592_000

// Three display scales for the rate table. Same per-second flow, shown at each
// scale; the example 150 / 300 / 3600 is exactly half-month / month / 12×month.
const RATE_SCALES = [
  { key: 'fortnight', label: 'Half-month', seconds: 1_296_000 },
  { key: 'month', label: 'Monthly', seconds: MONTH },
  { key: 'year', label: 'Yearly', seconds: 31_104_000 },
]

const DURATION_UNITS = [
  { key: 'year', label: 'years', seconds: 31_557_600 },
  { key: 'month', label: 'months', seconds: 2_592_000 },
  { key: 'week', label: 'weeks', seconds: 604_800 },
  { key: 'day', label: 'days', seconds: 86_400 },
]

const dateStr = (sec: number) => new Date(sec * 1000).toLocaleDateString()
const toDateInput = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)
// The on-chain startTime for a chosen yyyy-mm-dd (local midnight), or `nowSec` when
// unset. Clamped to never predate now, so picking today means "now", not backdated.
const startTimeFor = (startDate: string, nowSec: number) =>
  startDate ? Math.max(nowSec, Math.floor(new Date(`${startDate}T00:00:00`).getTime() / 1000)) : nowSec

type SignStep = 'idle' | 'building' | 'pinning' | 'signing'
type BoundMode = 'revocation' | 'hardcap'

export default function CreateStream() {
  const { sdk, safe } = useSafeAppsSDK()

  // Block 1 — Beneficiary
  const [beneficiaryName, setBeneficiaryName] = useState('')
  const [org, setOrg] = useState<OrgSelection>(null)
  const [recipient, setRecipient] = useState('')

  // Block 2 — Payment details
  const [useCustomToken, setUseCustomToken] = useState(false)
  const [customToken, setCustomToken] = useState('')
  const [tokenMeta, setTokenMeta] = useState<{ name: string; symbol: string; decimals: number } | null>(null)
  const [tokenStatus, setTokenStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [rateAmount, setRateAmount] = useState('')
  const [rateSeconds, setRateSeconds] = useState(MONTH)
  const [upfront, setUpfront] = useState('0')
  // '' = start now; otherwise a yyyy-mm-dd date the stream begins accruing on.
  const [startDate, setStartDate] = useState('')
  const rateRef = useRef<HTMLInputElement>(null)
  const [rateHint, setRateHint] = useState(false)

  // Block 3 — Security / limit
  const [boundMode, setBoundMode] = useState<BoundMode>('revocation')
  const [capDurationN, setCapDurationN] = useState('')
  const [capDurationUnit, setCapDurationUnit] = useState('month')
  const [activeTotal, setActiveTotal] = useState<string | null>(null)

  const [signing, setSigning] = useState(false)
  const [step, setStep] = useState<SignStep>('idle')
  const [pinnedCid, setPinnedCid] = useState<string | null>(null)
  const [signed, setSigned] = useState<StoredDelegation | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A field turns red only once it's been touched (focused then left) still invalid.
  const [touchedBene, setTouchedBene] = useState(false)
  const [touchedRate, setTouchedRate] = useState(false)
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

  const defaultUsdc = USDC_ADDRESS[safe.chainId]
  const tokenAddress = useCustomToken ? customToken : defaultUsdc
  const decimals = useCustomToken ? (tokenMeta?.decimals ?? 6) : 6
  const tokenSymbol = useCustomToken ? (tokenMeta?.symbol ?? 'tokens') : 'USDC'
  const recipientValid = isAddress(recipient)
  const tokenValid = useCustomToken ? (isAddress(customToken) && tokenStatus === 'ok') : (!!tokenAddress && isAddress(tokenAddress))

  // Resolve a custom token's name / symbol / decimals straight from the contract.
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
      } catch (e) {
        console.error('token resolve failed', e)
        if (!cancelled) { setTokenMeta(null); setTokenStatus('error') }
      }
    })()
    return () => { cancelled = true }
  }, [useCustomToken, customToken, safe.chainId])

  const fmt = (raw: bigint) => trimAmount(formatUnits(raw, decimals))
  const upfrontRaw = useMemo<bigint>(() => {
    try { return parseUnits(upfront || '0', decimals) } catch { return 0n }
  }, [upfront, decimals])

  // ---- Rate table ----
  // Cells interlink on the EXACT entered amount (proportional, no quantization),
  // so editing one updates the others 1:1. amountPerSecond is the ceil'd on-chain
  // value, derived only for the preview and signing.
  const amountPerSecond = useMemo<bigint>(() => {
    if (!rateAmount || !tokenValid) return 0n
    try {
      const total = parseUnits(rateAmount, decimals)
      return total > 0n ? perSecondForTotal(total, rateSeconds) : 0n
    } catch { return 0n }
  }, [rateAmount, rateSeconds, tokenValid, decimals])

  function rateCellValue(scaleSeconds: number) {
    if (scaleSeconds === rateSeconds) return rateAmount
    if (!rateAmount) return ''
    try {
      return trimAmount(formatUnits((parseUnits(rateAmount, decimals) * BigInt(scaleSeconds)) / BigInt(rateSeconds), decimals))
    } catch { return '' }
  }
  function onRateChange(scaleSeconds: number, raw: string) {
    setRateSeconds(scaleSeconds)
    setRateAmount(dec(raw))
  }

  // ---- Hard-cap table (pivot = capDurationSeconds, derived from the duration cell) ----
  const capDurationSeconds = useMemo(() => {
    const u = DURATION_UNITS.find((d) => d.key === capDurationUnit)
    const n = parseFloat(capDurationN)
    return u && n > 0 ? Math.round(n * u.seconds) : 0
  }, [capDurationN, capDurationUnit])

  const capMaxRaw = useMemo<bigint>(
    () => upfrontRaw + amountPerSecond * BigInt(capDurationSeconds),
    [upfrontRaw, amountPerSecond, capDurationSeconds],
  )
  const capTotalValue = activeTotal !== null ? activeTotal : capDurationSeconds > 0 ? fmt(capMaxRaw) : ''
  function onTotalChange(raw: string) {
    const v = dec(raw)
    setActiveTotal(v)
    try {
      const totalRaw = parseUnits(v, decimals)
      if (amountPerSecond > 0n && totalRaw > upfrontRaw) {
        const secs = Number((totalRaw - upfrontRaw) / amountPerSecond)
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

  // Beneficiary autocomplete: Safe owners first, then recent recipients (local).
  const beneficiarySuggestions = useMemo(() => {
    const out: { value: string; label: string }[] = []
    const seen = new Set<string>()
    for (const o of safe.owners ?? []) {
      if (!seen.has(o.toLowerCase())) { seen.add(o.toLowerCase()); out.push({ value: o, label: 'Safe owner' }) }
    }
    for (const d of getDelegations()) {
      const r = d.meta.recipient
      if (r && !seen.has(r.toLowerCase())) { seen.add(r.toLowerCase()); out.push({ value: r, label: d.meta.label || 'Recent' }) }
    }
    return out
  }, [safe.owners])

  // ---- Validation ----
  const rateValid = amountPerSecond > 0n
  const capValid = boundMode === 'revocation' || capDurationSeconds > 0
  const ready = recipientValid && rateValid && tokenValid && capValid
  // A required field shows red only once touched (focused then left) and still invalid.
  const errs = {
    beneficiary: touchedBene && !recipientValid,
    rate: touchedRate && !rateValid,
    cap: touchedCap && boundMode === 'hardcap' && capDurationSeconds <= 0,
  }
  function onSignClick() {
    if (!ready) { setTouchedBene(true); setTouchedRate(true); setTouchedCap(true); return }
    handleSign()
  }
  // A hard cap is defined relative to the rate, so the rate must exist first.
  function onLimitChange(mode: BoundMode) {
    if (mode === 'hardcap' && !rateValid) {
      setRateHint(true)
      rateRef.current?.focus()
      return
    }
    setRateHint(false)
    setBoundMode(mode)
  }

  function resolveMaxRaw(): bigint {
    return boundMode === 'revocation' ? MAX_UINT256 : capMaxRaw
  }

  // ---- Preview (always shown; missing required fields render in red) ----
  const now = Math.floor(Date.now() / 1000)
  const perSecondStr = amountPerSecond > 0n ? fmt(amountPerSecond) : ''
  const startTimePreview = startTimeFor(startDate, now)

  async function handleSign() {
    setSigning(true)
    setStep('building')
    setPinnedCid(null)
    setError(null)
    try {
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
      const startTime = startTimeFor(startDate, Math.floor(Date.now() / 1000))
      const aps = amountPerSecond
      const maxRaw = resolveMaxRaw()
      const ratePerPeriod = fmt(aps * BigInt(MONTH))

      const terms = buildStreamTerms({
        organization: { name: beneficiaryName || 'Beneficiary', recipient: recipient as Address, delegate },
        subscriber: { label: 'Payer', account: safe.safeAddress as Address },
        token: { address: tokenAddress as Address, symbol: tokenSymbol, decimals },
        ratePerPeriod,
        ratePeriodSeconds: MONTH,
        amountPerSecondRaw: aps.toString(),
        initialAmountRaw: upfrontRaw.toString(),
        maxAmountRaw: maxRaw.toString(),
        startTime,
      })
      const agreement = buildStreamAgreement({
        id: `stream_${startTime}_${(safe.safeAddress as string).slice(2, 10).toLowerCase()}`,
        chainId: safe.chainId,
        terms,
      })
      setStep('pinning')
      const jwt = import.meta.env.VITE_PINATA_JWT
      const pin: PinResult = jwt ? await pinStreamAgreement(agreement, jwt) : offlinePinStream(agreement)
      setPinnedCid(pin.cid)

      const sdkDelegation = createDelegation({
        to: delegate,
        from: moduleAddress,
        environment: environment as never,
        scope: {
          type: 'erc20Streaming',
          tokenAddress: tokenAddress as Address,
          initialAmount: upfrontRaw,
          maxAmount: maxRaw,
          amountPerSecond: aps,
          startTime,
        } as never,
        salt: agreement.termsHash,
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
          label: beneficiaryName || `${ratePerPeriod} ${tokenSymbol}/month stream`,
          scopeType: 'erc20Streaming',
          createdAt: new Date().toISOString(),
          chainId: safe.chainId,
          safeAddress: safe.safeAddress as Address,
          moduleAddress,
          status: 'signed',
          delegationHash,
          agreement: { cid: pin.cid, uri: pin.uri, termsHash: agreement.termsHash },
          tokenAddress: tokenAddress as Address,
          recipient: recipient as Address,
          amountPerSecond: aps.toString(),
          initialAmount: upfrontRaw.toString(),
          maxAmount: maxRaw.toString(),
          startTime,
          ratePerPeriod,
          ratePeriod: 'month',
        },
      }
      saveDelegation(stored)
      setSigned(stored)

      // Record the signed stream on the Intuition graph (fire-and-forget via the
      // publisher backend — failures never block the create flow).
      publishToIntuition({
        delegation: stored.delegation,
        chainId: safe.chainId,
        details: { kind: 'stream', amount: ratePerPeriod, tokenSymbol, period: 'month' },
        organization: orgSelectionToInput(org),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign stream')
    } finally {
      setSigning(false)
      setStep('idle')
    }
  }

  function reset() {
    setSigned(null)
    setBeneficiaryName('')
    setOrg(null)
    setRecipient('')
    setRateAmount('')
    setRateSeconds(MONTH)
    setUpfront('0')
    setStartDate('')
    setBoundMode('revocation')
    setCapDurationN('')
    setCapDurationUnit('month')
    setActiveTotal(null)
    setError(null)
    setTouchedBene(false)
    setTouchedRate(false)
    setTouchedCap(false)
    setRateHint(false)
    setUseCustomToken(false)
    setCustomToken('')
    setTokenMeta(null)
    setTokenStatus('idle')
  }

  if (signed) {
    const httpUri = signed.meta.agreement && !signed.meta.agreement.uri.startsWith('ipfs://local-')
      ? ipfsToHttp(signed.meta.agreement.uri)
      : undefined
    const unbounded = signed.meta.maxAmount === MAX_UINT256.toString()
    return (
      <div className="rise max-w-2xl">
        <Card className="p-6">
          <div className="flex items-center gap-3">
            <div className="grid place-items-center w-9 h-9 rounded-xl" style={{ background: 'rgba(52,211,153,.14)', color: '#34D399' }}>
              <IconCheck size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-ink">Stream signed</h2>
              <p className="text-sm text-dim">Bound on-chain to the IPFS contract. The balance accrues continuously and the beneficiary can claim anytime.</p>
            </div>
          </div>

          <div className="mt-5 rounded-xl bg-raised ring-1 ring-line divide-y divide-line">
            <Row label="Beneficiary"><Payee logo={((signed.meta.recipient ?? signed.delegation.delegate).slice(2, 4)).toUpperCase()} tint="#22D3EE" name={signed.meta.label} addr={short(signed.meta.recipient ?? signed.delegation.delegate)} size={32} /></Row>
            <Row label="Pay rate"><span className="font-mono font-semibold text-ink">{signed.meta.ratePerPeriod} USDC / month</span></Row>
            <Row label="Total"><span className="font-mono text-ink">{unbounded ? 'Unlimited' : `${trimAmount(formatUnits(BigInt(signed.meta.maxAmount ?? '0'), decimals))} USDC`}</span></Row>
            <Row label="Contract hash"><Mono className="text-xs text-dim">{short(signed.meta.agreement!.termsHash)}</Mono></Row>
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
          <Field label="Name">
            <input type="text" placeholder="Jane Doe" value={beneficiaryName} onChange={(e) => setBeneficiaryName(e.target.value)} />
          </Field>
          <Field label="Address" required missing={errs.beneficiary}>
            <input type="text" placeholder="0x…" list="beneficiary-suggestions" value={recipient} onChange={(e) => setRecipient(e.target.value)} onBlur={() => setTouchedBene(true)} className={errs.beneficiary ? 'ring-1 ring-danger' : ''} />
            <datalist id="beneficiary-suggestions">
              {beneficiarySuggestions.map((s) => <option key={s.value} value={s.value} label={s.label} />)}
            </datalist>
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
          {useCustomToken && (
            <div>
              <input type="text" placeholder="Token 0x…" value={customToken} onChange={(e) => setCustomToken(e.target.value)} />
              {tokenStatus === 'loading' && <p className="text-xs text-faint mt-1">Resolving token…</p>}
              {tokenStatus === 'ok' && tokenMeta && (
                <p className="text-xs text-faint mt-1"><span className="text-ink font-semibold">{tokenMeta.symbol}</span> · {tokenMeta.name} · {tokenMeta.decimals} decimals</p>
              )}
              {tokenStatus === 'error' && customToken && <p className="text-xs text-danger mt-1">Not a readable ERC-20 on {chainName(safe.chainId)} — make sure the token is deployed on this chain.</p>}
            </div>
          )}
          {!useCustomToken && (
            <p className="text-xs text-faint"><span className="text-ink font-semibold">USDC</span> · USD Coin · 6 decimals</p>
          )}

          <Field label="Pay rate" required missing={errs.rate}>
            <div className="grid grid-cols-3 gap-2">
              {RATE_SCALES.map((s, i) => (
                <div key={s.key}>
                  <div className="text-[11px] text-faint mb-1">{s.label}</div>
                  <div className="relative">
                    <input
                      ref={i === 0 ? rateRef : undefined}
                      type="text" inputMode="decimal" placeholder="0"
                      value={rateCellValue(s.seconds)}
                      onChange={(e) => onRateChange(s.seconds, e.target.value)}
                      onFocus={(e) => { e.target.select(); setRateHint(false) }}
                      onBlur={() => setTouchedRate(true)}
                      className={`pr-12 ${errs.rate ? 'ring-1 ring-danger' : ''}`}
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-faint">{tokenSymbol}</span>
                  </div>
                </div>
              ))}
            </div>
            {rateHint && <p className="text-xs text-pending mt-2">Set a pay rate first to fix a limit.</p>}
          </Field>

          <Field label="Upfront payment">
            <div className="relative">
              <input type="text" inputMode="decimal" placeholder="0" value={upfront} onChange={(e) => setUpfront(dec(e.target.value))} onFocus={(e) => e.target.select()} className="pr-16" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">{tokenSymbol}</span>
            </div>
          </Field>

          <Field label="Start of the stream" hint={startDate ? undefined : 'Begins accruing the moment it is signed.'}>
            {/* Native date input drives the picker directly (showPicker() is blocked in
                the Safe cross-origin iframe). Its text is hidden and the picker indicator
                is stretched to fill the field, so a click anywhere opens the calendar,
                while the overlay shows "Now" / the chosen date. */}
            <div className="relative">
              <input
                type="date" lang="en"
                aria-label={`Start of the stream: ${startDate ? dateStr(startTimePreview) : 'now'}`}
                min={toDateInput(now)}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="date-input w-full pl-9"
              />
              <IconCal size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
              <span className="pointer-events-none absolute left-9 top-1/2 -translate-y-1/2 text-sm text-ink">
                {startDate ? dateStr(startTimePreview) : 'Now'}
              </span>
              {startDate && (
                <button
                  type="button"
                  onClick={() => setStartDate('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 z-10 rounded-md px-1.5 py-0.5 text-[11px] text-faint hover:text-ink hover:bg-raised transition"
                >
                  Now
                </button>
              )}
            </div>
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
            <div className={`mt-1 grid grid-cols-[1fr_1.35fr_1fr] rounded-xl ring-1 divide-x divide-line ${errs.cap ? 'ring-danger' : 'ring-line'}`}>
              <div className="p-3">
                <div className="text-[11px] text-faint mb-1.5 text-center uppercase tracking-wide">End date</div>
                <input type="date" lang="en" value={capDurationSeconds > 0 ? toDateInput(now + capDurationSeconds) : ''} onChange={(e) => onEndDateChange(e.target.value)} onBlur={() => setTouchedCap(true)} className="w-full" />
              </div>
              <div className="p-3">
                <div className="text-[11px] text-faint mb-1.5 text-center uppercase tracking-wide">Duration</div>
                <div className="flex gap-1.5">
                  <input type="text" inputMode="decimal" placeholder="3" value={capDurationN} onChange={(e) => setCapDurationN(clampDur(dec(e.target.value)))} onBlur={() => setTouchedCap(true)} className="flex-1 min-w-0 w-0" />
                  <select value={capDurationUnit} onChange={(e) => setCapDurationUnit(e.target.value)} className="flex-1 min-w-0 w-0 px-1 truncate">
                    {DURATION_UNITS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="p-3">
                <div className="text-[11px] text-faint mb-1.5 text-center uppercase tracking-wide">Total budget</div>
                <div className="relative">
                  <input type="text" inputMode="decimal" placeholder="900" value={capTotalValue} onChange={(e) => onTotalChange(e.target.value)} onBlur={() => { setActiveTotal(null); setTouchedCap(true) }} className="w-full pr-12" />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-faint">{tokenSymbol}</span>
                </div>
              </div>
            </div>
            )}
        </Block>
      </div>

      {/* What the erc20Streaming caveat enforces on-chain — not a mirror of the form */}
      <Card className="p-5 flex flex-col">
        <div className="flex items-center gap-2 text-xs font-semibold text-faint uppercase tracking-wide"><IconLock size={15} /> Enforced on-chain</div>

        <div className="mt-4 space-y-3 text-sm">
          <PreviewRow label="Beneficiary">
            {recipientValid ? <Mono className="text-xs text-dim">{short(recipient)}</Mono> : <span className={`text-[11px] ${errs.beneficiary ? 'text-danger' : 'text-faint'}`}>{errs.beneficiary ? 'address required' : 'not set'}</span>}
          </PreviewRow>

          <div className="rounded-xl bg-raised ring-1 ring-line p-3">
            <div className="text-faint text-xs">Flow</div>
            {rateValid ? (
              <div className="font-mono font-bold text-ink tnum mt-0.5" style={{ fontSize: 20 }}>{perSecondStr} <span className="text-dim text-sm font-semibold">{tokenSymbol} / second</span></div>
            ) : (
              <div className={`text-sm font-semibold mt-0.5 ${errs.rate ? 'text-danger' : 'text-faint'}`}>{errs.rate ? 'pay rate required' : 'set a pay rate'}</div>
            )}
          </div>

          <PreviewRow label="Total cap">
            {boundMode === 'revocation' ? (
              <span className="font-mono text-ink">Unlimited</span>
            ) : capDurationSeconds > 0 ? (
              <>
                <span className="font-mono text-ink">{fmt(capMaxRaw)} {tokenSymbol}</span>
                <span className="text-faint text-[11px] block">reached ~{dateStr(now + capDurationSeconds)}</span>
              </>
            ) : (
              <span className={`text-[11px] ${errs.cap ? 'text-danger' : 'text-faint'}`}>{errs.cap ? 'cap required' : 'unlimited until set'}</span>
            )}
          </PreviewRow>

          <PreviewRow label="Upfront"><span className="font-mono text-ink">{trimAmount(upfront || '0')} {tokenSymbol}</span></PreviewRow>

          <PreviewRow label="Starts">
            {startDate ? <span className="font-mono text-ink">{dateStr(startTimePreview)}</span> : <span className="text-ink">Now</span>}
          </PreviewRow>

          <PreviewRow label="Token">
            <span className="text-ink text-xs">{tokenSymbol}{useCustomToken && tokenMeta?.name ? ` · ${tokenMeta.name}` : ''}</span>
            {tokenValid && <Mono className="text-[10px] text-faint block">{short(tokenAddress as string)}</Mono>}
          </PreviewRow>

          <div className="pt-3 border-t border-line">
            <p className="text-[11px] text-faint leading-relaxed">The exact terms the <a href="https://docs.metamask.io/smart-accounts-kit/reference/delegation/caveats#erc20streaming" target="_blank" rel="noreferrer" className="text-[color:var(--accent)] hover:underline">erc20Streaming</a> caveat enforces: flow per second, total cap, beneficiary.</p>
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
            <div className="space-y-2 py-1 text-xs text-dim">
              <div className="flex items-center gap-2"><IconHash size={12} /> {step === 'building' ? 'Building contract…' : step === 'pinning' ? `Pinning to IPFS${pinnedCid ? ` · ${short(pinnedCid)}` : '…'}` : 'Waiting for Safe signature…'}</div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

