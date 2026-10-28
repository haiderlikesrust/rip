import { randomUUID } from 'node:crypto';
import { atomic, audit, record, type Database } from './db';
import { PendingOperation, ReviewRequired } from './jobs';
import type { Solana } from './ports';
import type { SettingsStore } from './settings';
import type { Treasury } from './treasury';
import { usd, wholeTokens } from '../shared/economics';
import type { BurnBatchView, BurnStatus, BurnsView } from '../shared/types';

type BatchRow = { id: string; status: string; cards_units: string; usd_micros: string; pulls: number; coin_units: string | null; swap_signature: string | null; burn_signature: string | null; created_at: string; burned_at: string | null; error: string | null };

/**
 * Every settled pull queues a buyback-and-burn, fixed in $CARDS at that moment, and it runs right away: one
 * swap $CARDS → coin, then one burn. Pulls that settle while a burn is running go together in the next one,
 * and each pull's share of the coin burned is recorded pro rata, so every receipt links to it.
 */
export class Burns {
  private backoff = { failures: 0, until: 0, lastError: '' };
  constructor(readonly db: Database, readonly solana: Solana, readonly treasury: Treasury, readonly settings: SettingsStore) {}

  /** Idempotent per order. A pull whose burn rounds to nothing is recorded as skipped, so its receipt says so. */
  async queue(entry: { orderId: string; wallet: string; insuredMicros: number; usdMicros: number; cards: bigint }) {
    const status: BurnStatus = entry.cards > 0n ? 'queued' : 'skipped';
    await this.db.query('INSERT INTO burns(id,order_id,wallet,insured_micros,usd_micros,cards_units,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING',
      [`order:${entry.orderId}`, entry.orderId, entry.wallet, entry.insuredMicros, entry.usdMicros, entry.cards.toString(), status, Date.now()]);
  }

  /** Each order's burn: its USD, status and the batch's burn signature once executed. */
  async forOrders(ids: string[]) {
    if (!ids.length) return new Map<string, { usd: number; status: BurnStatus; signature: string | null }>();
    const rows = (await this.db.query<{ order_id: string; usd_micros: string; status: BurnStatus; burn_signature: string | null }>(
      'SELECT b.order_id, b.usd_micros::text, b.status, x.burn_signature FROM burns b LEFT JOIN burn_batches x ON x.id=b.batch_id WHERE b.order_id = ANY($1)', [ids])).rows;
    return new Map(rows.map(r => [r.order_id, { usd: usd(Number(r.usd_micros)), status: r.status, signature: r.status === 'burned' ? r.burn_signature : null }]));
  }

  /**
   * Starts or continues one burn of everything queued. Runs in the coordinator's Serial queue. `force`
   * (admin "burn now") retries without waiting out the backoff after a failure.
   */
  async step(force = false) {
    const s = this.settings.current;
    if (s.paused || !this.solana.canSpend || !this.solana.holderMint) return null;
    if (!force && Date.now() < this.backoff.until) return null;
    let batch = (await this.db.query<BatchRow>("SELECT * FROM burn_batches WHERE status='executing' ORDER BY created_at LIMIT 1")).rows[0];
    if (!batch) {
      const queued = (await this.db.query<{ id: string; usd_micros: string; cards_units: string; created_at: string }>("SELECT id, usd_micros::text, cards_units, created_at::text FROM burns WHERE status='queued' ORDER BY created_at LIMIT 500")).rows;
      if (!queued.length) return null;
      const totalUsd = queued.reduce((t, r) => t + Number(r.usd_micros), 0);
      const id = `burn-batch:${randomUUID()}`, cards = queued.reduce((t, r) => t + BigInt(r.cards_units), 0n);
      await atomic(this.db, async () => {
        await this.db.query('INSERT INTO burn_batches(id,status,cards_units,usd_micros,pulls,created_at) VALUES($1,$2,$3,$4,$5,$6)', [id, 'executing', cards.toString(), totalUsd, queued.length, Date.now()]);
        await this.db.query("UPDATE burns SET status='batched', batch_id=$1 WHERE id = ANY($2) AND status='queued'", [id, queued.map(r => r.id)]);
      });
      batch = (await this.db.query<BatchRow>('SELECT * FROM burn_batches WHERE id=$1', [id])).rows[0];
    }
    let result;
    try { result = await this.solana.buybackAndBurn(batch.id, BigInt(batch.cards_units), s); }
    catch (error) {
      if (error instanceof PendingOperation) throw error;
      const message = (error as Error).message, failures = this.backoff.failures + 1;
      await this.db.query('UPDATE burn_batches SET error=$2 WHERE id=$1', [batch.id, message]);
      // A burn that keeps failing (or that the chain layer gave up on) waits for the owner instead of looping.
      if (error instanceof ReviewRequired) await this.db.query("UPDATE burn_batches SET status='review' WHERE id=$1", [batch.id]);
      if (message !== this.backoff.lastError) await audit(this.db, 'burn-error', { id: batch.id, error: message, failures });
      this.backoff = { failures, until: Date.now() + Math.min(600_000, 30_000 * 2 ** Math.min(failures - 1, 5)), lastError: message };
      throw error;
    }
    this.backoff = { failures: 0, until: 0, lastError: '' };
    await this.settle(batch, result);
    this.treasury.invalidate();
    return { id: batch.id, cards: batch.cards_units, coin: result.tokens.toString(), usd: usd(Number(batch.usd_micros)) };
  }

