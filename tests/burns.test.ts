import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pull, setup, user } from './helpers';
import { micros } from '../shared/economics';

const CARDS = 1_000_000n;

test('queued burns wait for the batch minimum, then run as one swap and burn', async () => {
  const s = await setup({ burnBatchMinUsd: 50 }), { wallet } = await user(s);
  await pull(s, wallet, 'pokemon_25', 20);
  assert.equal(await s.burns.step(), null, '$20 is under the $50 batch minimum');
  await pull(s, wallet, 'pokemon_25', 40);
  const cardsBefore = s.solana.cards;
  const result = await s.burns.step();
  assert.ok(result, 'two pulls worth $60 make a batch');
  assert.equal(result!.usd, 60);
  assert.equal(s.solana.cards, cardsBefore - 240n * CARDS, '$60 of $CARDS at $0.25');
  // $60 / $0.0004 = 150,000 coins burned.
  assert.equal(s.solana.burned, 150_000n * CARDS);
  const view = await s.burns.view();
  assert.equal(view.totals.coinBurned, '150000');
  assert.equal(view.totals.usd, 60);
  assert.equal(view.batches[0].pulls, 2);
  const shares = (await s.db.query<{ coin: string }>("SELECT coin_units AS coin FROM burns WHERE status='burned' ORDER BY usd_micros")).rows.map(r => BigInt(r.coin));
  assert.deepEqual(shares, [50_000n * CARDS, 100_000n * CARDS], 'each pull gets its pro-rata share');
  const order = (await s.orders.list(wallet))[0];
  assert.equal(order.burn?.status, 'burned');
  assert.ok(order.burn?.signature, 'the receipt links to the burn');
  await s.db.close();
});

test('an old queued burn runs after burnEveryMinutes even below the minimum', async () => {
  const s = await setup({ burnBatchMinUsd: 1_000, burnEveryMinutes: 10 }), { wallet } = await user(s);
  await pull(s, wallet, 'pokemon_25', 5);
  assert.equal(await s.burns.step(), null);
  await s.db.query('UPDATE burns SET created_at=$1', [Date.now() - 11 * 60_000]);
  assert.equal((await s.burns.step())?.usd, 5);
  await s.db.close();
});

test('when the fund is small each pull burns at most X% of what is free, so some is always kept', async () => {
  const s = await setup({ burnCapBps: 5_000 }), { wallet } = await user(s);
  s.solana.cards = 400n * CARDS; s.treasury.invalidate(); // $100 fund
  const first = await pull(s, wallet, 'pokemon_100', 80);
  assert.equal(first.burn?.usd, 50, 'half of the $100 fund');
  const second = await pull(s, wallet, 'pokemon_100', 80);
  assert.equal(second.burn?.usd, 25, 'half of the $50 still free: queued burns are already promised');
  assert.equal(await s.treasury.freeCards(), 100n * CARDS, '$25 of $CARDS is kept for later');
  await s.db.close();
});

test('an empty fund records the burn as skipped instead of promising $CARDS it does not have', async () => {
  const s = await setup(), { wallet } = await user(s);
  s.solana.cards = 0n; s.treasury.invalidate();
  const done = await pull(s, wallet, 'pokemon_25', 10);
  assert.equal(done.status, 'complete');
  assert.deepEqual(done.burn, { usd: 0, status: 'skipped', signature: null });
  await s.db.close();
});

test('a failed burn keeps its batch and resumes as the same batch', async () => {
  const s = await setup({ burnBatchMinUsd: 1 }), { wallet } = await user(s);
  await pull(s, wallet, 'pokemon_25', 10);
  s.solana.burnFailures = 1;
  await assert.rejects(s.burns.step(), /No supported swap route/);
  const batch = (await s.db.query("SELECT id, status, error FROM burn_batches")).rows[0];
  assert.equal(batch.status, 'executing');
  assert.match(batch.error, /swap route/);
  await assert.doesNotReject(s.burns.step(true));
  const after = (await s.db.query("SELECT id, status FROM burn_batches")).rows;
  assert.deepEqual(after, [{ id: batch.id, status: 'burned' }], 'one batch, burned once');
  await s.db.close();
});

test('repays come first: the reserve refills from free $CARDS but never from $CARDS promised to burns', async () => {
  const s = await setup({ usdcReserveTargetUsd: 500, burnBatchMinUsd: 10_000 }), { wallet } = await user(s);
  await pull(s, wallet, 'pokemon_100', 100); // queues a $100 burn = 400 $CARDS
  s.solana.setTreasuryUsdc(micros(100)); s.solana.cards = 1_000n * CARDS; s.treasury.invalidate();
  const refill = await s.treasury.refill();
  assert.ok(refill);
  assert.equal(refill!.usdcMicros, micros(150), 'only the 600 free $CARDS are sold, not the 400 owed to the burn');
  assert.equal(s.solana.cards, 400n * CARDS);
  assert.equal(await s.treasury.freeUsdc(), micros(250));
  assert.equal(await s.treasury.refill(), null, 'nothing free is left to sell');
  await s.db.close();
});

test('claimed creator fees stay as $CARDS in the burn fund and show on the treasury page', async () => {
  const s = await setup();
  const before = s.solana.cards;
  s.solana.queueCreatorFees(250);
  assert.equal(await s.treasury.creatorFeesDue(), true);
  await s.treasury.creatorFees(true);
  assert.equal(s.solana.cards, before + 1_000n * CARDS, '$250 at $0.25');
  const view = await s.treasury.view();
  assert.equal(view.totals.creatorFeesUsd, 250);
  assert.equal(view.cards.priceUsd, 0.25);
  await s.db.close();
});
