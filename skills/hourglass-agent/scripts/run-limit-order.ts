/**
 * Hourglass limit-order agent — self-contained runner (no repo imports).
 *
 * A limit order is a single price-triggered swap (buy-the-dip). The mandate carries
 * TWO balance-change bounds — a Decrease on the funding token (max spend) and an
 * Increase on the target token (min received) — plus a limitedCalls(1) cap. The
 * min-received bound IS the price trigger: the redeem reverts on-chain unless the
 * swap returns at least that much, i.e. the price is at or below the operator's
 * trigger. limitedCalls(1) makes it fire exactly once.
 *
 * Flow: discover the mandate addressed to this agent on Intuition, match the one in
 * the operator's instruction (recap JSON from the Limit order tab), poll the Uniswap
 * quote until the expected output meets the enforced min-received, then redeem the
 * swap AS THE SAFE. The swap pulls the funding token via Permit2, so the Safe must
 * hold a standing Permit2 allowance for the router (a one-time setup, not part of the
 * redeem); the mandate authorises only the price-bounded swap.
 *
 * Env: AGENT_PRIVATE_KEY, UNISWAP_API_KEY, INTUITION_NETWORK (mainnet|testnet),
 *      optional RPC_URL, optional POLL_SECONDS (default 60), optional MAX_POLLS
 *      (default 0 = run until it fills). Usage: bun run-limit-order.ts <instruction.json>
 *
 * Dependency: viem, @metamask/smart-accounts-kit. Node ≥ 20 (global fetch).
 */
import { readFileSync } from 'node:fs'
import {
  createPublicClient, createWalletClient, http, erc20Abi, isAddress,
  formatUnits, getAddress, hexToBigInt, sliceHex,
  keccak256, encodePacked, encodeAbiParameters, toHex,
  type Address, type Hex, type Chain, type PublicClient, type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, base, baseSepolia, sepolia } from 'viem/chains'
import { createExecution, ExecutionMode, redeemDelegations, type Delegation } from '@metamask/smart-accounts-kit'

/** The Redemption shape redeemDelegations expects (not re-exported by the SDK root). */
type Redemption = { permissionContext: Delegation[]; executions: ReturnType<typeof createExecution>[]; mode: ExecutionMode }

// --- constants (verified against the Hourglass repo) --------------------------

const DELEGATION_MANAGER: Address = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3'

// HourGlass erc20BalanceChange enforcer — every strategy/limit-order bound uses it.
// Deployed only on mainnet (1) + Base mainnet (8453); no mandates elsewhere.
const BALANCE_CHANGE_ENFORCER: Record<number, Address> = {
  [mainnet.id]: '0xf069a9da3987eDA46F711dC40012f3674c6Ad517',
  [base.id]: '0xf069a9da3987eDA46F711dC40012f3674c6Ad517',
}

// HourGlass limitedCalls enforcer — its presence marks a mandate as a limit order.
// The mandate routes every caveat through the HourGlass CREATE2 instances (so the
// whole thing is attributable), so match THIS address, not the canonical one. Same
// on every chain (CREATE2 under bytes32("OURGLASS")); attach only where deployed.
const LIMITED_CALLS_ENFORCER: Record<number, Address> = {
  [mainnet.id]: '0x0c6a3a33d02c7bEb6B066960CE92DF8CC8EA35C8',
  [base.id]: '0x0c6a3a33d02c7bEb6B066960CE92DF8CC8EA35C8',
}

const CHAINS: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [sepolia.id]: sepolia,
}

interface ReadConfig { graphqlUrl: string; delegateTo: Hex; inContextOf: Hex }
const INTUITION: Record<'mainnet' | 'testnet', ReadConfig> = {
  testnet: {
    graphqlUrl: 'https://testnet.intuition.sh/v1/graphql',
    delegateTo: '0xb56980d42a3b03455bf41ea20fe04ae223fca0b9e688994dc661414e81e6433b',
    inContextOf: '0x61a88b9c372c0d164d2caf66947b67ed0fcb4c457178a271b6b3dc39fb1f8862',
  },
  mainnet: {
    graphqlUrl: 'https://mainnet.intuition.sh/v1/graphql',
    // Mainnet "delegate to" is a distinct atom from testnet's — verified against the
    // live graph (the testnet id 0xb569… returns zero triples on mainnet).
    delegateTo: '0xc587d8f586380d2252d01784a3b6b889a50f960af80cc0d8acb4dbd3e2c2c1f5',
    inContextOf: '0x892054b01d389bfe566166120470f572a56e3d4cd88c599b52c4708949625390',
  },
}

// --- types --------------------------------------------------------------------

