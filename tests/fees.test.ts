import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers';
import { PriceImpactTooHigh, swap, swapInParts } from '../server/swap';
import { DEFAULT_SETTINGS } from '../shared/economics';
import type { Chain } from '../server/chain';
import { usdcValue } from '../server/fees';
import { config } from '../server/config';

test('creator fees are claimed when due; a failing claim backs off and is logged once', async () => {
  const s = await setup();
  assert.equal(await s.treasury.creatorFeesDue(), false, 'nothing has built up');
  s.solana.feeResults.push({ id: 'fees:1', cardsUnits: 20_000_000n, usdcMicros: 5_000_000, signature: 'sig' });
  assert.equal(await s.treasury.creatorFeesDue(), true);
  assert.equal((await s.treasury.creatorFees(true))?.usdcMicros, 5_000_000);

  s.solana.feeResults.push(new Error('No supported swap route.'), new Error('No supported swap route.'));
  await assert.rejects(s.treasury.creatorFees(true), /No supported swap route/);
  assert.equal(await s.treasury.creatorFeesDue(), false, 'waits before retrying');
  (s.treasury as unknown as { fees: { until: number } }).fees.until = 0;
  await assert.rejects(s.treasury.creatorFees(true), /No supported swap route/);
  const logged = (await s.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM audit WHERE event='creator-fees-error'")).rows[0].n;
  assert.equal(logged, 1, 'the same error is logged once');
  await s.db.close();
});

test('the every-second fee check reuses a price for 30 seconds instead of quoting Jupiter each time', async () => {
  const mint = 'So11111111111111111111111111111111111111112', quotes: bigint[] = [];
  const getQuote = (async (_in: string, _out: string, amount: bigint) => { quotes.push(amount); return { outAmount: String(amount * 2n) }; }) as any;
  const t = Date.now();
  assert.equal(await usdcValue(mint, 1_000n, t, getQuote), 2_000);
  assert.equal(await usdcValue(mint, 3_000n, t + 29_000, getQuote), 6_000, 'a bigger balance is valued at the same price');
  assert.deepEqual(quotes, [1_000n], 'one quote for both checks');
  await usdcValue(mint, 3_000n, t + 31_000, getQuote);
  assert.deepEqual(quotes, [1_000n, 3_000n], 'quoted again after 30 seconds');
  assert.equal(await usdcValue(config.USDC_MINT, 7n, t, getQuote), 7, 'USDC needs no quote');
});

test('a fee sale is refused before signing when it would move the price too much', async () => {
  const jobs = new Map<string, any>();
  const chain = {
    address: 'Pool1111111111111111111111111111111111111111',
    jobs: { get: async (id: string) => jobs.get(id) ?? null, put: async (id: string, kind: string, status: string, data: any) => { jobs.set(id, { id, kind, status, data }); } },
    execute: async (_id: string, _kind: string, build: () => Promise<unknown>) => { await build(); return 'signature'; },
    tokenDelta: async () => 1_000_000n,
  } as unknown as Chain;
  const original = globalThis.fetch;
  const order = (impact: string) => ({ router: 'metis', inputMint: 'CARDS', outputMint: 'USDC', inAmount: '500', outAmount: '1000000', otherAmountThreshold: '990000', slippageBps: 100, priceImpactPct: impact, transaction: null, errorMessage: 'stop before building' });
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify(order('-0.051')))) as typeof fetch;
    await assert.rejects(swap(chain, 'a', 'CARDS', 'USDC', 500n, DEFAULT_SETTINGS, 1n, 300), PriceImpactTooHigh);
    globalThis.fetch = (async () => new Response(JSON.stringify(order('-0.004')))) as typeof fetch;
    // 0.4% is under the 3% cap, so it gets past the impact check (and stops at the missing transaction).
    await assert.rejects(swap(chain, 'b', 'CARDS', 'USDC', 500n, DEFAULT_SETTINGS, 1n, 300), /stop before building/);
  } finally { globalThis.fetch = original; }
});

test('a buyback is one swap: no impact limit, and a part already split down resumes as the whole remainder', async () => {
  const jobs = new Map<string, any>();
  const chain = {
    address: 'Pool1111111111111111111111111111111111111111',
    jobs: { get: async (id: string) => jobs.get(id) ?? null, put: async (id: string, kind: string, status: string, data: any) => { jobs.set(id, { id, kind, status, data }); } },
    execute: async (_id: string, _kind: string, build: () => Promise<unknown>) => { await build(); return 'signature'; },
    tokenDelta: async () => 1_000_000n,
  } as unknown as Chain;
  const original = globalThis.fetch;
  // Pump.fun quotes report about 4% impact at any size; a split buyback would never get under a 3% limit.
  globalThis.fetch = (async () => new Response(JSON.stringify({ router: 'metis', priceImpactPct: '-0.042', transaction: null, errorMessage: 'stop before building' }))) as typeof fetch;
  try {
    await assert.rejects(swapInParts(chain, 'a', 'CARDS', 'COIN', 3_200n, DEFAULT_SETTINGS, { split: false }), /stop before building/);
    assert.equal(jobs.get('a:0:3200')?.data.amount, '3200', 'the whole amount in one swap');
    // A buyback the old code had already split to 1/32, with one part bought: the rest goes in one swap.
    jobs.set('b', { id: 'b', kind: 'swap-parts', status: 'routing', data: { inputMint: 'CARDS', outputMint: 'COIN', total: '3200', chunk: '100', parts: [{ amount: '100', received: '1', signature: 's' }] } });
    await assert.rejects(swapInParts(chain, 'b', 'CARDS', 'COIN', 3_200n, DEFAULT_SETTINGS, { split: false }), /stop before building/);
    assert.equal(jobs.get('b').data.chunk, '3100');
    assert.equal(jobs.get('b:1:3100')?.data.amount, '3100');
    // A part of the old size that had already started resumes as itself, so it is never bought twice.
    jobs.set('c', { id: 'c', kind: 'swap-parts', status: 'routing', data: { inputMint: 'CARDS', outputMint: 'COIN', total: '3200', chunk: '100', parts: [] } });
    jobs.set('c:0:100', { id: 'c:0:100', kind: 'swap', status: 'queued', data: { inputMint: 'CARDS', outputMint: 'COIN', amount: '100', minOutput: '1' } });
    await assert.rejects(swapInParts(chain, 'c', 'CARDS', 'COIN', 3_200n, DEFAULT_SETTINGS, { split: false }), /stop before building/);
    assert.equal(jobs.get('c').data.chunk, '100');
    assert.equal(jobs.has('c:0:3200'), false);
  } finally { globalThis.fetch = original; }
});
