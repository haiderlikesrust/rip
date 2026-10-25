import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { config } from '../server/config';
import { publicError, redact } from '../server/redact';
import { isTransient } from '../server/orders';
import { ApiError } from '../server/cc/client';
import { ReviewRequired } from '../server/jobs';
import { setup, settle, user } from './helpers';
import { paymentFailure } from '../server/solana-live';
import { atomic } from '../server/db';

test('error messages shown to visitors never contain secrets or URLs', () => {
  const original = config.SOLANA_RPC_URL;
  config.SOLANA_RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=super-secret-key-123';
  try {
    const leaked = redact(`request to ${config.SOLANA_RPC_URL} failed, token=abc123 and https://other.example/x?key=1`);
    assert.doesNotMatch(leaked, /super-secret|helius|abc123|other\.example/);
    assert.equal(publicError(new TypeError('fetch failed')).status, 503);
    assert.equal(publicError(new TypeError("Cannot read properties of undefined (reading 'x')")).message, 'Something went wrong. Please try again.');
    const known = publicError(Object.assign(new Error('Order not found.'), { statusCode: 404 }));
    assert.deepEqual(known, { status: 404, message: 'Order not found.' });
    assert.ok(redact('x'.repeat(1000)).length <= 301);
  } finally { config.SOLANA_RPC_URL = original; }
});

test('only network trouble and provider 5xx/429 count as transient', () => {
  assert.equal(isTransient(new TypeError('fetch failed')), true);
  assert.equal(isTransient(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })), true);
  assert.equal(isTransient(new ApiError(503)), true);
  assert.equal(isTransient(new ApiError(429)), true);
  assert.equal(isTransient(new ApiError(400)), false);
  assert.equal(isTransient(new ReviewRequired('Pack payment asset, recipient or amount mismatch.')), false);
  assert.equal(isTransient(new Error('Provider purchase record does not match the saved payment.')), false);
});

test('a Collector Crypt outage after payment retries with backoff instead of going to review', async () => {
  const s = await setup(), { wallet } = await user(s);
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  await s.orders.pay(wallet, order.id, 'practice');
  s.packs.outageCalls = 3;
  for (let i = 0; i < 4; i++) {
    await s.orders.step();
    // Let the backoff elapse immediately.
    await s.db.query("UPDATE orders SET data=jsonb_set(data,'{retryAt}','0') WHERE id=$1", [order.id]);
  }
  const during = await s.orders.get(order.id);
  assert.notEqual(during.status, 'review');
  const done = await settle(s, order.id);
  assert.equal(done.status, 'complete');
  await s.db.close();
});

test('buyers see a plain message when an order is under review, never the internal error', async () => {
  const s = await setup(), { wallet } = await user(s);
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  await s.db.query("UPDATE orders SET status='review', data=jsonb_set(data,'{message}','\"RPC https://secret.example failed\"') WHERE id=$1", [order.id]);
  const view = await s.orders.get(order.id, wallet);
  assert.doesNotMatch(view.message!, /secret|RPC/);
  await s.db.close();
});

test('cancelling an unpaid order frees the buyer, but a payment that lands anyway still completes it', async () => {
  const s = await setup(), { wallet } = await user(s);
  const first = await s.orders.create(wallet, 'pokemon_25');
  await assert.rejects(s.orders.create(wallet, 'pokemon_25'), /current order/);
  await s.orders.cancel(wallet, first.order.id);
  const second = await s.orders.create(wallet, 'pokemon_50');
  assert.equal(second.order.status, 'awaiting_payment');
  // The wallet had already broadcast the first payment: it must not be lost.
  await s.orders.pay(wallet, first.order.id, 'practice');
  assert.equal((await settle(s, first.order.id)).status, 'complete');
  await assert.rejects(s.orders.cancel(Keypair.generate().publicKey.toBase58(), second.order.id), /not found/);
  await s.db.close();
});

test('before spending is enabled nothing can be bought', async () => {
  const s = await setup(), { wallet } = await user(s);
  s.solana.canSpend = false;
  assert.ok((await s.orders.quotes(wallet)).every(q => !q.quote.open));
  await assert.rejects(s.orders.create(wallet, 'pokemon_25'), /launch/);
  await s.db.close();
});

