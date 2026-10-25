import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type VersionedMessage } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import nacl from 'tweetnacl';
import { ReviewRequired } from './jobs';

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** Wallets such as Phantom may append Lighthouse balance assertions; they only constrain the signer. */
export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';

/** `blockhash` pins the payment to the one the server issued, so it can't land after the order expired. Older orders lack it. */
export type PaymentIntent = { user: string; recipient: string; usdcMint: string; micros: number; memo: string; reference: string; blockhash?: string };

/**
 * An unsigned USDC transfer from the user's wallet to OPS, paid for by the user.
 * The random `reference` key (Solana Pay style) lets us find the transaction on-chain
 * even if the wallet broadcasts it itself and never reports back.
 */
export function buildPayment(intent: Omit<PaymentIntent, 'reference'>, recentBlockhash: string) {
  const reference = Keypair.generate().publicKey;
  const user = new PublicKey(intent.user), mint = new PublicKey(intent.usdcMint);
  const transfer = createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, user, true), mint, getAssociatedTokenAddressSync(mint, new PublicKey(intent.recipient)), user, BigInt(intent.micros), 6);
  transfer.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    transfer,
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(intent.memo, 'utf8') }),
  ];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash, instructions }).compileToV0Message());
  return { intent: { ...intent, reference: reference.toBase58(), blockhash: recentBlockhash }, transaction: Buffer.from(tx.serialize()).toString('base64'), blockhash: recentBlockhash };
}

/** Checks a message pays exactly the intent. Extra instructions may only be compute budget or Lighthouse guards. */
export function validatePaymentMessage(message: VersionedMessage, intent: PaymentIntent) {
  if (message.addressTableLookups.length) throw new ReviewRequired('Payment must not use address lookup tables.');
  if (intent.blockhash && message.recentBlockhash !== intent.blockhash) throw new ReviewRequired('Your wallet changed the payment. Please try again; if it keeps happening, try a different wallet.');
  const decoded = TransactionMessage.decompile(message);
  const user = new PublicKey(intent.user), mint = new PublicKey(intent.usdcMint), reference = new PublicKey(intent.reference);
  const signers = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures);
  if (!decoded.payerKey.equals(user) || signers.length !== 1) throw new ReviewRequired('Payment must be signed and paid for by your wallet only.');
  const source = getAssociatedTokenAddressSync(mint, user, true), destination = getAssociatedTokenAddressSync(mint, new PublicKey(intent.recipient));
  let transfers = 0, memos = 0;
  for (const ix of decoded.instructions) {
    const program = ix.programId.toBase58();
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      // TransferChecked: [source, mint, destination, authority, ...reference]
      if (ix.data[0] !== 12 || ix.data.length !== 10 || ix.keys.length !== 5) throw new ReviewRequired('Unexpected token instruction in payment.');
      const [from, m, to, authority, ref] = ix.keys;
      if (!from.pubkey.equals(source) || !m.pubkey.equals(mint) || !to.pubkey.equals(destination) || !authority.pubkey.equals(user) || !ref.pubkey.equals(reference) || ix.data.readBigUInt64LE(1) !== BigInt(intent.micros) || ix.data[9] !== 6) throw new ReviewRequired('Payment amount, asset or recipient does not match the order.');
      transfers++;
    } else if (ix.programId.equals(MEMO_PROGRAM)) {
      if (ix.data.toString('utf8') !== intent.memo) throw new ReviewRequired('Payment memo does not match the order.');
      memos++;
    } else if (!ix.programId.equals(ComputeBudgetProgram.programId) && program !== LIGHTHOUSE_PROGRAM) {
      throw new ReviewRequired(`Unexpected program ${program} in payment.`);
    }
  }
  if (transfers !== 1 || memos !== 1) throw new ReviewRequired('Payment must contain exactly one transfer and one memo.');
}

/** Validates a wallet-signed payment and returns its signature (base58 is done by the caller). */
export function validateSignedPayment(signedBase64: string, intent: PaymentIntent) {
  const bytes = Buffer.from(signedBase64, 'base64');
  if (bytes.length > 1232) throw new ReviewRequired('Signed payment is too large.');
  const tx = VersionedTransaction.deserialize(bytes);
  validatePaymentMessage(tx.message, intent);
  if (!nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[0], new PublicKey(intent.user).toBytes())) throw new ReviewRequired('Wallet signature is missing or invalid.');
  return tx;
}
