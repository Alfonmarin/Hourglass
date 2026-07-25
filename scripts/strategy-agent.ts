import { createPublicClient, createWalletClient, http, parseUnits, isAddress, erc20Abi, type Address, type Hex, type PublicClient, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia, base, sepolia } from 'viem/chains'
import { createExecution, ExecutionMode, redeemDelegations, type Delegation, type Redemption } from '@metamask/smart-accounts-kit'
import { getAddresses } from '../src/config/addresses'
import { discoverIncomingDelegations } from '../src/lib/intuition/discover'
import { checkApproval, buildSwap } from '../src/lib/trading-api'
import type { StoredDelegation } from '../src/lib/storage'

/**
 * DCA strategy agent. Three layers:
 *   1. DISCOVER  — read the strategy mandates assigned to this agent from Intuition.
 *   2. DECIDE    — pick the swap amount for this tick (bounded on-chain by the cap).
 *   3. EXECUTE   — build the swap (Trading API, CLASSIC), then redeem approve + swap
 *                  in ONE atomic redeemDelegations call (two SingleDefault entries;
 *                  a functionCall scope forbids a batch call-type, so each leg is a
 *                  single execution, but both land in one tx — all-or-nothing).
 *
 * The agent holds nothing: it only redeems, and every action runs AS THE SAFE,
 * capped by the mandate's erc20BalanceChange. Env: AGENT_PRIVATE_KEY (the
 * delegate), UNISWAP_API_KEY (Trading API), optional RPC_URL. Never commit these.
 *
 * The DCA intent (target token, amount, cadence) is read from the discovered
 * mandate's metadata — the agent follows the instruction the Safe signed. The
 * on-chain cap bounds it regardless.
 *
 * Usage: bun scripts/strategy-agent.ts <chainId>
 */

const chains: Record<number, typeof baseSepolia | typeof base | typeof sepolia> = {
  84532: baseSepolia,
  11155111: sepolia,
  8453: base,
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`${name} is not set`); process.exit(1) }
  return v
}

/** Layer 1 — the DCA mandates addressed to this agent. */
async function discoverDcaMandates(agent: Address, chainId: number): Promise<StoredDelegation[]> {
  const all = await discoverIncomingDelegations(agent, chainId)
  return all.filter((d) => d.meta.scopeType === 'strategyMandate' && d.meta.strategyKind === 'dca')
}

/** Rebuild the SDK Delegation from the stored shape (args '0x' — no caveat consumes them). */
function toSdkDelegation(stored: StoredDelegation): Delegation {
  return {
    delegate: stored.delegation.delegate,
    delegator: stored.delegation.delegator,
    authority: stored.delegation.authority,
    caveats: stored.delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: '0x' as Hex })),
    salt: stored.delegation.salt,
    signature: stored.delegation.signature,
  }
}

/** Layer 3 — build approve+swap and redeem them atomically as the Safe. */
async function executeSwap(params: {
  walletClient: WalletClient
  publicClient: PublicClient
  delegationManager: Address
  mandate: StoredDelegation
  apiKey: string
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  chainId: number
}): Promise<Hex> {
  const { walletClient, publicClient, delegationManager, mandate, apiKey, tokenIn, tokenOut, amountIn, chainId } = params
  const safe = mandate.meta.safeAddress
  const delegation = toSdkDelegation(mandate)

  const approval = await checkApproval(apiKey, { walletAddress: safe, token: tokenIn, amount: amountIn.toString(), chainId })
  const swap = await buildSwap(apiKey, { swapper: safe, tokenIn, tokenOut, amount: amountIn.toString(), chainId })

  // Each leg is its own SingleDefault entry (functionCall enforcers reject batch
  // call-type), but both entries ride one redeemDelegations tx — atomic.
  const redemptions: Redemption[] = []
  if (approval) {
    redemptions.push({
      permissionContext: [delegation],
      executions: [createExecution({ target: approval.to, value: 0n, callData: approval.data })],
      mode: ExecutionMode.SingleDefault,
    })
  }
  redemptions.push({
    permissionContext: [delegation],
    executions: [createExecution({ target: swap.to, value: BigInt(swap.value), callData: swap.data })],
    mode: ExecutionMode.SingleDefault,
  })

  // The high-level helper simulates (simulateContract) before sending, so a hook
  // revert (e.g. cap exceeded) surfaces here instead of on-chain gas loss.
  return redeemDelegations(walletClient, publicClient, delegationManager, redemptions)
}

async function main() {
  const [chainArg] = process.argv.slice(2)
  if (!chainArg) {
    console.error('usage: bun scripts/strategy-agent.ts <chainId>')
    process.exit(1)
  }
  const chainId = Number(chainArg)
  const chain = chains[chainId]
  if (!chain) throw new Error(`Unsupported chain: ${chainId}`)

  const privateKey = requireEnv('AGENT_PRIVATE_KEY') as Hex
  const apiKey = requireEnv('UNISWAP_API_KEY')
  const rpc = process.env.RPC_URL

  const account = privateKeyToAccount(privateKey)
  const delegationManager = getAddresses(chainId).delegationManager
  const publicClient = createPublicClient({ chain, transport: http(rpc) }) as PublicClient
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) })

  console.log(`Strategy agent ${account.address} on chain ${chainId}`)

  // Layer 1 — discover
  const mandates = await discoverDcaMandates(account.address, chainId)
  if (mandates.length === 0) { console.log('No DCA mandates assigned to this agent.'); return }

  for (const mandate of mandates) {
    // The agent must be the delegate the Safe signed for.
    if (mandate.delegation.delegate.toLowerCase() !== account.address.toLowerCase()) {
      console.log(`Skipping ${mandate.meta.delegationHash} — delegate is not this agent.`)
      continue
    }
    // The DCA intent lives in the mandate metadata (agent instruction).
    const tokenIn = mandate.meta.tokenAddress
    const tokenOut = mandate.meta.targetToken
    const buyAmount = mandate.meta.amount
    if (!tokenIn || !tokenOut || !buyAmount || !isAddress(tokenOut)) {
      console.log(`Skipping ${mandate.meta.delegationHash} — incomplete DCA intent.`)
      continue
    }

    // Layer 2 — decide. The buy amount in the funding token's units; the on-chain
    // erc20BalanceChange cap enforces the per-swap ceiling regardless.
    const decimals = await publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'decimals' })
    const amountIn = parseUnits(buyAmount, decimals)

    console.log(`Mandate ${mandate.meta.delegationHash}: buying ${buyAmount} ${tokenIn} → ${tokenOut} (${mandate.meta.period ?? 'once'})`)
    try {
      const hash = await executeSwap({
        walletClient, publicClient, delegationManager,
        mandate, apiKey, tokenIn, tokenOut: tokenOut as Address, amountIn, chainId,
      })
      console.log('  redeemed:', hash)
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      console.log('  status:', receipt.status, 'block', receipt.blockNumber)
    } catch (err) {
      console.error('  failed:', err instanceof Error ? err.message : err)
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