test('a pack payment that never landed is retried, then refunded, without going to review', async () => {
  const s = await setup(), { wallet } = await user(s);
  const retried = await s.orders.create(wallet, 'pokemon_25');
  await s.orders.pay(wallet, retried.order.id, 'practice');
  s.packs.unpaidFailures = 1;
  assert.equal((await settle(s, retried.order.id)).status, 'complete');
  const refunded = await s.orders.create(wallet, 'pokemon_25');
  await s.orders.pay(wallet, refunded.order.id, 'practice');
  s.packs.unpaidFailures = 4;
  const done = await settle(s, refunded.order.id);
  assert.equal(done.status, 'refunded');
  assert.ok(done.refundSignature);
  await s.db.close();
});

test('the owner cannot refund money that never arrived or was already spent on a pack', async () => {
  const s = await setup(), { wallet } = await user(s);
  const unpaid = await s.orders.create(wallet, 'pokemon_25');
  await s.db.query("UPDATE orders SET status='review', payment_signature='sig' WHERE id=$1", [unpaid.order.id]);
  await assert.rejects(s.orders.resolve(unpaid.order.id, 'refund'), /never confirmed/);
  // Retry goes back to checking the payment, never past it.
  await s.orders.resolve(unpaid.order.id, 'retry');
  assert.equal((await s.orders.get(unpaid.order.id)).status, 'paying');

  const other = await user(s), spent = await s.orders.create(other.wallet, 'pokemon_25');
  await s.orders.pay(other.wallet, spent.order.id, 'practice');
  await s.orders.step();
  await s.jobs.put(`cc:${spent.order.id}-0`, 'cc-purchase', 'pending', { signature: 'sent-to-cc' });
  await s.db.query("UPDATE orders SET status='review', data=data-'card' WHERE id=$1", [spent.order.id]);
  await assert.rejects(s.orders.resolve(spent.order.id, 'refund'), /pack payment was sent/);
  await s.db.close();
});

test('a buyer without enough USDC or SOL is told why before being asked to sign', async () => {
  const s = await setup(), { wallet } = await user(s);
  s.solana.funds.set(wallet, { usdcAccount: false, usdcMicros: 0n, lamports: 1_000_000_000n });
  await assert.rejects(s.orders.create(wallet, 'pokemon_25'), /costs \$25\.00 in USDC and this wallet has \$0\.00/);
  s.solana.funds.set(wallet, { usdcAccount: true, usdcMicros: 20_000_000n, lamports: 1_000_000_000n });
  await assert.rejects(s.orders.create(wallet, 'pokemon_25'), /has \$20\.00/);
  s.solana.funds.set(wallet, { usdcAccount: true, usdcMicros: 30_000_000n, lamports: 0n });
  await assert.rejects(s.orders.create(wallet, 'pokemon_25'), /needs a little SOL/);
  s.solana.funds.set(wallet, { usdcAccount: true, usdcMicros: 30_000_000n, lamports: 5_000_000n });
  assert.equal((await s.orders.create(wallet, 'pokemon_25')).order.status, 'awaiting_payment');
  await s.db.close();
});

test('orders wait until OPS has a USDC account, which the wallet task creates', async () => {
  const s = await setup(), { wallet } = await user(s);
  s.solana.usdcAccounts.clear();
  await assert.rejects(s.orders.create(wallet, 'pokemon_25'), /being set up/);
  await s.gas.ensure();
  assert.ok(await s.solana.hasUsdcAccount('ops') && await s.solana.hasUsdcAccount('treasury'));
  assert.equal((await s.orders.create(wallet, 'pokemon_25')).order.status, 'awaiting_payment');
  await s.db.close();
});

test('failed payment broadcasts become one plain sentence', () => {
  assert.match(paymentFailure('Transaction simulation failed: Error processing Instruction 2: invalid account data for instruction. Logs: [...]'), /no USDC yet/);
  assert.match(paymentFailure('Attempt to debit an account but found no record of a prior credit.'), /little SOL/);
  assert.match(paymentFailure('custom program error: 0x1'), /not have enough USDC/);
  assert.match(paymentFailure('Blockhash not found'), /took too long/);
  assert.doesNotMatch(paymentFailure('Program ComputeBudget111 failed: weird'), /Program|ComputeBudget/);
});

