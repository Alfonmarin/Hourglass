import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia, base, sepolia } from 'viem/chains'
import { createExecution, ExecutionMode, type Delegation } from '@metamask/smart-accounts-kit'
import { DelegationManager } from '@metamask/smart-accounts-kit/contracts'
import { getAddresses } from '../src/config/addresses'
import type { StoredYieldPlan } from '../src/lib/yieldDelegations'

const chains: Record<number, typeof baseSepolia | typeof base | typeof sepolia> = {
  84532: baseSepolia,
  11155111: sepolia,
  8453: base,
}

const STEP_LABELS = ['approve token0', 'approve token1', 'mint'] as const

/**
 * Redeems a yield plan's 3 delegations from the agent's own wallet,
 * sequentially, paying its own gas. Each delegation is single-use and pinned
 * (`exactExecution`) to the exact target/value/calldata already signed by the
 * Safe — this script only resubmits what was already approved, it makes no
 * decisions about amounts, targets, or recipients. Stops at the first
 * failing step rather than continuing with a partially-funded position.
 *
 * Usage: bun scripts/yield-agent.ts <plan.json>
 * Requires AGENT_PRIVATE_KEY in the environment — never commit it, never
 * prefix it VITE_ (see .env.example).
 */
async function main() {
  const [file] = process.argv.slice(2)
  if (!file) {
    console.error('usage: bun scripts/yield-agent.ts <plan.json>')
    process.exit(1)
  }
  const privateKey = process.env.AGENT_PRIVATE_KEY as Hex | undefined
  if (!privateKey) {
    console.error('AGENT_PRIVATE_KEY is not set')
    process.exit(1)
  }

  const plan: StoredYieldPlan = JSON.parse(readFileSync(file, 'utf8'))
  const chain = chains[plan.chainId]
  if (!chain) throw new Error(`Unsupported chain: ${plan.chainId}`)

  const account = privateKeyToAccount(privateKey)
  if (account.address.toLowerCase() !== plan.agentAddress.toLowerCase()) {
    throw new Error(`AGENT_PRIVATE_KEY (${account.address}) does not match the plan's agent address (${plan.agentAddress})`)
  }

  const delegationManager = getAddresses(plan.chainId).delegationManager
  const publicClient = createPublicClient({ chain, transport: http() })
  const walletClient = createWalletClient({ account, chain, transport: http() })

  console.log(`Yield agent ${account.address} redeeming plan for pool ${plan.pool.address} on chain ${plan.chainId}`)

  for (let i = 0; i < plan.delegations.length; i++) {
    const stored = plan.delegations[i]
    const { targetAddress, calldataArgs } = stored.meta
    if (!targetAddress || !calldataArgs) throw new Error(`Delegation ${i} is missing its pinned execution`)

    console.log(`\n[${i + 1}/3] ${STEP_LABELS[i]} → ${targetAddress}`)

    const execution = createExecution({ target: targetAddress, value: 0n, callData: calldataArgs })
    // The SDK's Delegation type carries a per-caveat `args` field the stored
    // shape doesn't (see src/lib/redeemDirect.ts for the same conversion) —
    // '0x' because none of this delegation's caveats consume per-redemption args.
    const sdkDelegation: Delegation = {
      delegate: stored.delegation.delegate,
      delegator: stored.delegation.delegator,
      authority: stored.delegation.authority,
      caveats: stored.delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: '0x' })),
      salt: stored.delegation.salt,
      signature: stored.delegation.signature,
    }

    const redeemCalldata = DelegationManager.encode.redeemDelegations({
      delegations: [[sdkDelegation]],
      modes: [ExecutionMode.SingleDefault],
      executions: [[execution]],
    })

    const hash = await walletClient.sendTransaction({ to: delegationManager, data: redeemCalldata })
    console.log('  tx:', hash)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      console.error(`  REVERTED at step "${STEP_LABELS[i]}" — stopping, remaining steps not sent.`)
      process.exit(1)
    }
    console.log('  confirmed in block', receipt.blockNumber)
  }

  console.log('\nDone — position minted, held by the Safe.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
