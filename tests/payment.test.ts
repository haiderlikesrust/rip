import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { LIGHTHOUSE_PROGRAM, buildPayment, validateSignedPayment } from '../server/payment';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function fixture(micros = 27_500_000) {
  const user = Keypair.generate(), ops = Keypair.generate().publicKey.toBase58();
  const built = buildPayment({ user: user.publicKey.toBase58(), recipient: ops, usdcMint: USDC, micros, memo: 'pp-test' }, Keypair.generate().publicKey.toBase58());
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, 'base64'));
  const sign = (t = tx, k = user) => { t.sign([k]); return Buffer.from(t.serialize()).toString('base64'); };
  return { user, ops, built, tx, sign };
}

test('a correctly signed payment validates', () => {
  const f = fixture();
  const tx = validateSignedPayment(f.sign(), f.built.intent);
  assert.equal(tx.message.staticAccountKeys[0].toBase58(), f.user.publicKey.toBase58());
});

test('payments signed by another key, or unsigned, are rejected', () => {
  const f = fixture();
  assert.throws(() => validateSignedPayment(f.built.transaction, f.built.intent), /signature/);
  const other = fixture();
  assert.throws(() => validateSignedPayment(f.sign(), { ...other.built.intent, blockhash: f.built.blockhash }), /match|signed/);
});

test('a payment for a different amount or recipient is rejected even if signed', () => {
  const f = fixture();
  assert.throws(() => validateSignedPayment(f.sign(), { ...f.built.intent, micros: 1 }), /amount/);
  assert.throws(() => validateSignedPayment(f.sign(), { ...f.built.intent, recipient: Keypair.generate().publicKey.toBase58() }), /recipient/);
  assert.throws(() => validateSignedPayment(f.sign(), { ...f.built.intent, memo: 'pp-other' }), /memo/);
});

test('wallets may add compute budget, but not other programs', () => {
  const f = fixture();
  const message = TransactionMessage.decompile(f.tx.message);
  const withBudget = new VersionedTransaction(new TransactionMessage({ ...message, instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...message.instructions] }).compileToV0Message());
  validateSignedPayment(f.sign(withBudget), f.built.intent);
  const drain = new VersionedTransaction(new TransactionMessage({ ...message, instructions: [...message.instructions, SystemProgram.transfer({ fromPubkey: f.user.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message());
  assert.throws(() => validateSignedPayment(f.sign(drain), f.built.intent), /Unexpected program/);
});

test('a payment re-signed against a different blockhash is rejected', () => {
  const f = fixture();
  const message = TransactionMessage.decompile(f.tx.message);
  const later = new VersionedTransaction(new TransactionMessage({ ...message, recentBlockhash: Keypair.generate().publicKey.toBase58() }).compileToV0Message());
  assert.throws(() => validateSignedPayment(f.sign(later), f.built.intent), /changed the payment/);
  // Orders created before the pin was added carry no blockhash and still validate.
  const { blockhash: _, ...legacy } = f.built.intent;
  validateSignedPayment(f.sign(later), legacy);
});

test('Lighthouse balance guards added by Phantom are accepted', () => {
  const f = fixture();
  const message = TransactionMessage.decompile(f.tx.message);
  const guard = new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_PROGRAM), keys: [{ pubkey: f.user.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) });
  const guarded = new VersionedTransaction(new TransactionMessage({ ...message, instructions: [...message.instructions, guard] }).compileToV0Message());
  validateSignedPayment(f.sign(guarded), f.built.intent);
});