test('a delayed order tells the owner why once, and Retry now skips the wait', async () => {
  const s = await setup(), { wallet } = await user(s);
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  await s.orders.pay(wallet, order.id, 'practice');
  s.packs.outageCalls = 2;
  await s.orders.step(); await s.orders.step(); // payment confirmed, then the first outage
  await s.orders.retryNow(order.id); await s.orders.step(); // the same outage again
  const view = await s.orders.get(order.id, wallet);
  assert.match(view.message ?? '', /payment is safe/);
  const logged = (await s.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM audit WHERE event='order-delayed'")).rows[0].n;
  assert.equal(logged, 1, 'one entry while the reason stays the same');
  const before = Number((await s.db.query("SELECT data->>'retryAt' AS r FROM orders WHERE id=$1", [order.id])).rows[0].r);
  assert.ok(before > Date.now(), 'waiting to retry');
  await s.orders.retryNow(order.id);
  assert.equal(Number((await s.db.query("SELECT data->>'retryAt' AS r FROM orders WHERE id=$1", [order.id])).rows[0].r), 0);
  assert.equal((await settle(s, order.id)).status, 'complete');
  await s.db.close();
});

test('if Collector Crypt keeps failing before we paid it, the buyer is refunded within minutes', async () => {
  const s = await setup(), { wallet } = await user(s);
  const { order } = await s.orders.create(wallet, 'pokemon_50');
  await s.orders.pay(wallet, order.id, 'practice');
  s.packs.outageCalls = 100;
  for (let i = 0; i < 12; i++) { await s.orders.step(); await s.db.query("UPDATE orders SET data=jsonb_set(data,'{retryAt}','0') WHERE id=$1", [order.id]); }
  const done = await settle(s, order.id);
  assert.equal(done.status, 'refunded');
  assert.ok(done.refundSignature);
  await s.db.close();
});

test('once a pack payment was sent to Collector Crypt, failures keep retrying instead of refunding', async () => {
  const s = await setup(), { wallet } = await user(s);
  const { order } = await s.orders.create(wallet, 'pokemon_50');
  await s.orders.pay(wallet, order.id, 'practice');
  await s.orders.step();
  await s.jobs.put(`cc:${order.id}-0`, 'cc-purchase', 'signed', { signature: 'sent-to-cc' });
  s.packs.outageCalls = 100;
  for (let i = 0; i < 12; i++) { await s.orders.step(); await s.db.query("UPDATE orders SET data=jsonb_set(data,'{retryAt}','0') WHERE id=$1", [order.id]); }
  const order2 = await s.orders.get(order.id);
  assert.ok(['paid', 'buying'].includes(order2.status), `still trying, not ${order2.status}`);
  await s.db.close();
});

test('a query from outside a transaction is not undone when that transaction rolls back', async () => {
  const s = await setup();
  const slow = atomic(s.db, async () => {
    await s.db.query("INSERT INTO audit(event,data,created_at) VALUES('inside','{}',0)");
    await new Promise(r => setTimeout(r, 30));
    throw new Error('roll back');
  });
  // Sent while the transaction is open: it waits for it instead of joining it.
  const outside = s.db.query("INSERT INTO audit(event,data,created_at) VALUES('outside','{}',0)");
  await assert.rejects(slow, /roll back/);
  await outside;
  const events = (await s.db.query<{ event: string }>("SELECT event FROM audit WHERE event IN ('inside','outside')")).rows.map(r => r.event);
  assert.deepEqual(events, ['outside']);
  await s.db.close();
});

test('a card that arrives before its insured value is delivered, and the repay and burn use the value read later', async () => {
  const s = await setup(), { wallet } = await user(s);
  s.packs.valueLater = true;
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  await s.orders.pay(wallet, order.id, 'practice');
  const done = await settle(s, order.id);
  assert.equal(done.status, 'complete');
  assert.ok(done.nftSignature, 'the card was sent');
  assert.ok(done.valueUsd !== null && done.valueUsd > 0, 'value read from Collector Crypt at settling');
  assert.equal(done.repayUsd, Math.max(0, Math.round((25 - done.valueUsd!) * 1e6)) / 1e6, 'repaid against the value read later');
  assert.ok(done.burn && done.burn.usd > 0, 'burn sized from the value read later');
  await s.db.close();
});
