import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, isHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { StoredDelegation } from '../src/lib/storage'
import {
  createGraphqlPinner,
  createViemChain,
  getIntuitionNetwork,
  inputFromStoredDelegation,
  publishDelegation,
  type IntuitionNetwork,
} from '../src/lib/intuition'

/**
 * Phase 2 runner: publish one stored OurGlass delegation onto the Intuition
 * graph, signing with the funded attestor key.
 *
 * Usage:
 *   INTUITION_ATTESTOR_PK=0x... INTUITION_PIN_API_KEY=... \
 *   bun scripts/intuition-publish.ts <gator-delegations.json> \
 *     --org "intuition.box" [--org-url https://intuition.box] \
 *     [--network testnet] [--index 0]
 *
 * The JSON file is the raw value of the `gator-delegations` localStorage key
 * (an array of StoredDelegation), or a single StoredDelegation object.
 */

interface Args {
  file: string
  org: string
  orgUrl: string
  network: IntuitionNetwork
  index: number
}

function parseArgs(argv: string[]): Args {
  const [file] = argv
  if (!file) {
    throw new Error(
      'usage: bun scripts/intuition-publish.ts <dump.json> --org <name> [--org-url <url>] [--network testnet|mainnet] [--index N]',
    )
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const network = (flag('network') ?? 'testnet') as IntuitionNetwork
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error(`--network must be testnet or mainnet, got "${network}"`)
  }
  return {
    file,
    org: flag('org') ?? 'OurGlass',
    orgUrl: flag('org-url') ?? 'https://ourglass.intuition.box/',
    network,
    index: Number(flag('index') ?? '0'),
  }
}

function loadDelegations(file: string): StoredDelegation[] {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (Array.isArray(parsed)) return parsed as StoredDelegation[]
  return [parsed as StoredDelegation]
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const pk = process.env.INTUITION_ATTESTOR_PK
  if (!pk || !isHex(pk)) {
    throw new Error('INTUITION_ATTESTOR_PK must be set to a 0x-prefixed private key')
  }

  const pinApiKey = process.env.INTUITION_PIN_API_KEY
  if (!pinApiKey) {
    throw new Error('INTUITION_PIN_API_KEY must be set to pin atom metadata')
  }

  const config = getIntuitionNetwork(args.network)
  const account = privateKeyToAccount(pk as Hex)
  const transport = http(config.rpcUrl)
  const publicClient = createPublicClient({ chain: config.chain, transport })
  const walletClient = createWalletClient({ account, chain: config.chain, transport })

  const delegations = loadDelegations(args.file)
  const delegation = delegations[args.index]
  if (!delegation) {
    throw new Error(`no delegation at index ${args.index} (file has ${delegations.length})`)
  }

  const input = inputFromStoredDelegation(delegation, {
    name: args.org,
    description: 'OurGlass subscription organization.',
    image: '',
    url: args.orgUrl,
    email: '',
  })

  console.log(`Attestor ${account.address} → ${config.network} (${config.chainId})`)
  console.log(`Delegation ${delegation.meta.delegationHash} (${delegation.meta.label})`)

  const result = await publishDelegation(
    { chain: createViemChain(publicClient, walletClient, config.multiVault), pinner: createGraphqlPinner(pinApiKey), config },
    input,
  )

  console.log('\nPublished:')
  console.log(JSON.stringify(result, null, 2))
  console.log(`\nCreated ${result.created.length} new term(s) this run.`)
  console.log(`Context (nested) triple: ${config.explorerUrl}/`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
