/**
 * End-to-end check of the Aqua encoder against a real deployment.
 *
 * The unit tests pin the encoding to fixtures; this proves the fixtures are
 * still what the chain accepts. It drives the *same* functions the page uses —
 * buildAmmProgram, buildAquaOrder, buildShipTxs, buildDockTxs — sends their
 * output at a forked Base, and checks Aqua and SwapVM agree with us.
 *
 * An EOA stands in for the Safe. The Safe batches these calls into one
 * transaction; the calldata is identical either way.
 *
 *   anvil --fork-url https://mainnet.base.org --port 8546
 *   bun scripts/aqua-fork-check.ts
 */
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { AquaABI } from '../src/config/abis'
import { AQUA_ADDRESS, AQUA_SWAPVM_ADDRESS } from '../src/config/aqua'
import { buildAmmProgram, randomSalt } from '../src/lib/aqua/program'
import { buildAquaOrder, strategyHash } from '../src/lib/aqua/order'
import { buildShipTxs, buildDockTxs } from '../src/lib/aqua/ship'

const RPC = process.env.AQUA_FORK_RPC ?? 'http://127.0.0.1:8546'
const AQUA = AQUA_ADDRESS[base.id]
const SWAPVM = AQUA_SWAPVM_ADDRESS[base.id]
const WETH: Address = '0x4200000000000000000000000000000000000006'
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_BALANCE_SLOT = 9n

// Anvil's deterministic account 0, standing in for the Safe.
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')

const SWAPVM_ABI = parseAbi([
  'function quote((address maker, uint256 traits, bytes data) order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
  'function hash((address maker, uint256 traits, bytes data) order) view returns (bytes32)',
])

// 18 bytes of slice indexes then 2 bytes of flags; IS_EXACT_IN only.
const TAKER_TRAITS: Hex = `0x${'00'.repeat(18)}0001`

const chain = { ...base, rpcUrls: { default: { http: [RPC] } } }
const publicClient = createPublicClient({ chain, transport: http(RPC) })
const wallet = createWalletClient({ account, chain, transport: http(RPC) })

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function send(tx: { to: string; value: string; data: string }) {
  const hash = await wallet.sendTransaction({
    to: tx.to as Address,
    value: BigInt(tx.value),
    data: tx.data as Hex,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`tx reverted: ${hash}`)
  return receipt
}

/** Write a USDC balance straight into the fork's storage. */
async function fundUsdc(who: Address, amount: bigint) {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, USDC_BALANCE_SLOT]))
  await publicClient.request({
    method: 'anvil_setStorageAt' as never,
    params: [USDC, slot, `0x${amount.toString(16).padStart(64, '0')}`] as never,
  })
}

async function main() {
  const blockNumber = await publicClient.getBlockNumber()
  console.log(`forked Base at block ${blockNumber}\n`)

  const amount0 = 1_000_000_000_000_000_000n // 1 WETH
  const amount1 = 2_000_000_000n // 2000 USDC

  // Fund the stand-in Safe so the strategy is actually backed.
  await send({
    to: WETH,
    value: amount0.toString(),
    data: encodeFunctionData({ abi: parseAbi(['function deposit() payable']), functionName: 'deposit' }),
  })
  await fundUsdc(account.address, amount1)

  // Captured after funding: the whole point is that ship/quote/dock leave this
  // untouched. Comparing against a constant would break on a reused fork.
  const wethBefore = await publicClient.readContract({
    address: WETH,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })

  const program = buildAmmProgram({ feeBps: 3_000_000, salt: randomSalt() })
  const order = buildAquaOrder(account.address, program)
  const hash = strategyHash(order)

  console.log('program', program)
  console.log('strategy', hash, '\n')

  const onchainHash = await publicClient.readContract({
    address: SWAPVM,
    abi: SWAPVM_ABI,
    functionName: 'hash',
    args: [order],
  })
  check('strategyHash matches SwapVM.hash()', onchainHash === hash, onchainHash)

  const shipTxs = buildShipTxs({
    aqua: AQUA,
    app: SWAPVM,
    order,
    legs: [
      { address: WETH, amount: amount0 },
      { address: USDC, amount: amount1 },
    ],
  })
  check('ship batch is approve, approve, ship', shipTxs.length === 3)
  for (const tx of shipTxs) await send(tx)

  const [wethVirtual, wethCount] = await publicClient.readContract({
    address: AQUA,
    abi: AquaABI,
    functionName: 'rawBalances',
    args: [account.address, SWAPVM, hash, WETH],
  })
  check('Aqua recorded the shipped WETH', BigInt(wethVirtual) === amount0, formatUnits(BigInt(wethVirtual), 18))
  check('strategy is active', wethCount === 2, `tokensCount=${wethCount}`)

  const allowance = await publicClient.readContract({
    address: WETH,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, AQUA],
  })
  check('approval is the exact shipped amount, not unlimited', allowance === amount0)

  const { result } = await publicClient.simulateContract({
    address: SWAPVM,
    abi: SWAPVM_ABI,
    functionName: 'quote',
    args: [order, USDC, WETH, 100_000_000n, TAKER_TRAITS],
    account,
  })
  const [, amountOut] = result
  // 100 USDC in, 0.3% fee, against 2000 USDC / 1 WETH reserves.
  const net = (100_000_000n * (1_000_000_000n - 3_000_000n)) / 1_000_000_000n
  const expected = (net * amount0) / (amount1 + net)
  check('quote matches the constant-product curve with fee', amountOut === expected, `${amountOut} vs ${expected}`)

  const dockTxs = buildDockTxs({
    aqua: AQUA,
    app: SWAPVM,
    strategyHash: hash,
    tokens: [WETH, USDC],
    revokeApprovals: true,
  })
  for (const tx of dockTxs) await send(tx)

  const [, dockedCount] = await publicClient.readContract({
    address: AQUA,
    abi: AquaABI,
    functionName: 'rawBalances',
    args: [account.address, SWAPVM, hash, WETH],
  })
  check('dock marks the strategy docked', dockedCount === 255, `tokensCount=${dockedCount}`)

  const afterAllowance = await publicClient.readContract({
    address: WETH,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, AQUA],
  })
  check('dock batch revoked the approval', afterAllowance === 0n)

  const wethHeld = await publicClient.readContract({
    address: WETH,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })
  check('no tokens ever left the wallet', wethHeld === wethBefore, formatUnits(wethHeld, 18))

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
