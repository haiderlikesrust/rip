import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, settle, user } from './helpers';
import { lamports } from '../server/gas';
import { settingsSchema } from '../server/settings';
import { DEFAULT_SETTINGS, micros } from '../shared/economics';

const SOL = 1_000_000_000n;

test('TREASURY refills OPS with SOL when OPS runs low, and leaves it alone otherwise', async () => {
  const s = await setup();
  assert.equal(await s.gas.ensure(), null, 'both wallets start healthy');
  s.solana.sol.set('ops', lamports(0.02));
  const done = await s.gas.ensure();
  assert.ok(done);
  assert.equal(await s.solana.solBalance('ops'), lamports(DEFAULT_SETTINGS.gas.opsTargetSol));
  assert.equal(await s.solana.solBalance('treasury'), SOL - lamports(0.23));
  assert.equal(done.boughtUsd, 0, 'TREASURY had SOL to spare, so no USDC was spent');
  assert.equal(await s.gas.ensure(), null);
  await s.db.close();
});

test('when TREASURY is low too it buys SOL with a little treasury USDC first, recorded as network fees', async () => {
  const s = await setup();
  s.solana.sol.set('ops', 0n); s.solana.sol.set('treasury', lamports(0.06));
  const treasuryBefore = await s.treasury.usdcBalance();
  const done = await s.gas.ensure();
  assert.equal(done?.boughtUsd, DEFAULT_SETTINGS.gas.buyUsd);
  // $15 buys 0.1 SOL at the practice price; TREASURY sends what it can spare above its own reserve.
  assert.equal(await s.solana.solBalance('ops'), lamports(0.11));
  assert.equal(await s.solana.solBalance('treasury'), lamports(DEFAULT_SETTINGS.gasReserveSol));
  s.treasury.invalidate();
  assert.equal(await s.treasury.usdcBalance(), treasuryBefore - micros(DEFAULT_SETTINGS.gas.buyUsd));
  assert.equal((await s.treasury.view()).totals.networkFeesUsd, DEFAULT_SETTINGS.gas.buyUsd);
  // The next pass buys again to bring TREASURY back above its minimum.
  await s.gas.ensure();
  assert.equal(await s.solana.solBalance('treasury'), lamports(0.15));
  await s.db.close();
});

test('USDC spent on SOL stays inside the daily cap', async () => {
  const s = await setup({ gas: { ...DEFAULT_SETTINGS.gas, buyUsd: 15, maxUsdPerDay: 20 } });
  s.solana.sol.set('treasury', lamports(0.06));
  await s.gas.ensure();
  s.solana.sol.set('treasury', lamports(0.06));
  await s.gas.ensure();
  assert.equal(await s.gas.spentToday(), micros(20), 'second purchase is trimmed to what is left today');
  s.solana.sol.set('treasury', lamports(0.06));
  assert.equal(await s.gas.ensure(), null, 'nothing left to spend today');
  assert.equal(await s.gas.spentToday(), micros(20));
  await s.db.close();
});

test('an empty OPS wallet blocks new orders and pauses paid ones instead of sending them to review', async () => {
  const s = await setup(), { wallet } = await user(s);
  s.solana.sol.set('ops', 0n);
  await assert.rejects(s.orders.create(wallet, 'pokemon_25'), /network fees/);
  s.solana.sol.set('ops', SOL);
  (s.gas as unknown as { ops: null }).ops = null;
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  await s.orders.pay(wallet, order.id, 'practice');
  await s.orders.step();
  s.solana.sol.set('ops', 0n);
  (s.gas as unknown as { ops: null }).ops = null;
  for (let i = 0; i < 3; i++) await s.orders.step();
  const waiting = await s.orders.get(order.id);
  assert.notEqual(waiting.status, 'review');
  assert.match(waiting.message ?? '', /network fees/);
  await s.gas.ensure();
  assert.equal((await settle(s, order.id)).status, 'complete');
  await s.db.close();
});

test('gas settings must refill above the trigger and keep both wallets above the reserve', () => {
  assert.throws(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, gas: { ...DEFAULT_SETTINGS.gas, opsTargetSol: 0.05 } }), /refill level/);
  assert.throws(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, gas: { ...DEFAULT_SETTINGS.gas, treasuryMinSol: 0.02 } }), /gas reserve/);
  assert.ok(settingsSchema.parse(DEFAULT_SETTINGS));
});