interface Caveat { enforcer: Address; terms: Hex }
interface DelegationStruct {
  delegate: Address; delegator: Address; authority: Hex
  caveats: Caveat[]; salt: Hex; signature: Hex
}
interface DelegationDocument { name?: string; description?: string; delegation: DelegationStruct }

/** The operator's instruction copied from the Limit order tab (the recap JSON). */
interface Instruction {
  hourglassStrategy: 'limitOrder'
  chainId: number
  safe: Address
  agent: Address
  delegationHash: Hex
  fundingToken: Address
  targetToken: Address
  maxSpend: string
  triggerPrice: string
}

// --- delegation hash (must match the repo exactly) ----------------------------

const DELEGATION_TYPEHASH = keccak256(
  toHex('Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)'),
)
const CAVEAT_TYPEHASH = keccak256(toHex('Caveat(address enforcer,bytes terms)'))

function computeDelegationHash(d: DelegationStruct): Hex {
  const caveatHashes = d.caveats.map((c) =>
    keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }],
      [CAVEAT_TYPEHASH, c.enforcer, keccak256(c.terms)],
    )),
  )
  const caveatsHash = keccak256(encodePacked(caveatHashes.map(() => 'bytes32'), caveatHashes))
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
    [DELEGATION_TYPEHASH, d.delegate, d.delegator, d.authority, caveatsHash, BigInt(d.salt)],
  ))
}

// --- Intuition discovery (inlined) --------------------------------------------

const ATOM_BY_DATA = `query($data: String!) { atoms(where: { data: { _eq: $data } }) { term_id } }`
const RELATIONSHIPS = `query($objectIds: [String!], $pred: String!) {
  triples(where: { predicate: { term_id: { _eq: $pred } }, object_id: { _in: $objectIds } }) {
    term_id subject { data }
  }
}`
const CONTEXT = `query($relIds: [String!], $pred: String!) {
  triples(where: { predicate: { term_id: { _eq: $pred } }, object_id: { _in: $relIds } }) {
    object_id subject { data value { thing { name description } } }
  }
}`

async function gql<T>(url: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) })
  if (!res.ok) throw new Error(`Intuition GraphQL ${res.status}`)
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '))
  if (!body.data) throw new Error('Intuition GraphQL: empty response')
  return body.data
}

const caip10Uri = (chainId: number, address: Address) => `caip10:eip155:${chainId}:${getAddress(address)}`
const ipfsToHttp = (uri: string) => uri.startsWith('ipfs://') ? 'https://gateway.pinata.cloud/ipfs/' + uri.slice(7) : uri

/** erc20BalanceChange terms: enforceDecrease(1) + token(20) + recipient(20) + amount(32) = 73 bytes. */
function decodeBalanceChangeTerms(terms: Hex): { enforceDecrease: boolean; token: Address; amount: bigint } {
  return {
    enforceDecrease: hexToBigInt(sliceHex(terms, 0, 1)) !== 0n,
    token: getAddress(sliceHex(terms, 1, 21)),
    amount: hexToBigInt(sliceHex(terms, 41, 73)),
  }
}

function balanceChangeCaveats(d: DelegationStruct, chainId: number): Caveat[] {
  const enforcer = BALANCE_CHANGE_ENFORCER[chainId]?.toLowerCase()
  if (!enforcer) return []
  return d.caveats.filter((c) => c.enforcer.toLowerCase() === enforcer)
}

function hasLimitedCalls(d: DelegationStruct, chainId: number): boolean {
  const enforcer = LIMITED_CALLS_ENFORCER[chainId]?.toLowerCase()
  return enforcer !== undefined && d.caveats.some((c) => c.enforcer.toLowerCase() === enforcer)
}

interface DiscoveredOrder {
  delegation: DelegationStruct
  fundingToken: Address
  targetToken: Address
  maxSpend: bigint
  minReceived: bigint
  delegationHash: Hex
}

