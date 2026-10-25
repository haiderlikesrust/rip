import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';

/**
 * Light checks on a quick-sell transaction before it is handed to Collector Crypt: it must be
 * signed by the card's owner and must involve that card. The owner's wallet already showed the
 * full effect (card out, USDC in) before they approved it; Collector Crypt validates the rest.
 */
export function checkSaleTransaction(signedBase64: string, owner: string, mint: string) {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(Buffer.from(signedBase64, 'base64')); }
  catch { throw new Error('That is not a valid signed sale.'); }
  const keys = tx.message.staticAccountKeys.map(k => k.toBase58());
  const index = keys.slice(0, tx.message.header.numRequiredSignatures).indexOf(owner);
  if (index < 0) throw new Error('The sale must be signed by the wallet that holds the card.');
  // The card may sit in an address lookup table; only a plain account list can be checked here.
  if (!tx.message.addressTableLookups.length && !keys.includes(mint)) throw new Error('This sale is for a different card.');
  let message: Uint8Array | null = null;
  try { message = tx.message.serialize(); } catch { /* a newer transaction format: Collector Crypt verifies the signature */ }
  if (message && !nacl.sign.detached.verify(message, tx.signatures[index], new PublicKey(owner).toBytes())) throw new Error('The sale was not signed by your wallet.');
}
