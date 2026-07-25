/**
 * Hourglass DCA agent — self-contained runner (no repo imports).
 *
 * Flow: discover the strategy mandates addressed to this agent on Intuition,
 * match the one named in the operator's instruction (the recap JSON copied from
 * the Strategy tab), build the swap via the Uniswap Trading API (CLASSIC + legacy
 * approval), and redeem approve+swap in one atomic redeemDelegations — executed
 * AS THE SAFE, capped on-chain by the mandate's erc20BalanceChange.
 *
 * The mandate (the cap + the delegate) is discovered on-chain/Intuition. The DCA
 * intent (target token, amount, cadence) is NOT on-chain — it comes from the
 * instruction, keyed to the mandate by delegationHash.
 *
 * Env: AGENT_PRIVATE_KEY, UNISWAP_API_KEY, INTUITION_NETWORK (mainnet|testnet),
 *      optional RPC_URL. Usage: bun run-dca.ts <path-to-instruction.json>
 *
 * Dependency: viem, @metamask/smart-accounts-kit. Node ≥ 20 (global fetch).
 */
import { readFileSync } from 'node:fs'
import {
  createPublicClient, createWalletClient, http, erc20Abi, parseUnits, isAddress,
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

// HourGlass erc20BalanceChange enforcer — the sole match key for strategy mandates.
// Deployed only on mainnet (1) + Base mainnet (8453); no strategy mandates elsewhere.
const BALANCE_CHANGE_ENFORCER: Record<number, Address> = {
  [mainnet.id]: '0xf069a9da3987eDA46F711dC40012f3674c6Ad517',
  [base.id]: '0xf069a9da3987eDA46F711dC40012f3674c6Ad517',
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

/** The operator's instruction copied from the Strategy tab (the recap JSON). */
interface Instruction {
  hourglassStrategy: 'dca'
  chainId: number
  safe: Address
  agent: Address
  delegationHash: Hex
  fundingToken: Address
  targetToken: Address
  amountPerBuy: string
  frequency: string
  capPerSwap: string
  /** Max price (funding per target). The min-received Increase bound enforces it
   *  on-chain; the agent should also set the router's minimum-out to match so the
   *  swap fails off-chain gracefully instead of reverting the redeem. May be null. */
  maxPrice: string | null
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

interface DiscoveredMandate { delegation: DelegationStruct; fundingToken: Address; capPerSwap: string; delegationHash: Hex }

/** Discover strategy (DCA) mandates addressed to `agent` on `chainId`. */
async function discoverMandates(
  agent: Address, chainId: number, network: 'mainnet' | 'testnet', publicClient: PublicClient,
): Promise<DiscoveredMandate[]> {
  const cfg = INTUITION[network]
  const { atoms } = await gql<{ atoms: { term_id: string }[] }>(cfg.graphqlUrl, ATOM_BY_DATA, { data: caip10Uri(chainId, agent) })
  const recipientAtomIds = atoms.map((a) => a.term_id)
  if (recipientAtomIds.length === 0) return []

  const rels = await gql<{ triples: { term_id: string }[] }>(cfg.graphqlUrl, RELATIONSHIPS, { objectIds: recipientAtomIds, pred: cfg.delegateTo })
  if (rels.triples.length === 0) return []

  const ctx = await gql<{ triples: { subject: { data: string } }[] }>(cfg.graphqlUrl, CONTEXT, { relIds: rels.triples.map((t) => t.term_id), pred: cfg.inContextOf })

  const out: DiscoveredMandate[] = []
  for (const t of ctx.triples) {
    const uri = t.subject?.data
    if (!uri || !uri.startsWith('ipfs://')) continue
    try {
      const res = await fetch(ipfsToHttp(uri))
      if (!res.ok) continue
      const doc = (await res.json()) as DelegationDocument
      const delegation = doc?.delegation
      if (!delegation?.delegate) continue
      // A strategy mandate has one or two balance-change caveats: a Decrease on
      // the funding token (the max-spend cap — its token IS the funding token),
      // and optionally an Increase on the bought token (the price floor). Identify
      // the funding token from the Decrease bound.
      const bounds = balanceChangeCaveats(delegation, chainId).map((c) => decodeBalanceChangeTerms(c.terms))
      const decrease = bounds.find((b) => b.enforceDecrease)
      if (!decrease) continue // not a strategy mandate on this chain
      const decimals = await tokenDecimals(publicClient, decrease.token)
      out.push({ delegation, fundingToken: decrease.token, capPerSwap: formatUnits(decrease.amount, decimals), delegationHash: computeDelegationHash(delegation) })
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

async function checkApproval(apiKey: string, p: { walletAddress: Address; token: Address; amount: string; chainId: number }): Promise<TradingApiTx | null> {
  const body = await apiPost<{ approval: TradingApiTx | null }>('/check_approval', apiKey, p)
  return body.approval ?? null
}

async function buildSwap(apiKey: string, req: { swapper: Address; tokenIn: Address; tokenOut: Address; amount: string; chainId: number }): Promise<TradingApiTx> {
  const quote = await apiPost<{ routing: string; quote: unknown }>('/quote', apiKey, {
    swapper: req.swapper, tokenIn: req.tokenIn, tokenOut: req.tokenOut,
    tokenInChainId: String(req.chainId), tokenOutChainId: String(req.chainId),
    amount: req.amount, type: 'EXACT_INPUT', slippageTolerance: 0.5, routingPreference: 'BEST_PRICE',
  })
  if (quote.routing !== 'CLASSIC') throw new Error(`expected CLASSIC routing, got "${quote.routing}" — cannot redeem a non-router swap`)
  const body = await apiPost<{ swap: TradingApiTx }>('/swap', apiKey, { quote: quote.quote })
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

async function executeDca(params: {
  walletClient: WalletClient; publicClient: PublicClient; apiKey: string
  mandate: DiscoveredMandate; safe: Address; targetToken: Address; amountIn: bigint; chainId: number
}): Promise<Hex> {
  const { walletClient, publicClient, apiKey, mandate, safe, targetToken, amountIn, chainId } = params
  const delegation = toSdkDelegation(mandate.delegation)

  const approval = await checkApproval(apiKey, { walletAddress: safe, token: mandate.fundingToken, amount: amountIn.toString(), chainId })
  const swap = await buildSwap(apiKey, { swapper: safe, tokenIn: mandate.fundingToken, tokenOut: targetToken, amount: amountIn.toString(), chainId })

  const redemptions: Redemption[] = []
  if (approval) {
    redemptions.push({ permissionContext: [delegation], executions: [createExecution({ target: approval.to, value: 0n, callData: approval.data })], mode: ExecutionMode.SingleDefault })
  }
  redemptions.push({ permissionContext: [delegation], executions: [createExecution({ target: swap.to, value: BigInt(swap.value), callData: swap.data })], mode: ExecutionMode.SingleDefault })

  // The helper simulates before sending — a cap-exceeded / bad-route revert surfaces here.
  return redeemDelegations(walletClient, publicClient, DELEGATION_MANAGER, redemptions)
}

// --- main ---------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`${name} is not set`); process.exit(1) }
  return v
}

async function main() {
  const [file] = process.argv.slice(2)
  if (!file) { console.error('usage: bun run-dca.ts <instruction.json>'); process.exit(1) }
  const instruction = JSON.parse(readFileSync(file, 'utf8')) as Instruction
  if (instruction.hourglassStrategy !== 'dca') throw new Error(`not a DCA instruction: ${instruction.hourglassStrategy}`)
  if (!isAddress(instruction.targetToken)) throw new Error(`invalid targetToken: ${instruction.targetToken}`)

  const chainId = instruction.chainId
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain: ${chainId}`)

  const privateKey = requireEnv('AGENT_PRIVATE_KEY') as Hex
  const apiKey = requireEnv('UNISWAP_API_KEY')
  const network = process.env.INTUITION_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
  const rpc = process.env.RPC_URL

  const account = privateKeyToAccount(privateKey)
  if (account.address.toLowerCase() !== instruction.agent.toLowerCase()) {
    throw new Error(`AGENT_PRIVATE_KEY (${account.address}) does not match the instruction's agent (${instruction.agent})`)
  }
  const publicClient = createPublicClient({ chain, transport: http(rpc) }) as PublicClient
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) })

  console.log(`DCA agent ${account.address} on chain ${chainId} (${network})`)

  // Discover the mandate named in the instruction.
  const mandates = await discoverMandates(account.address, chainId, network, publicClient)
  const mandate = mandates.find((m) => m.delegationHash.toLowerCase() === instruction.delegationHash.toLowerCase())
  if (!mandate) { console.log('Mandate from the instruction not found on Intuition yet — is it signed and published?'); return }

  const decimals = await tokenDecimals(publicClient, mandate.fundingToken)
  const amountIn = parseUnits(instruction.amountPerBuy, decimals)

  console.log(`Buying ${instruction.amountPerBuy} ${mandate.fundingToken} → ${instruction.targetToken} (cap ${mandate.capPerSwap})`)
  try {
    const hash = await executeDca({ walletClient, publicClient, apiKey, mandate, safe: instruction.safe, targetToken: instruction.targetToken, amountIn, chainId })
    console.log('  redeemed:', hash)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    console.log('  status:', receipt.status, 'block', receipt.blockNumber)
  } catch (err) {
    console.error('  failed:', err instanceof Error ? err.message : err)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
