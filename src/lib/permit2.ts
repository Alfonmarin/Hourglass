import {
  encodeFunctionData,
  erc20Abi,
  maxUint48,
  maxUint160,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { PERMIT2_ADDRESS } from '../config/uniswap'

/**
 * Permit2 setup for a Safe trading through the Uniswap Universal Router. The router
 * pulls the funding token via Permit2 (AllowanceTransfer), so two allowances must
 * exist on the Safe before any swap can settle — a ONE-TIME setup per (token, router):
 *
 *   1. token.approve(Permit2, ∞)                    — lets Permit2 move the token.
 *   2. Permit2.approve(token, router, ∞, ∞)         — lets the router pull via Permit2.
 *
 * Both are plain on-chain calls (no EIP-712 signature), so a Safe can batch them in a
 * single transaction. Without them the router reverts with Permit2 `AllowanceExpired`.
 */

const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])

/** A Safe App transaction (value in wei as a string, per the SDK). */
export interface SafeTx {
  to: Address
  value: string
  data: Hex
}

export interface Permit2Status {
  /** token → Permit2 ERC-20 allowance covers `amount`. */
  tokenApproved: boolean
  /** Permit2 → router allowance covers `amount` and is not expired. */
  routerAllowanceOk: boolean
  /** True when both hold — no setup needed. */
  ready: boolean
}

/**
 * Whether the Safe already has the Permit2 allowances needed to spend `amount` of
 * `token` through `router`. Reads both the ERC-20 allowance (token → Permit2) and the
 * Permit2 allowance (token/router), checking the latter's expiration against `now`.
 */
export async function checkPermit2(
  client: PublicClient,
  params: { safe: Address; token: Address; router: Address; amount: bigint; now: number },
): Promise<Permit2Status> {
  const { safe, token, router, amount, now } = params

  const tokenAllowance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [safe, PERMIT2_ADDRESS],
  })

  const [permitAmount, expiration] = await client.readContract({
    address: PERMIT2_ADDRESS,
    abi: permit2Abi,
    functionName: 'allowance',
    args: [safe, token, router],
  })

  const tokenApproved = tokenAllowance >= amount
  const routerAllowanceOk = permitAmount >= amount && BigInt(expiration) > BigInt(now)
  return { tokenApproved, routerAllowanceOk, ready: tokenApproved && routerAllowanceOk }
}

/**
 * The batch of transactions that grant the Permit2 allowances (token → Permit2, then
 * Permit2 → router), both to the maximum so the setup never has to be repeated. Skips
 * whichever leg the Safe already has, per `status`. Empty when nothing is needed.
 */
export function buildPermit2Setup(
  token: Address,
  router: Address,
  status: Permit2Status,
): SafeTx[] {
  const txs: SafeTx[] = []
  if (!status.tokenApproved) {
    txs.push({
      to: token,
      value: '0',
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2_ADDRESS, maxUint256] }),
    })
  }
  if (!status.routerAllowanceOk) {
    txs.push({
      to: PERMIT2_ADDRESS,
      value: '0',
      // uint48 fits in a JS number (< 2^53); viem types this arg as number.
      data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [token, router, maxUint160, Number(maxUint48)] }),
    })
  }
  return txs
}
