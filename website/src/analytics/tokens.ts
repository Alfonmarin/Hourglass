import { createPublicClient, http, erc20Abi, parseAbi, type Address, type PublicClient } from 'viem';
import { ANALYTICS_CHAINS, KNOWN_TOKENS, tokenKey } from './config';

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

/** A token as it exists on one chain — the same symbol is a different asset elsewhere. */
export interface ChainToken {
  chainId: number;
  address: Address;
}

const UINT256_DECIMALS = parseAbi(['function decimals() view returns (uint256)']);

const clients = new Map<number, PublicClient>(
  ANALYTICS_CHAINS.map((c) => [
    c.chain.id,
    createPublicClient({ chain: c.chain, transport: http(c.rpcUrl) }) as PublicClient,
  ]),
);

async function readMeta(chainId: number, address: Address): Promise<TokenMeta> {
  const known = KNOWN_TOKENS[tokenKey(chainId, address)];
  if (known) return known;
  const client = clients.get(chainId);
  if (!client) return { symbol: '?', decimals: 18 };
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => '?'),
    client
      .readContract({ address, abi: erc20Abi, functionName: 'decimals' })
      .catch(async () => Number(await client.readContract({ address, abi: UINT256_DECIMALS, functionName: 'decimals' })))
      .catch(() => 18),
  ]);
  return { symbol: symbol || '?', decimals: Number(decimals) };
}

/** Resolve metadata for a set of tokens, keyed by `chainId:address`. */
export async function resolveTokens(tokens: ChainToken[]): Promise<Map<string, TokenMeta>> {
  const distinct = new Map<string, ChainToken>();
  for (const t of tokens) distinct.set(tokenKey(t.chainId, t.address), t);
  const entries = [...distinct.entries()];
  const metas = await Promise.all(entries.map(([, t]) => readMeta(t.chainId, t.address)));
  return new Map(entries.map(([key], i) => [key, metas[i]]));
}
