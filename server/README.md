# Intuition publisher backend

A small node service (`Bun.serve`) that records a finalized OurGlass delegation on
the Intuition graph. The Safe App is client-side and cannot hold the attestor key,
so it POSTs only **references** here (chainId + Safe address + the Safe message
hash). This service then does everything itself: it fetches the finalized Safe
message from the Safe Transaction Service, verifies the aggregated signature
**on-chain via EIP-1271** against the Safe (a spoofed tx-service cannot make it
index a never-signed delegation), reconstructs the signed struct, builds the
`DelegationJson` document, pins it to IPFS, and writes the nested-triple ontology
(see ADR 0005, and `spec/intuition/README.md`, ADR 0003/0004). It holds only a gas
key and can forge nothing.

## Run

```bash
INTUITION_ATTESTOR_PK=0x... PINATA_JWT=... bun run publisher
# or: bun server/intuition-publisher.ts
```

## Endpoints

- `GET /health` → `{ ok, network, attestor }`
- `POST /publish` — **references only** (no delegation payload):
  ```json
  {
    "chainId": 84532,
    "safeAddress": "0x…",
    "messageHash": "0x…",
    "organization": { "name": "intuition.box" }
  }
  ```
  The server fetches the message (Safe tx-service for `chainId`), requires it to be
  finalized, verifies EIP-1271 against `safeAddress`, reconstructs the delegation,
  resolves/sanitizes token metadata, then pins + mints.
  → `{ "uri": "ipfs://…", "result": { atoms, triples, created } }`

`organization` is optional (the OrgPicker selection, for the `owns` edge). Requests
that are unfinalized, fail EIP-1271, or are not OurGlass delegations are rejected.
Publishes are serialized in-process so concurrent requests don't collide on the
attestor nonce; `isTermCreated` makes a repeat poke a harmless no-op.

The service reads two chains: the **Intuition L3** (`INTUITION_NETWORK`) to mint,
and the **app chain** (`chainId`, e.g. Base Sepolia) via a public RPC for EIP-1271
+ token reads.

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `INTUITION_ATTESTOR_PK` | yes | — | Funded attestor key. **Server-side only.** |
| `PINATA_JWT` | yes | — | Pins the DelegationJson document (server-side; no `VITE_`). |
| `INTUITION_NETWORK` | no | `testnet` | `testnet` (13579) or `mainnet` (1155). |
| `INTUITION_PUBLISHER_PORT` | no | `8787` | Own var; a platform-injected `PORT` would otherwise repoint the listener. |
| `ALLOWED_ORIGIN` | no | apex + `*.hourglass.box` + localhost | Comma-separated; supports `*` and subdomain wildcards. Default accepts every PR preview subdomain. |
| `PUBLISH_SECRET` | no | — | If set, require `x-publish-secret` to match. |

## Deploy

### Recommended: same app (default)

The root `Dockerfile` already runs this publisher **inside the web container**:
Caddy serves the static apps and reverse-proxies `/intuition/*` to the publisher
(`server/entrypoint.sh` starts both). One deploy, one origin, no CORS, no separate
domain or cert — and it works on every PR preview automatically. The Safe App's
`VITE_INTUITION_PUBLISHER_URL` defaults to `/intuition` (a same-origin path), so
there's nothing to set on the frontend.

You only set the publisher's **runtime** secrets on the existing Coolify app
(regular env vars, NOT build args, NEVER `VITE_`-prefixed):

- `INTUITION_ATTESTOR_PK` — the funded attestor key
- `PINATA_JWT` — the Pinata JWT
- (`INTUITION_NETWORK` defaults to `testnet` in the image)

Then redeploy. Verify: `https://<host>/intuition/health` → `{"ok":true,...}`. If the
publisher can't start (e.g. missing key), Caddy still serves the site — auto-publish
just degrades to "publishing not configured".

### Alternative: standalone service

To run it separately instead, use `server/Dockerfile` (build context = repo root)
as its own Coolify service, set the env vars above on that service, and point the
Safe App's `VITE_INTUITION_PUBLISHER_URL` build var at its URL. Its default CORS
accepts `https://*.hourglass.box`, so previews work without per-PR setup.

## Abuse note

`POST /publish` spends the attestor's $TRUST per call. It is authenticity-safe —
EIP-1271 verification means it only ever indexes delegations the Safe actually
signed, so nothing can be forged. What remains is an economic/DoS surface: anyone
can sign real junk delegations from their own 1-of-1 Safe and poke. This is an
**accepted risk** (ADR 0005): keep the attestor funded with testnet tTRUST only,
optionally set `PUBLISH_SECRET`/`ALLOWED_ORIGIN`, and add rate-limit + messageHash
dedup + a daily budget alert before mainnet or meaningful funding. A curated org
allowlist was considered and rejected.
