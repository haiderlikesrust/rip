import { PublicKey, type ConfirmedSignatureInfo, type Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';
import type { HolderHistory } from './ports';

/** Signature pages read per token account (1,000 each). Enough for any ordinary holder's full history. */
const MAX_PAGES = 10;
/** Balance changes read inside the window. A wallet busier than this can't be checked automatically. */
const MAX_CHANGES = 500;

type Reader = (rpc: Connection, signatures: string[]) => Promise<(ParsedTransactionWithMeta | null)[]>;
export type Change = { at: number; balance: bigint };

/** The wallet's balance just after the last change at or before `t`; null when there was no change by then. */
export function balanceAt(changes: Change[], t: number): bigint | null {
  let balance: bigint | null = null;
  for (const c of changes) { if (c.at > t) break; balance = c.balance; }
  return balance;
}

/** A token account's balance after a transaction; 0 when the transaction closed it, null when it isn't in it. */
export function postBalance(tx: ParsedTransactionWithMeta | null, account: string): bigint | null {
  if (!tx?.meta) return null;
  const index = tx.transaction.message.accountKeys.findIndex(k => (typeof k.pubkey === 'string' ? k.pubkey : k.pubkey.toBase58()) === account);
  if (index < 0) return null;
  const entry = tx.meta.postTokenBalances?.find(b => b.accountIndex === index);
  return entry ? BigInt(entry.uiTokenAmount.amount) : 0n;
}

/**
 * A wallet's coin balance over time, read from its token accounts' transactions: every change since
 * `sinceMs`, the last change before it (the balance going into the window), and when the wallet first
 * received the coin. Several accounts for the same coin are added together.
 */
export async function readHolderHistory(rpc: Connection, read: Reader, owner: string, mint: string, sinceMs: number): Promise<HolderHistory> {
  const accounts = (await rpc.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed')).value;
  let current = 0n, firstAt: number | null = null, complete = true;
  const perAccount: Change[][] = [];
  for (const a of accounts) {
    current += BigInt(a.account.data.parsed.info.tokenAmount.amount);
    const history = await accountHistory(rpc, read, a.pubkey, sinceMs);
    perAccount.push(history.changes);
    if (!history.complete) complete = false;
    if (history.firstAt !== null) firstAt = firstAt === null ? history.firstAt : Math.min(firstAt, history.firstAt);
  }
  const times = [...new Set(perAccount.flat().map(c => c.at))].sort((a, b) => a - b);
  const changes = times.map(at => ({ at, balance: perAccount.reduce((sum, list) => sum + (balanceAt(list, at) ?? 0n), 0n) }));
  return { changes, current, firstAt: complete ? firstAt : null, complete };
}

async function accountHistory(rpc: Connection, read: Reader, account: PublicKey, sinceMs: number) {
  const signatures: ConfirmedSignatureInfo[] = [];
  let before: string | undefined, complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await rpc.getSignaturesForAddress(account, { limit: 1000, before }, 'confirmed');
    signatures.push(...batch.filter(s => !s.err && s.blockTime));
    if (batch.length < 1000) { complete = true; break; }
    before = batch[batch.length - 1].signature;
  }
  // Newest first: everything since the window opened, then the first one older than that.
  const inWindow = signatures.filter(s => s.blockTime! * 1000 >= sinceMs);
  const prior = signatures.find(s => s.blockTime! * 1000 < sinceMs);
  const wanted = prior ? [...inWindow, prior] : inWindow;
  if (wanted.length > MAX_CHANGES) throw new Error('This wallet trades the coin too often to check automatically. Contact us to claim.');
  const changes: Change[] = [], key = account.toBase58();
  for (let i = 0; i < wanted.length; i += 50) {
    const batch = wanted.slice(i, i + 50), txs = await read(rpc, batch.map(s => s.signature));
    txs.forEach((tx, j) => { const balance = postBalance(tx, key); if (balance !== null) changes.push({ at: batch[j].blockTime! * 1000, balance }); });
  }
  changes.sort((a, b) => a.at - b.at);
  const oldest = signatures.length ? signatures[signatures.length - 1].blockTime! * 1000 : null;
  return { changes, complete, firstAt: complete ? oldest : null };
}
