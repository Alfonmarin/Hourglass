# Setup — wallet, funding, dependencies

One-time steps before the agent can run. The wallet is the agent's identity; the
gas is the only value it ever holds.

## 1. Dependencies

```bash
bun add viem @metamask/smart-accounts-kit
# or: npm install viem @metamask/smart-accounts-kit
```

Also install the Uniswap **swap-integration** skill (it builds the swap calldata
the agent redeems). And get a **Uniswap Trading API key** from the Uniswap developer
portal — it is passed as the `x-api-key` header, agent-side only.

## 2. Create the agent wallet

The agent needs a keypair. Generate a fresh one and record the **address** (to hand
to the Safe operator) and the **private key** (kept secret, used only to sign the
redeem tx).

With foundry:

```bash
cast wallet new
# Address:     0x…   ← give this to the Safe operator
# Private key: 0x…   ← keep secret; set as AGENT_PRIVATE_KEY
```

Or with viem:

```ts
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
const privateKey = generatePrivateKey()
const account = privateKeyToAccount(privateKey)
console.log('address:', account.address)
console.log('privateKey:', privateKey) // store securely
```

Store the private key in a secret manager or an untracked `.env` (never commit it):

```
AGENT_PRIVATE_KEY=0x…
UNISWAP_API_KEY=…
INTUITION_NETWORK=mainnet
# RPC_URL=https://…   (optional; defaults to a public RPC)
```

## 3. Fund the wallet with gas

Redeeming a delegation is a real transaction — the agent pays its own gas in native
ETH on the mandate's chain (Base 8453 or Ethereum 1). A few dollars of ETH covers
many redeems.

The agent does **not** self-fund. Ask the human operator to send a small amount of
ETH to the address from step 2, then verify:

```ts
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
const client = createPublicClient({ chain: base, transport: http() })
const balance = await client.getBalance({ address: '0x…agent' })
console.log('gas balance (wei):', balance) // must be > 0 before running
```

Do not proceed until the balance is non-zero.

## 4. Hand the address to the Safe operator

Give the agent **address** (not the key) to whoever controls the Safe. They paste it
into the Hourglass Strategy tab as the *Agent address*, configure the recurring buy
and the per-swap cap, and sign the mandate. Once signed, it is published on Intuition
and the agent can discover it — see `discovery.md`.
