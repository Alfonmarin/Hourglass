# OurGlass

**Recurring on-chain payment agreements for Safe treasuries. Sign once, get charged every period — capped on-chain, documented on IPFS, revocable at any time.**

**Live:** [hourglass.box](https://hourglass.box/) — add it as a custom Safe App in your Safe.

## Why

DAOs run on recurring obligations: service retainers paid to other DAOs, contributor payroll, infrastructure subscriptions, grant disbursements. Today each payment cycle means another proposal, another signature round, another chance for a payment to land late or not at all. Multisig coordination is the bottleneck, and the treasury team carries it every month.

OurGlass removes the cycle. The paying Safe signs **one** agreement. From then on, the payee charges itself each period — within a hard cap enforced by an on-chain rule, never above the agreed amount, never twice in the same period. The subscriber can revoke unilaterally at any time. No escrow, no streaming contract holding funds, no relayer in the middle: tokens stay in the treasury until the moment they are charged.

## What you can run on it

- **DAO-to-DAO service agreements** — a service DAO charges its client Safe a fixed retainer per month, against terms both parties can read on IPFS.
- **Payroll** — a contributor (EOA or Safe) pulls their salary each period without asking signers to queue a transaction.
- **Subscriptions** — recurring USDC (or any ERC-20) payments to a provider, capped per period.

In every case the payer's obligation is bounded by the on-chain cap, and the payment stops the moment the delegation is revoked.

## How it works

OurGlass is a [Safe App](https://docs.safe.global/apps-sdk-overview) built on the [MetaMask Delegation Framework](https://github.com/MetaMask/delegation-framework) (ERC-7710) and the [Smart Accounts Kit](https://docs.metamask.io/smart-accounts/).

1. **Install the DeleGator module (once).** A minimal module is deployed deterministically for your Safe and enabled on it. The module acts as the delegator: it lets the Delegation Framework execute transfers from the Safe within the limits you sign — and nothing else.
2. **Write the agreement.** You set the payee, token, amount, period (per minute / day / week / month — the per-minute option is there for live demos) and an optional end date. OurGlass builds a human-readable agreement document and pins it to IPFS.
3. **Sign once.** The Safe signs an EIP-712 delegation (threshold signatures apply). The delegation's salt is `keccak256(terms)` — the signature is cryptographically bound to the exact pinned agreement. Change a comma in the terms and the signature is void.
4. **Get charged per period.** The payee redeems the delegation through the `DelegationManager`. The `ERC20PeriodTransferEnforcer` caveat enforces the cap on-chain: at most the agreed amount per period, and a second charge within the same period reverts. An optional `TimestampEnforcer` enforces the end date.
5. **Revoke whenever.** The Safe disables the delegation on-chain (`disableDelegation`, routed through the module). Any later charge attempt reverts with `CannotUseADisabledDelegation`.

The subscriber never sends a transaction to be charged — the signature is the standing authorization. The payee pays the gas for each charge, as the party collecting the payment.

```
┌─────────────────────────────┐
│      Subscriber Safe        │  holds the funds
│  (DAO treasury, multisig)   │
└─────────────┬───────────────┘
              │ enables (once)
              ▼
┌─────────────────────────────┐      EIP-712 delegation
│      DeleGator module       │  ◄── salt = keccak256(terms)
│   (delegator for the Safe)  │      terms pinned to IPFS
└─────────────┬───────────────┘
              │ bounded execution
              ▼
┌─────────────────────────────┐
│     DelegationManager       │  verifies signature + caveats
│  + ERC20PeriodTransfer      │  cap per period, no double charge
│    Enforcer (on-chain)      │
└─────────────┬───────────────┘
              │ ERC-20 transfer
              ▼
┌─────────────────────────────┐
│       Payee (delegate)      │  charges itself each period
│   service DAO, contributor  │
└─────────────────────────────┘
```

## Trust model

| Property | Where it is enforced |
|---|---|
| Per-period spending cap | On-chain (`ERC20PeriodTransferEnforcer`) |
| No double charge within a period | On-chain (same enforcer) |
| Optional end date | On-chain (`TimestampEnforcer`) |
| Signature bound to the exact agreement text | Cryptographic (delegation salt = `keccak256(terms)`) |
| Revocation | On-chain (`disableDelegation`) |
| Replay across chains or terms | Prevented by the EIP-712 domain (chainId + `DelegationManager`) and the unique salt |
| Agreement document availability | IPFS (pinned via Pinata) |

Funds never leave the Safe in advance. The delegation grants a capability, not a balance.

## Product surface

| Page | Route | What it does |
|---|---|---|
| Overview | `/` (in Safe) | Module status, committed monthly total, your subscriptions at a glance — open one to inspect the pinned IPFS contract or revoke it |
| Subscribe | in-app tab | Create and sign a new agreement, with a live preview of the contract being signed |
| Charge | in-app tab | For payee Safes: lists the active delegations made to this Safe (discovered on Intuition); import one manually as a fallback; charges on-chain |
| Withdraw | in-app tab | Sweep any assets sitting on the DeleGator module back to the Safe |
| Charge console | `/redeem` | Standalone page for payees outside Safe — auto-lists delegations made to a connected browser wallet (discovered on Intuition), with manual JSON import as a fallback; charges on-chain |

Both sides of an agreement are first-class: the paying Safe manages and revokes from inside Safe; the payee charges either from its own Safe or from the standalone console with a plain wallet.

## Supported networks

| Network | Chain ID | DeleGatorModuleFactory |
|---|---|---|
| Base Sepolia | 84532 | `0xE64ea779033131583cDE1c8862685051E09C4b78` |
| Ethereum Sepolia | 11155111 | `0x250435c7D339F03050c847c85f0108f44e876058` |
| Base | 8453 | `0x0D0421e43057bf850e243EcDA2AD8966C8D5877B` |

The `DelegationManager` (`0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`) and the caveat enforcers are MetaMask's audited, deterministic Delegation Framework v1.3.0 deployments — the same addresses on every supported chain. The full enforcer list lives in [`src/config/addresses.ts`](src/config/addresses.ts).

## Tech stack

- **React + TypeScript + Vite**, Tailwind CSS v4
- **[@metamask/smart-accounts-kit](https://www.npmjs.com/package/@metamask/smart-accounts-kit)** — delegation creation, signing, redemption
- **[@safe-global/safe-apps-react-sdk](https://www.npmjs.com/package/@safe-global/safe-apps-react-sdk)** — Safe App integration
- **[wagmi](https://wagmi.sh/) + [viem](https://viem.sh/)** — wallet connection and on-chain calls
- **Pinata** — IPFS pinning of agreement documents
- **[Intuition](https://www.intuition.systems/)** — the knowledge graph signed delegations are published to (via a small [publisher service](server/README.md)) so receivers can discover them

Signed agreements are stored client-side and can be exchanged directly as JSON files. They are also published to the Intuition graph so the receiver can discover them automatically — a **convenience layer, not a dependency**. The source of truth stays on-chain (the EIP-712 signature + the `DelegationManager`); both sides keep creating, signing, and charging even if the publisher or Intuition is down (manual import remains). See the [Discovery](https://hourglass.box/docs/concepts/discovery) docs.

## Getting started

```bash
git clone https://github.com/intuition-box/OurGlass.git
cd OurGlass

npm install      # or: bun install

cp .env.example .env
# fill in the variables below

npm run dev      # http://localhost:5173
```

To use it against a real Safe, open your Safe → Apps → My custom apps → add `http://localhost:5173` (or the live URL).

### Environment variables

| Variable | Purpose |
|---|---|
| `VITE_PINATA_JWT` | Pinata JWT for pinning agreement documents to IPFS. Without it the app falls back to a local offline pin (fine for development). |

### Build, test, deploy

```bash
npm run build      # tsc -b && vite build → dist/
npm run test:all   # local Anvil fork: deploys the stack and runs the full delegation flow
```

A `Dockerfile` (multi-stage: Bun build → Caddy static serve) and `Caddyfile` are included; the Caddy config sets the CORS headers Safe needs to load the app manifest in its iframe. Pass `VITE_PINATA_JWT` as a build arg — Vite inlines `VITE_*` variables at build time.

## Provenance

OurGlass is a fork of [gator-safe-app](https://github.com/osobot-ai/gator-safe-app) by [Osobot](https://www.osoknows.com/), an AI agent building on the MetaMask Delegation Framework. The upstream project is a general-purpose delegation manager (spending limits, transfer intents, swap intents). This fork refocuses it into a recurring-payment product for DAO treasuries:

- A subscription model — payee, amount, period, end date — replacing the generic delegation wizard
- Human-readable agreements pinned to IPFS and bound to the signature via the delegation salt
- A charge flow for payees (in-Safe and standalone), redeeming directly on-chain through the `DelegationManager`
- Revocation routed correctly through the DeleGator module
- Ethereum Sepolia support alongside Base / Base Sepolia
- A full redesign (glassmorphism UI) and the OurGlass branding

## Status

The Delegation Framework contracts (DelegationManager, enforcers) are audited MetaMask deployments. OurGlass itself is under active development and has not been independently audited — use testnets for evaluation and review the code before committing treasury funds.

## Links

- [MetaMask Delegation Framework (ERC-7710)](https://github.com/MetaMask/delegation-framework)
- [MetaMask Smart Accounts Kit](https://docs.metamask.io/smart-accounts/)
- [Safe Apps SDK](https://docs.safe.global/apps-sdk-overview)
- [Upstream project: osobot-ai/gator-safe-app](https://github.com/osobot-ai/gator-safe-app)

## History

- **2026-07-25 — Domain change.** The app moved from `ourglass.intuition.box` (a subdomain under the Intuition umbrella) to its own apex domain **`hourglass.box`**. All in-repo references — the Safe App manifest link, the publisher CORS allow-list (apex + `*.hourglass.box` preview wildcard), the Intuition `providedBy` URL, the pitch/verify pages, docs and env examples — were updated. References to the Intuition protocol itself (`intuition.box`) were intentionally left unchanged. Re-register the Safe App URL as `https://hourglass.box/` in Safe.
