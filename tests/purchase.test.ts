import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { buyPack } from '../server/cc/purchase';
import type { Purchase, PurchaseStore } from '../server/cc/store';

/** A paid pack Collector Crypt hasn't registered yet: our side is done, the purchase waits on their status. */
function paidPack(paidAgoMs: number) {
  const signer = Keypair.generate(), paymentWallet = Keypair.generate().publicKey, nft = Keypair.generate().publicKey.toBase58();
  const purchase: Purchase = { id: 'p1', wallet: signer.publicKey.toBase58(), recipient: paymentWallet.toBase58(), priceUsdc: 25, packType: 'pokemon_25', memo: 'cc-memo', transaction: 'x', signedTransaction: 'x', signature: 'sig', paid: true, paidAt: Date.now() - paidAgoMs };
  const saved = new Map<string, Purchase>([['p1', purchase]]);
  const store: PurchaseStore = { get: async id => saved.get(id) ?? null, save: async p => { saved.set(p.id, { ...p }); }, locked: (_id, action) => action() };
  const cc = { registered: false, opens: 0 } as { registered: boolean; opens: number };
  const client = {
    packStatus: async () => cc.registered
      ? { pack: { status: 'confirmed', wallet: purchase.wallet, pack_type: 'pokemon_25', transaction_signature: 'sig' }, send: { status: 'confirmed', nft_address: nft, to_wallet: purchase.wallet, insured_value: '12' } }
      : { pack: { status: null } },
    // Like Collector Crypt's site does after paying: asking it to open makes it register the payment.
    openPack: async () => { cc.opens++; cc.registered = true; return { code: 'OK', nft_address: nft, nftWon: { content: { metadata: { name: 'Card' } } } }; },
  } as any;
  const run = () => buyPack({ id: 'p1', priceUsdc: 25, packType: 'pokemon_25', maxPriceUsdc: 500, enabled: true, client, connection: {} as any, signer, paymentWallet: new PublicKey(paymentWallet), store });
  return { run, cc, saved };
}

/** Minimal signed v0 tx so buyPack can deserialize it when checking the blockhash before submit. */
function signedPayment(signer: Keypair, to: PublicKey) {
  const msg = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: to, lamports: 0 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([signer]);
  return Buffer.from(tx.serialize()).toString('base64');
}

test('a paid pack Collector Crypt has not registered is not opened before 30 seconds', async () => {
  const { run, cc } = paidPack(5_000);
  assert.equal((await run()).state, 'pending');
  assert.equal(cc.opens, 0);
});

test('after 30 seconds Collector Crypt is asked to open the paid pack, once a minute, and the pack then completes', async () => {
  const { run, cc, saved } = paidPack(31_000);
  cc.registered = false;
  const first = await run();
  assert.equal(first.state, 'pending', 'its status is read again on the next step');
  assert.equal(cc.opens, 1, 'asked to open the pack');
  assert.ok(saved.get('p1')!.nudgedAt);
  const done = await run();
  assert.equal(done.state, 'complete', 'registered now: verified and delivered as usual');
  assert.equal(cc.opens, 2, 'the normal open after it is registered');
});

test('the nudge is not repeated within a minute', async () => {
  const { run, cc, saved } = paidPack(31_000);
  saved.get('p1')!.nudgedAt = Date.now() - 10_000;
  await run();
  assert.equal(cc.opens, 0);
});

test('a signed unpaid pack is submitted through Collector Crypt so they register the payment', async () => {
  const signer = Keypair.generate(), paymentWallet = Keypair.generate().publicKey, nft = Keypair.generate().publicKey.toBase58();
  const signed = signedPayment(signer, paymentWallet);
  const purchase: Purchase = {
    id: 'p2', wallet: signer.publicKey.toBase58(), recipient: paymentWallet.toBase58(), priceUsdc: 25, packType: 'pokemon_25',
    memo: 'cc-memo', transaction: 'x', signedTransaction: signed, signature: 'sig',
  };
  const saved = new Map<string, Purchase>([['p2', purchase]]);
  const store: PurchaseStore = { get: async id => saved.get(id) ?? null, save: async p => { saved.set(p.id, { ...p }); }, locked: (_id, action) => action() };
  let submitted: string | null = null, rpcSends = 0;
  const client = {
    submitTransaction: async (tx: string) => { submitted = tx; return { signature: 'sig', confirmationStatus: 'confirmed' }; },
    packStatus: async () => ({ pack: { status: 'confirmed', wallet: purchase.wallet, pack_type: 'pokemon_25', transaction_signature: 'sig' }, send: { status: 'confirmed', nft_address: nft, to_wallet: purchase.wallet, insured_value: '12' } }),
    openPack: async () => ({ code: 'OK', nft_address: nft, nftWon: { content: { metadata: { name: 'Card' } } } }),
  } as any;
  const connection = {
    getSignatureStatuses: async () => ({ value: [null] }),
    isBlockhashValid: async () => ({ value: true }),
    sendRawTransaction: async () => { rpcSends++; return 'sig'; },
  } as any;

  const done = await buyPack({ id: 'p2', priceUsdc: 25, packType: 'pokemon_25', maxPriceUsdc: 500, enabled: true, client, connection, signer, paymentWallet, store });
  assert.equal(submitted, signed, 'handed the signed payment to Collector Crypt');
  assert.equal(rpcSends, 0, 'does not fall back to a raw RPC send when submit succeeds');
  assert.equal(done.state, 'complete');
  assert.equal(saved.get('p2')!.paid, true);
});

test('falls back to a raw RPC send when Collector Crypt submit fails', async () => {
  const signer = Keypair.generate(), paymentWallet = Keypair.generate().publicKey;
  const signed = signedPayment(signer, paymentWallet);
  const purchase: Purchase = {
    id: 'p3', wallet: signer.publicKey.toBase58(), recipient: paymentWallet.toBase58(), priceUsdc: 25, packType: 'pokemon_25',
    memo: 'cc-memo', transaction: 'x', signedTransaction: signed, signature: 'sig',
  };
  const saved = new Map<string, Purchase>([['p3', purchase]]);
  const store: PurchaseStore = { get: async id => saved.get(id) ?? null, save: async p => { saved.set(p.id, { ...p }); }, locked: (_id, action) => action() };
  let rpcSends = 0;
  const client = { submitTransaction: async () => { throw new Error('Collector Crypt submit down'); } } as any;
  const connection = {
    getSignatureStatuses: async () => ({ value: [null] }),
    isBlockhashValid: async () => ({ value: true }),
    sendRawTransaction: async () => { rpcSends++; return 'sig'; },
  } as any;

  const pending = await buyPack({ id: 'p3', priceUsdc: 25, packType: 'pokemon_25', maxPriceUsdc: 500, enabled: true, client, connection, signer, paymentWallet, store });
  assert.equal(pending.state, 'pending');
  assert.match(pending.message, /submitted/i);
  assert.equal(rpcSends, 1);
});
