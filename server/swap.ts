import { VersionedTransaction } from '@solana/web3.js';
import { config } from './config';
import type { Chain, TxPolicy } from './chain';
import { PendingOperation, ReviewRequired } from './jobs';
import type { Settings } from '../shared/types';

const JUP = 'https://api.jup.ag/swap/v2';

export async function jsonFetch(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const body: any = await response.json();
  if (!response.ok) throw new Error(body.error || body.message || `Provider returned HTTP ${response.status}`);
  return body;
}

export function quote(inputMint: string, outputMint: string, amount: bigint, taker?: string, slippageBps = 100) {
  return jsonFetch(`${JUP}/order?${new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps), excludeRouters: 'jupiterz,dflow,okx', ...(taker ? { taker } : {}) })}`, { headers: { 'x-api-key': config.JUPITER_API_KEY } });
}

/** A quote that would move the price more than the caller allows; nothing was signed. */
export class PriceImpactTooHigh extends Error {}

/**
 * Jupiter (Metis only) swap with a guaranteed output floor. Adapted from grailshot Providers.swap.
 * `maxImpactBps` refuses quotes that would move the market more than that (fee sales split themselves on it).
 */
export async function swap(chain: Chain, id: string, inputMint: string, outputMint: string, amount: bigint, settings: Settings, minOutput = 1n, maxImpactBps?: number) {
  if (amount <= 0n) throw new Error('Swap amount must be positive.');
  let job = await chain.jobs.get(id);
  if (!job) await chain.jobs.put(id, 'swap', 'queued', { inputMint, outputMint, amount: amount.toString(), minOutput: minOutput.toString() });
  job = await chain.jobs.get(id); const d = job.data;
  if (d.inputMint !== inputMint || d.outputMint !== outputMint || d.amount !== amount.toString()) throw new ReviewRequired('Swap intent changed during recovery.');
  const policy: TxPolicy = { kind: 'swap', inputMint, maxInput: amount, outputMint, minOutput };
  const signature = await chain.execute(id, 'swap', async () => {
    const requestedAt = Date.now(), order = await quote(inputMint, outputMint, amount, chain.address!, settings.slippageBps);
    if (Date.now() - requestedAt > 10_000) throw new Error('Swap quote is stale. Retry with current pricing.');
    // Jupiter reports impact as a negative fraction: -0.0068 is 0.68%.
    const impactBps = Math.abs(Number(order.priceImpactPct ?? 0)) * 10_000;
    if (maxImpactBps !== undefined && impactBps > maxImpactBps) throw new PriceImpactTooHigh(`Price impact ${(impactBps / 100).toFixed(2)}% is above the ${(maxImpactBps / 100).toFixed(2)}% limit.`);
    if (order.errorCode || !order.transaction) throw new Error(order.errorMessage || 'No supported swap route.');
    if (order.router !== 'metis' || order.inputMint !== inputMint || order.outputMint !== outputMint || BigInt(order.inAmount) !== amount) throw new ReviewRequired('Swap quote route, asset or amount mismatch.');
    const guaranteed = BigInt(order.outAmount) * (10_000n - BigInt(settings.slippageBps)) / 10_000n;
    if (guaranteed < minOutput) throw new Error('Swap output is below the required minimum.');
    if (BigInt(order.otherAmountThreshold ?? '0') < guaranteed || Number(order.slippageBps) > settings.slippageBps) throw new ReviewRequired('Swap exceeds the configured slippage ceiling.');
    policy.minOutput = guaranteed;
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    if (tx.version !== 0 && tx.version !== 'legacy') throw new Error('No supported swap route (newer transaction format).');
    if (tx.message.header.numRequiredSignatures !== 1) throw new ReviewRequired('Swap requires an unsupported co-signer.');
    return tx;
  }, settings, policy);
  const received = await chain.tokenDelta(signature, outputMint);
  if (received < minOutput) throw new ReviewRequired('Settled swap output is insufficient.');
  return { signature, received };
}

/**
 * Swaps `total` in one or more parts, recorded under job `id` so a crash resumes the same parts. A part
 * that would move the price more than `maxPriceImpactBps` is halved (down to 1/32 of the total) and tried
 * again on the next pass. Throws PendingOperation until every part has settled.
 */
export async function swapInParts(chain: Chain, id: string, inputMint: string, outputMint: string, total: bigint, settings: Settings) {
  if (total <= 0n) throw new Error('Swap amount must be positive.');
  let job = await chain.jobs.get(id);
  if (!job) { await chain.jobs.put(id, 'swap-parts', 'routing', { inputMint, outputMint, total: total.toString(), chunk: total.toString(), parts: [] }); job = await chain.jobs.get(id); }
  const d = job.data;
  if (d.inputMint !== inputMint || d.outputMint !== outputMint || d.total !== total.toString()) throw new ReviewRequired('Swap intent changed during recovery.');
  const sold = d.parts.reduce((s: bigint, p: { amount: string }) => s + BigInt(p.amount), 0n);
  if (sold < total) {
    const chunk = BigInt(d.chunk), amount = total - sold < chunk ? total - sold : chunk;
    try {
      // The chunk is part of the swap id: a part that was signed resumes as itself, a resized part starts fresh.
      const part = await swap(chain, `${id}:${d.parts.length}:${chunk}`, inputMint, outputMint, amount, settings, 1n, settings.maxPriceImpactBps);
      d.parts.push({ amount: amount.toString(), received: part.received.toString(), signature: part.signature });
      await chain.jobs.put(id, 'swap-parts', 'routing', d);
    } catch (error) {
      if (!(error instanceof PriceImpactTooHigh)) throw error;
      if (chunk / 2n >= total / 32n && chunk / 2n > 0n) { d.chunk = (chunk / 2n).toString(); await chain.jobs.put(id, 'swap-parts', 'routing', d); throw new PendingOperation('Splitting the swap to limit price impact.'); }
      throw new PendingOperation('Price impact is too high right now; waiting for more liquidity.');
    }
    if (sold + amount < total) throw new PendingOperation('Swapping the rest in parts.');
  }
  await chain.jobs.put(id, 'swap-parts', 'complete', d);
  const received = d.parts.reduce((s: bigint, p: { received: string }) => s + BigInt(p.received), 0n);
  return { received, signature: d.parts.at(-1)!.signature as string, parts: d.parts.length as number };
}