/** Discover limit-order mandates addressed to `agent` on `chainId`. */
async function discoverOrders(
  agent: Address, chainId: number, network: 'mainnet' | 'testnet',
): Promise<DiscoveredOrder[]> {
  const cfg = INTUITION[network]
  const { atoms } = await gql<{ atoms: { term_id: string }[] }>(cfg.graphqlUrl, ATOM_BY_DATA, { data: caip10Uri(chainId, agent) })
  const recipientAtomIds = atoms.map((a) => a.term_id)
  if (recipientAtomIds.length === 0) return []

  const rels = await gql<{ triples: { term_id: string }[] }>(cfg.graphqlUrl, RELATIONSHIPS, { objectIds: recipientAtomIds, pred: cfg.delegateTo })
  if (rels.triples.length === 0) return []

  const ctx = await gql<{ triples: { subject: { data: string } }[] }>(cfg.graphqlUrl, CONTEXT, { relIds: rels.triples.map((t) => t.term_id), pred: cfg.inContextOf })

  const out: DiscoveredOrder[] = []
  for (const t of ctx.triples) {
    const uri = t.subject?.data
    if (!uri || !uri.startsWith('ipfs://')) continue
    try {
      const res = await fetch(ipfsToHttp(uri))
      if (!res.ok) continue
      const doc = (await res.json()) as DelegationDocument
      const delegation = doc?.delegation
      if (!delegation?.delegate) continue
      // A limit order has BOTH bounds (Decrease funding + Increase target) and a
      // limitedCalls cap. Without limitedCalls it's a DCA — skip it here.
      if (!hasLimitedCalls(delegation, chainId)) continue
      const bounds = balanceChangeCaveats(delegation, chainId).map((c) => decodeBalanceChangeTerms(c.terms))
      const decrease = bounds.find((b) => b.enforceDecrease)
      const increase = bounds.find((b) => !b.enforceDecrease)
      if (!decrease || !increase) continue // not a well-formed limit order
      out.push({
        delegation,
        fundingToken: decrease.token,
        targetToken: increase.token,
        maxSpend: decrease.amount,
        minReceived: increase.amount,
        delegationHash: computeDelegationHash(delegation),
      })
    } catch { /* skip unreadable */ }
  }
  return out
}

async function tokenDecimals(client: PublicClient, token: Address): Promise<number> {
  try { return await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }) }
  catch { return 18 }
}

// --- Uniswap Trading API (inlined) --------------------------------------------

const TRADING_API = 'https://trade-api.gateway.uniswap.org/v1'
interface TradingApiTx { to: Address; from: Address; data: Hex; value: string; chainId: number }

function apiHeaders(apiKey: string) {
  return { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'x-universal-router-version': '2.0' }
}
async function apiPost<T>(path: string, apiKey: string, body: unknown): Promise<T> {
  const res = await fetch(`${TRADING_API}${path}`, { method: 'POST', headers: apiHeaders(apiKey), body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`Trading API ${path} failed (${res.status}): ${await res.text()}`)
  return (await res.json()) as T
}

interface Quote { routing: string; quote: unknown; output: bigint }

/** Quote EXACT_INPUT of `amount` funding → target. `output` is the expected out (raw). */
async function quoteSwap(apiKey: string, req: { swapper: Address; tokenIn: Address; tokenOut: Address; amount: string; chainId: number }): Promise<Quote> {
  const q = await apiPost<{ routing: string; quote: { output?: { amount?: string } } }>('/quote', apiKey, {
    swapper: req.swapper, tokenIn: req.tokenIn, tokenOut: req.tokenOut,
    tokenInChainId: String(req.chainId), tokenOutChainId: String(req.chainId),
    amount: req.amount, type: 'EXACT_INPUT', slippageTolerance: 0.5, routingPreference: 'BEST_PRICE',
  })
  // routingPreference only accepts BEST_PRICE | FASTEST now (CLASSIC was deprecated as
  // an INPUT); "CLASSIC" survives only as the response `routing` value, which the caller
  // still checks to reject a non-redeemable UniswapX order. A CLASSIC EXACT_INPUT quote
  // reports the expected out under quote.output.amount.
  const raw = q.quote?.output?.amount
  if (raw === undefined) throw new Error('Trading API quote: no output amount in response')
  return { routing: q.routing, quote: q.quote, output: BigInt(raw) }
}

async function buildSwapTx(apiKey: string, quote: unknown): Promise<TradingApiTx> {
  const body = await apiPost<{ swap: TradingApiTx }>('/swap', apiKey, { quote })
  return body.swap
}

// --- execute ------------------------------------------------------------------

function toSdkDelegation(d: DelegationStruct): Delegation {
  return {
    delegate: d.delegate, delegator: d.delegator, authority: d.authority,
    caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: '0x' as Hex })),
    salt: d.salt, signature: d.signature,
  }
}

async function fillOrder(params: {
  walletClient: WalletClient; publicClient: PublicClient; apiKey: string
  order: DiscoveredOrder; quote: unknown
}): Promise<Hex> {
  const { walletClient, publicClient, apiKey, order, quote } = params
  const delegation = toSdkDelegation(order.delegation)

  // The swap pulls the funding token through Permit2 (Universal Router 2.0), which
  // requires a standing Permit2 allowance for the router on the Safe — a one-time
  // setup, NOT part of this redeem. So the mandate authorises the swap alone: a
  // single execution, a single redemption (compatible with limitedCalls(1)). The
  // Increase bound wraps the swap that delivers the bought token, so it nets true.
  const swap = await buildSwapTx(apiKey, quote)
  const redemptions: Redemption[] = [
    { permissionContext: [delegation], executions: [createExecution({ target: swap.to, value: BigInt(swap.value), callData: swap.data })], mode: ExecutionMode.SingleDefault },
  ]

  // The helper simulates before sending — a min-received / cap revert surfaces here.
  return redeemDelegations(walletClient, publicClient, DELEGATION_MANAGER, redemptions)
}

