import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { balanceAt, postBalance, readHolderHistory } from '../server/coin-history';

const HOUR = 3_600_000, owner = 'BXej5ZYyNU521jd94YvmhCL1nudc2iGBEnRQ2n5o24J4', mint = 'So11111111111111111111111111111111111111112';
const ata = new PublicKey('D9CEogjHA6CpS12F8St9zpSco7pQKJB5uR1RqDsuzQZk'), other = new PublicKey('GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3');

/** A parsed transaction that leaves `account` holding `amount` (or closes it, with null). */
function tx(account: PublicKey, amount: string | null) {
  return { meta: { postTokenBalances: amount === null ? [] : [{ accountIndex: 1, uiTokenAmount: { amount } }] }, transaction: { message: { accountKeys: [{ pubkey: other }, { pubkey: account }] } } } as any;
}

test('balances are read from each transaction, and a closed account counts as zero', () => {
  assert.equal(postBalance(tx(ata, '500'), ata.toBase58()), 500n);
  assert.equal(postBalance(tx(ata, null), ata.toBase58()), 0n, 'closed in this transaction');
  assert.equal(postBalance(tx(ata, '500'), new PublicKey(mint).toBase58()), null, 'not in this transaction');
  const changes = [{ at: 10, balance: 5n }, { at: 20, balance: 0n }, { at: 30, balance: 7n }];
  assert.equal(balanceAt(changes, 5), null);
  assert.equal(balanceAt(changes, 20), 0n);
  assert.equal(balanceAt(changes, 25), 0n);
  assert.equal(balanceAt(changes, 99), 7n);
});

test('the history covers the window, the balance going into it, and when the wallet first got the coin', async () => {
  const now = Date.now(), since = now - 48 * HOUR;
  // Newest first, as the RPC returns them: two changes in the window, one before it, and the first buy.
  const sigs = [['s4', now - HOUR, '900'], ['s3', now - 10 * HOUR, '300'], ['s2', now - 60 * HOUR, '1000'], ['s1', now - 90 * HOUR, '400']] as const;
  const fetched: string[] = [];
  const rpc = {
    getParsedTokenAccountsByOwner: async () => ({ value: [{ pubkey: ata, account: { data: { parsed: { info: { tokenAmount: { amount: '900' } } } } } }] }),
    getSignaturesForAddress: async () => sigs.map(([signature, at]) => ({ signature, blockTime: Math.floor(at / 1000), err: null })),
  } as any;
  const read = async (_rpc: unknown, signatures: string[]) => { fetched.push(...signatures); return signatures.map(s => tx(ata, sigs.find(x => x[0] === s)![2])); };
  const history = await readHolderHistory(rpc, read, owner, mint, since);
  assert.deepEqual(fetched, ['s4', 's3', 's2'], 'only the window and the change just before it are read');
  assert.deepEqual(history.changes.map(c => c.balance), [1000n, 300n, 900n]);
  assert.equal(history.current, 900n);
  assert.equal(history.firstAt, Math.floor((now - 90 * HOUR) / 1000) * 1000, 'the oldest transaction on the account');
  assert.equal(history.complete, true);
  assert.equal(balanceAt(history.changes, since), 1000n, 'the balance going into the window');
});