  /** Splits the coin burned across the batch's pulls by their $CARDS share; the last pull takes the rounding. */
  private async settle(batch: BatchRow, result: { tokens: bigint; swapSignature: string; burnSignature: string }) {
    const rows = (await this.db.query<{ id: string; cards_units: string }>('SELECT id, cards_units FROM burns WHERE batch_id=$1 ORDER BY created_at, id', [batch.id])).rows;
    const total = BigInt(batch.cards_units), now = Date.now();
    await atomic(this.db, async () => {
      let given = 0n;
      for (const [i, r] of rows.entries()) {
        const share = i === rows.length - 1 ? result.tokens - given : total > 0n ? result.tokens * BigInt(r.cards_units) / total : 0n;
        given += share;
        await this.db.query("UPDATE burns SET status='burned', coin_units=$2, burned_at=$3 WHERE id=$1", [r.id, share.toString(), now]);
      }
      await this.db.query("UPDATE burn_batches SET status='burned', coin_units=$2, swap_signature=$3, burn_signature=$4, burned_at=$5, error=NULL WHERE id=$1", [batch.id, result.tokens.toString(), result.swapSignature, result.burnSignature, now]);
      await record(this.db, { id: batch.id, bucket: 'burn', kind: 'burn', micros: -Number(batch.usd_micros), signature: result.burnSignature, data: { coin: result.tokens.toString(), cards: batch.cards_units, swap: result.swapSignature } });
    });
  }

  /** Owner action: send a batch in review back to executing. Its swap and burn resume as the same jobs. */
  async retry(id: string) {
    const changed = (await this.db.query("UPDATE burn_batches SET status='executing', error=NULL WHERE id=$1 AND status='review' RETURNING id", [id])).rows.length;
    if (!changed) throw new Error('Only burn batches in review can be retried.');
    this.backoff = { failures: 0, until: 0, lastError: '' };
  }

  async view(limit = 30, before?: number): Promise<BurnsView> {
    const d = this.solana.holderDecimals;
    const totals = (await this.db.query<{ coin: string; usd: string; batches: number }>("SELECT COALESCE(SUM(coin_units::numeric),0)::text AS coin, COALESCE(SUM(usd_micros),0)::text AS usd, COUNT(*)::int AS batches FROM burn_batches WHERE status='burned'")).rows[0];
    const queued = (await this.db.query<{ usd: string; n: number }>("SELECT COALESCE(SUM(usd_micros),0)::text AS usd, COUNT(*)::int AS n FROM burns WHERE status IN ('queued','batched')")).rows[0];
    const burned = BigInt(totals.coin.split('.')[0]);
    let supply = 0n;
    try { supply = await this.solana.holderSupply(); } catch { /* the page still shows totals */ }
    const batches = (await this.db.query<BatchRow>(`SELECT * FROM burn_batches ${before ? 'WHERE created_at < $2' : ''} ORDER BY created_at DESC LIMIT $1`, before ? [limit, before] : [limit])).rows;
    return {
      totals: { coinBurned: wholeTokens(burned, d), usd: usd(Number(totals.usd)), supplyBps: supply + burned > 0n ? Number(burned * 1_000_000n / (supply + burned)) / 100 : 0, batches: totals.batches, queuedUsd: usd(Number(queued.usd)), queuedPulls: queued.n },
      batches: batches.map((b): BurnBatchView => ({
        id: b.id, status: b.status, cardsIn: Number(b.cards_units) / 1e6, usd: usd(Number(b.usd_micros)), coinBurned: wholeTokens(BigInt(b.coin_units ?? '0'), d), pulls: b.pulls,
        swapSignature: b.swap_signature, burnSignature: b.burn_signature, createdAt: Number(b.created_at), burnedAt: b.burned_at ? Number(b.burned_at) : null,
      })),
    };
  }
}