// --- main ---------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`${name} is not set`); process.exit(1) }
  return v
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function main() {
  const [file] = process.argv.slice(2)
  if (!file) { console.error('usage: bun run-limit-order.ts <instruction.json>'); process.exit(1) }
  const instruction = JSON.parse(readFileSync(file, 'utf8')) as Instruction
  if (instruction.hourglassStrategy !== 'limitOrder') throw new Error(`not a limit-order instruction: ${instruction.hourglassStrategy}`)
  if (!isAddress(instruction.targetToken)) throw new Error(`invalid targetToken: ${instruction.targetToken}`)

  const chainId = instruction.chainId
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain: ${chainId}`)

  const privateKey = requireEnv('AGENT_PRIVATE_KEY') as Hex
  const apiKey = requireEnv('UNISWAP_API_KEY')
  const network = process.env.INTUITION_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
  const rpc = process.env.RPC_URL
  const pollSeconds = Number(process.env.POLL_SECONDS ?? '60')
  const maxPolls = Number(process.env.MAX_POLLS ?? '0') // 0 = until filled

  const account = privateKeyToAccount(privateKey)
  if (account.address.toLowerCase() !== instruction.agent.toLowerCase()) {
    throw new Error(`AGENT_PRIVATE_KEY (${account.address}) does not match the instruction's agent (${instruction.agent})`)
  }
  const publicClient = createPublicClient({ chain, transport: http(rpc) }) as PublicClient
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) })

  console.log(`Limit-order agent ${account.address} on chain ${chainId} (${network})`)

  const orders = await discoverOrders(account.address, chainId, network)
  const order = orders.find((o) => o.delegationHash.toLowerCase() === instruction.delegationHash.toLowerCase())
  if (!order) { console.log('Order from the instruction not found on Intuition yet — is it signed and published?'); return }

  const inDecimals = await tokenDecimals(publicClient, order.fundingToken)
  const outDecimals = await tokenDecimals(publicClient, order.targetToken)
  console.log(`Order: spend up to ${formatUnits(order.maxSpend, inDecimals)} ${order.fundingToken}`)
  console.log(`  fills when the quote returns ≥ ${formatUnits(order.minReceived, outDecimals)} ${order.targetToken} (trigger ${instruction.triggerPrice})`)

  // Poll the market. The min-received bound is enforced on-chain, but quoting first
  // avoids a guaranteed-revert redeem (and the gas it costs) until the dip actually
  // hits. When the expected out clears the bound, redeem.
  let polls = 0
  for (;;) {
    polls += 1
    let quote: Quote
    try {
      quote = await quoteSwap(apiKey, { swapper: instruction.safe, tokenIn: order.fundingToken, tokenOut: order.targetToken, amount: order.maxSpend.toString(), chainId })
    } catch (err) {
      console.error(`  quote failed: ${err instanceof Error ? err.message : err}`)
      if (maxPolls && polls >= maxPolls) { console.log('Max polls reached — stopping.'); return }
      await sleep(pollSeconds * 1000)
      continue
    }

    if (quote.routing !== 'CLASSIC') {
      console.error(`  expected CLASSIC routing, got "${quote.routing}" — cannot redeem; retrying`)
    } else if (quote.output >= order.minReceived) {
      console.log(`  dip hit: quote returns ${formatUnits(quote.output, outDecimals)} ≥ ${formatUnits(order.minReceived, outDecimals)} — filling`)
      try {
        const hash = await fillOrder({ walletClient, publicClient, apiKey, order, quote: quote.quote })
        console.log('  redeemed:', hash)
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        console.log('  status:', receipt.status, 'block', receipt.blockNumber)
        return // limitedCalls(1): a filled order can't fire again
      } catch (err) {
        console.error('  fill failed:', err instanceof Error ? err.message : err)
        // A late price move can revert the redeem — keep polling.
      }
    } else {
      console.log(`  waiting: quote ${formatUnits(quote.output, outDecimals)} < ${formatUnits(order.minReceived, outDecimals)}`)
    }

    if (maxPolls && polls >= maxPolls) { console.log('Max polls reached — order not filled.'); return }
    await sleep(pollSeconds * 1000)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
