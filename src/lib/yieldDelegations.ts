import { createDelegation } from '@metamask/smart-accounts-kit'
import { keccak256, toFunctionSelector, type Address, type Hex } from 'viem'
import { computeDelegationHash, type DelegationStruct } from './delegations'
import type { DepositPlan, Execution } from './uniswapPosition'
import type { Caveat, StoredDelegation } from './storage'

// One selector per entry in DepositPlan.executions, same order:
// [approve token0, approve token1, mint].
const EXECUTION_SELECTORS: readonly [string, string, string] = [
  'approve(address,uint256)',
  'approve(address,uint256)',
  'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))',
]

export interface YieldDelegation {
  execution: Execution
  selector: string
  delegation: DelegationStruct
}

/**
 * Builds one single-use delegation per call in the plan. Each delegation's
 * scope is `functionCall` restricted to that exact target+selector, and its
 * caveats pin the exact execution (`exactExecution`), cap it to one
 * redemption (`limitedCalls`), restrict who can redeem it to the agent
 * wallet (`redeemer`), and bound how long it stays valid (`timestamp`). This
 * is what lets the agent redeem unattended: the delegation leaves it no
 * choice about target, method, args, or amount — only whether/when to submit.
 */
export function buildYieldDelegations(params: {
  plan: DepositPlan
  moduleAddress: Address
  agentAddress: Address
  // SmartAccountsEnvironment from getEnvironment() — typed loosely because the
  // SDK's createDelegation() generic constraint is narrower than the return
  // type of getEnvironment(), same mismatch the existing CreateDelegation.tsx
  // flow works around with `as never`.
  environment: unknown
  deadlineSeconds: number
}): YieldDelegation[] {
  const { plan, moduleAddress, agentAddress, environment, deadlineSeconds } = params
  const nowSec = Math.floor(Date.now() / 1000)

  return plan.executions.map((execution, i) => {
    const selector = EXECUTION_SELECTORS[i]

    const sdkDelegation = createDelegation({
      to: agentAddress,
      from: moduleAddress,
      environment: environment as never, // see `environment` param comment above
      scope: {
        type: 'functionCall',
        targets: [execution.target],
        selectors: [selector],
      } as never,
      caveats: [
        { type: 'exactExecution', execution: { target: execution.target, value: execution.value, callData: execution.callData } },
        { type: 'limitedCalls', limit: 1 },
        { type: 'redeemer', redeemers: [agentAddress] },
        { type: 'timestamp', afterThreshold: nowSec, beforeThreshold: nowSec + deadlineSeconds },
      ] as never,
      // Binds the delegation to this exact action, mirroring the project's
      // `salt = keccak256(terms)` convention (see CreateDelegation.tsx) — also
      // required because createDelegation() defaults salt to '0x', which isn't
      // parseable by computeDelegationHash's BigInt(salt).
      salt: keccak256(execution.callData),
    }) as { delegate: Address; delegator: Address; authority: Hex; caveats: Caveat[]; salt: Hex }

    const delegation: DelegationStruct = {
      delegate: sdkDelegation.delegate,
      delegator: sdkDelegation.delegator,
      authority: sdkDelegation.authority,
      caveats: sdkDelegation.caveats,
      salt: sdkDelegation.salt,
      signature: '0x',
    }

    return { execution, selector, delegation }
  })
}

/** The signed 3-delegation bundle exported to `scripts/yield-agent.ts`. */
export interface StoredYieldPlan {
  version: 1
  chainId: number
  safeAddress: Address
  moduleAddress: Address
  agentAddress: Address
  pool: { address: Address; token0: Address; token1: Address; fee: number }
  amount0: string
  amount1: string
  deadline: string
  createdAt: string
  /** One per call, in redemption order: [approve token0, approve token1, mint]. */
  delegations: StoredDelegation[]
}

/**
 * Wraps the signed yield delegations for export — mirrors `StoredDelegation`
 * (reusing its `scopeType: 'custom'` / `targetAddress` / `methodSelector` /
 * `calldataArgs` fields, which existed but were unused before this) so the
 * shape stays consistent with the rest of the delegation-storage model.
 */
export function buildStoredYieldPlan(params: {
  plan: DepositPlan
  yieldDelegations: { execution: Execution; selector: string; delegation: DelegationStruct }[]
  signatures: Hex[]
  chainId: number
  safeAddress: Address
  moduleAddress: Address
  agentAddress: Address
}): StoredYieldPlan {
  const { plan, yieldDelegations, signatures, chainId, safeAddress, moduleAddress, agentAddress } = params
  const nowIso = new Date().toISOString()

  const delegations: StoredDelegation[] = yieldDelegations.map(({ execution, selector, delegation }, i) => {
    const signed = { ...delegation, signature: signatures[i] }
    return {
      delegation: signed,
      meta: {
        label: `Yield agent: ${selector.split('(')[0]}`,
        scopeType: 'custom',
        createdAt: nowIso,
        chainId,
        safeAddress,
        moduleAddress,
        status: 'signed',
        delegationHash: computeDelegationHash(signed),
        targetAddress: execution.target,
        methodSelector: toFunctionSelector(selector),
        calldataArgs: execution.callData,
      },
    }
  })

  return {
    version: 1,
    chainId,
    safeAddress,
    moduleAddress,
    agentAddress,
    pool: { address: plan.pool.poolAddress, token0: plan.pool.token0.address, token1: plan.pool.token1.address, fee: plan.pool.fee },
    amount0: plan.amount0.toString(),
    amount1: plan.amount1.toString(),
    deadline: plan.deadline.toString(),
    createdAt: nowIso,
    delegations,
  }
}
