import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionedTransaction } from '@solana/web3.js';
import { pull, settle, setup, user } from './helpers';
import { micros } from '../shared/economics';

test('a holder who loses is repaid the full loss, and the pull queues a burn worth its insured value', async () => {
  const s = await setup(), { wallet } = await user(s);
  const usdcBefore = await s.treasury.usdcBalance();
  const { order, transaction } = await s.orders.create(wallet, 'pokemon_25');
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.totalUsd, 25, 'no service fee by default');
  assert.equal(order.holder, true);
  assert.equal(await s.treasury.reserved(), 0, 'nothing is reserved until the user pays');
  assert.ok(VersionedTransaction.deserialize(Buffer.from(transaction, 'base64')));
  await s.orders.pay(wallet, order.id, 'practice');
  assert.equal(await s.treasury.reserved(), micros(25), 'a holder reserves the whole price once paid');
  const done = await settle(s, order.id);
  assert.equal(done.status, 'complete', done.message ?? '');
  const loss = Math.max(0, micros(25) - micros(done.valueUsd!));
  assert.equal(micros(done.repayUsd!), loss);
  assert.equal(await s.treasury.reserved(), 0, 'the reservation is released');
  s.treasury.invalidate();
  assert.equal(await s.treasury.usdcBalance(), usdcBefore - loss, 'repaid from the treasury');
  assert.equal(done.burn?.status, 'queued');
  assert.ok(Math.abs(done.burn!.usd - done.valueUsd!) < 0.01, 'the burn matches the insured value while the fund is large');
  await s.db.close();
});

test('exact amounts: a $9.50 card on a $25 pack repays $15.50 and queues a $9.50 burn', async () => {
  const s = await setup(), { wallet } = await user(s);
  const done = await pull(s, wallet, 'pokemon_25', 9.5);
  assert.equal(done.repayUsd, 15.5);
  assert.equal(done.burn?.usd, 9.5);
  assert.match(done.message!, /\$15\.50 repaid.*\$9\.50 of buyback-and-burn queued/);
  const ledger = (await s.db.query("SELECT kind, amount_micros::text AS a FROM ledger WHERE ref=$1 ORDER BY kind", [done.id])).rows.map(r => [r.kind, Number(r.a)]);
  assert.deepEqual(ledger, [['pack', -micros(25)], ['repay', -micros(15.5)], ['sale', micros(25)]], 'OPS took $25 and spent it on the pack; the treasury repaid $15.50');
  await s.db.close();
});

test('a holder who hits gets no repay but still triggers a burn', async () => {
  const s = await setup(), { wallet } = await user(s);
  const done = await pull(s, wallet, 'pokemon_50', 120);
  assert.equal(done.repayUsd, 0);
  assert.equal(done.repaySignature, null);
  assert.equal(done.burn?.usd, 120);
  assert.match(done.message!, /beat the pack price/);
  await s.db.close();
});

test('a non-holder opens packs and triggers burns, but is never repaid', async () => {
  const s = await setup(), { wallet } = await user(s, false);
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  assert.equal(order.holder, false);
  await s.orders.pay(wallet, order.id, 'practice');
  assert.equal(await s.treasury.reserved(), 0, 'non-holders reserve nothing');
  await s.db.query('DELETE FROM orders WHERE id=$1', [order.id]);
  const done = await pull(s, wallet, 'pokemon_25', 5);
  assert.equal(done.repayUsd, 0);
  assert.equal(done.burn?.usd, 5);
  assert.match(done.message!, /Hold the coin/);
  await s.db.close();
});

test('holder packs pause when free USDC cannot cover a full repay; non-holders keep opening', async () => {
  const s = await setup(), holder = await user(s), other = await user(s, false);
  s.solana.setTreasuryUsdc(micros(60)); s.treasury.invalidate();
  const quotes = await s.orders.quotes(holder.wallet);
  assert.equal(quotes.find(q => q.code === 'pokemon_50')!.quote.open, true);
  assert.equal(quotes.find(q => q.code === 'pokemon_100')!.quote.open, false, '$100 needs $100 free');
  await assert.rejects(s.orders.create(holder.wallet, 'pokemon_100'), /refilling/);
  await assert.rejects(s.orders.createMany(holder.wallet, 'pokemon_50', 2), /can cover 1 of these/);
  assert.equal((await s.orders.create(other.wallet, 'pokemon_100')).order.status, 'awaiting_payment', 'non-holders are not limited by the reserve');
  assert.deepEqual((await s.treasury.view()).pausedForHolders.includes('pokemon_100'), true);
  await s.db.close();
});

test('a reservation taken by one paid order is not available to the next holder', async () => {
  const s = await setup(), a = await user(s), b = await user(s);
  s.solana.setTreasuryUsdc(micros(30)); s.treasury.invalidate();
  const first = await s.orders.create(a.wallet, 'pokemon_25');
  const second = await s.orders.create(b.wallet, 'pokemon_25');
  await s.orders.pay(a.wallet, first.order.id, 'practice');
  await assert.rejects(s.orders.pay(b.wallet, second.order.id, 'practice'), /refilling/, 'refused before any money moves');
  await s.db.close();
});

test('holder status needs the minimum held for the whole window', async () => {
  const s = await setup(), { wallet } = await user(s, false);
  s.solana.setHolderPpm(wallet, 10_000, Date.now() - 3_600_000);
  s.holders.forget(wallet);
  const check = await s.holders.check(wallet);
  assert.equal(check.holder, false, 'bought an hour ago, the window is 24h');
  assert.match(check.reason!, /24h/);
  await s.settings.save({ ...s.settings.current, holderWindowHours: 0 });
  assert.equal((await s.holders.check(wallet)).holder, true, 'with no window the balance now counts');
  await s.db.close();
});

test('a service fee is charged on top, refunded with the pack, and forwarded to the treasury', async () => {
  const s = await setup({ serviceFeeBps: 1_000, feeTransferThresholdUsd: 1 }), { wallet } = await user(s);
  const done = await pull(s, wallet, 'pokemon_25', 30);
  assert.equal(done.totalUsd, 27.5);
  assert.equal(await s.treasury.owedToTreasury(), micros(2.5));
  const before = await s.treasury.usdcBalance();
  await s.treasury.transferFees();
  assert.equal(await s.treasury.usdcBalance(), before + micros(2.5));
  assert.equal(await s.treasury.owedToTreasury(), 0);
  await s.db.close();
});
