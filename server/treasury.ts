import { randomUUID } from 'node:crypto';
import { atomic, audit, record, sum, type Database } from './db';
import { Jobs, PendingOperation } from './jobs';
import type { Solana } from './ports';
import type { SettingsStore } from './settings';
import { burnUsdMicros, cardsForUsd, micros, usd } from '../shared/economics';
import { SELLING } from '../shared/packs';
import type { TreasuryView } from '../shared/types';

/** $CARDS has 6 decimals. */
const CARDS_UNIT = 1_000_000;
/** Refills smaller than this aren't worth a swap. */
const MIN_REFILL_MICROS = micros(1);

/**
 * The treasury is the dev wallet and the coin's creator-fee recipient. It holds two things:
 * - **USDC, the repay reserve.** Free USDC = balance − reservations for paid holder orders. Holder packs
 *   pause at any price free USDC can't cover.
 * - **$CARDS, the burn fund.** Free $CARDS = balance − $CARDS already promised to queued burns − $CARDS being
 *   sold in a refill. Each pull burns at most `burnCapBps` of the free fund.
 * Claimed creator fees stay as $CARDS; `refill` sells just enough of them to bring free USDC back to its
 * target before anything else, so repays always come first.
 */
export class Treasury {
  private usdcCache: { micros: number; at: number } | null = null;
  private cardsCache: { units: bigint; at: number } | null = null;
  private priceCache: { usdcPerUnit: number; at: number } | null = null;
  constructor(readonly db: Database, readonly jobs: Jobs, readonly solana: Solana, readonly settings: SettingsStore) {}

  invalidate() { this.usdcCache = null; this.cardsCache = null; }

  async usdcBalance() {
    if (this.usdcCache && Date.now() - this.usdcCache.at < 15_000) return this.usdcCache.micros;
    const value = this.solana.treasuryAddress ? Number(await this.solana.usdcBalance(this.solana.treasuryAddress)) : 0;
    this.usdcCache = { micros: value, at: Date.now() };
    return value;
  }
  async reserved() { return Number((await this.db.query<{ total: string }>('SELECT COALESCE(SUM(micros),0)::text AS total FROM reservations WHERE released_at IS NULL')).rows[0].total); }
  async freeUsdc() { return (await this.usdcBalance()) - (await this.reserved()); }

  async cardsBalance() {
    if (this.cardsCache && Date.now() - this.cardsCache.at < 15_000) return this.cardsCache.units;
    const units = this.solana.treasuryAddress ? await this.solana.cardsBalance() : 0n;
    this.cardsCache = { units, at: Date.now() };
    return units;
  }
  /** $CARDS promised to burns that haven't executed yet. */
  async queuedCards() { return BigInt((await this.db.query<{ total: string }>("SELECT COALESCE(SUM(cards_units::numeric),0)::text AS total FROM burns WHERE status IN ('queued','batched')")).rows[0].total); }
  /** $CARDS set aside by a refill that is still selling. */
  async refillingCards() {
    const rows = (await this.db.query<{ data: { units: string; soldUsdc?: number } }>("SELECT data FROM jobs WHERE kind='refill' AND status<>'complete'")).rows;
    return rows.reduce((s, r) => s + BigInt(r.data.units), 0n);
  }
  async freeCards() {
    const free = (await this.cardsBalance()) - (await this.queuedCards()) - (await this.refillingCards());
    return free > 0n ? free : 0n;
  }
  /** USDC micros per smallest $CARDS unit, cached for 30 seconds. */
  async cardsPrice() {
    if (this.priceCache && Date.now() - this.priceCache.at < 30_000) return this.priceCache.usdcPerUnit;
    const usdcPerUnit = await this.solana.cardsPrice();
    this.priceCache = { usdcPerUnit, at: Date.now() };
    return usdcPerUnit;
  }
  async freeFundUsd() { return Math.floor(Number(await this.freeCards()) * await this.cardsPrice()); }

  /** Callers run inside the coordinator's Serial queue, so check-then-insert cannot race. */
  async reserve(id: string, amount: number) {
    if (amount <= 0) return;
    // Idempotent: an order that already holds its reservation keeps it.
    if ((await this.db.query('SELECT 1 FROM reservations WHERE id=$1 AND released_at IS NULL', [id])).rows.length) return;
    if ((await this.freeUsdc()) < amount) throw new Error('The repay reserve is refilling from creator fees right now. Holder packs at this price reopen shortly. Nothing was charged.');
    await this.db.query('INSERT INTO reservations(id,micros,created_at) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET micros=EXCLUDED.micros,created_at=EXCLUDED.created_at,released_at=NULL', [id, amount, Date.now()]);
  }
  async release(id: string) { await this.db.query('UPDATE reservations SET released_at=$2 WHERE id=$1 AND released_at IS NULL', [id, Date.now()]); }

  /**
   * Fixes one pull's buyback-and-burn: USD = min(insured value, X% of the free fund), converted to $CARDS
   * at today's price. A fund that is empty or can't be priced burns nothing for this pull.
   */
  async planBurn(insuredMicros: number) {
    const s = this.settings.current;
    let price: number, free: bigint;
    try { [price, free] = await Promise.all([this.cardsPrice(), this.freeCards()]); }
    catch { return { usdMicros: 0, cards: 0n }; }
    const target = burnUsdMicros(insuredMicros, Math.floor(Number(free) * price), s.burnCapBps);
    const cards = cardsForUsd(target, price, free);
    return { usdMicros: cards > 0n ? Math.min(target, Math.floor(Number(cards) * price)) : 0, cards };
  }

  /**
   * Keeps free USDC at `usdcReserveTargetUsd` by selling free $CARDS (never $CARDS promised to burns).
   * One refill at a time, as a job with a fixed amount, so a crash resumes the same sale.
   */
  async refill() {
    const s = this.settings.current;
    if (s.paused || !this.solana.canSpend || !this.solana.treasuryAddress) return null;
    let job = (await this.db.query("SELECT * FROM jobs WHERE kind='refill' AND status<>'complete' ORDER BY created_at LIMIT 1")).rows[0];
    if (!job) {
      const need = micros(s.usdcReserveTargetUsd) - await this.freeUsdc();
      if (need < MIN_REFILL_MICROS) return null;
      const [price, free] = await Promise.all([this.cardsPrice(), this.freeCards()]);
      if (!(price > 0)) return null;
      const wanted = BigInt(Math.ceil(need / price)), units = wanted < free ? wanted : free;
      if (Number(units) * price < MIN_REFILL_MICROS) return null;
      const id = `refill:${randomUUID()}`;
      await this.jobs.put(id, 'refill', 'selling', { units: units.toString(), needMicros: need });
      job = await this.jobs.get(id);
    }
    const sold = await this.solana.sellCards(`${job.id}:sell`, BigInt(job.data.units), s);
    await atomic(this.db, async () => {
      await record(this.db, { id: job.id, bucket: 'treasury', kind: 'refill', micros: sold.usdcMicros, signature: sold.signature, data: { cards: job.data.units } });
      await this.jobs.put(job.id, 'refill', 'complete', { ...job.data, usdcMicros: sold.usdcMicros, signature: sold.signature });
    });
    this.invalidate();
    return { cards: job.data.units as string, usdcMicros: sold.usdcMicros };
  }

  /** Optional service fees collect in OPS (they arrive with each payment) and move to the treasury in batches. */
  async owedToTreasury() { return (await sum(this.db, "bucket='ops' AND kind='service-fee'")) - (await sum(this.db, "bucket='transfer' AND kind='fee-transfer'")); }
  async transferFees() {
    const s = this.settings.current, to = this.solana.treasuryAddress;
    if (s.paused || !to || !this.solana.canSpend) return null;
    let job = (await this.db.query("SELECT * FROM jobs WHERE kind='fee-transfer' AND status<>'complete' ORDER BY created_at LIMIT 1")).rows[0];
    if (!job) {
      const amount = await this.owedToTreasury();
      if (amount < micros(s.feeTransferThresholdUsd)) return null;
      const id = `fee-transfer:${randomUUID()}`;
      await this.jobs.put(id, 'fee-transfer', 'started', { amount });
      job = await this.jobs.get(id);
    }
    const amount = Number(job.data.amount);
    const signature = await this.solana.pay('ops', `${job.id}:pay`, to, amount, s);
    await atomic(this.db, async () => {
      await record(this.db, { id: job.id, bucket: 'transfer', kind: 'fee-transfer', micros: amount, signature });
      await this.jobs.put(job.id, 'fee-transfer', 'complete', { ...job.data, signature });
    });
    this.invalidate();
    return { amount, signature };
  }

  /** Backoff after errors, so a stuck claim is retried calmly and logged once per distinct error. */
  private fees = { failures: 0, until: 0, lastError: '' };

  /** Read-only check run every second outside the queue: is a claim unfinished, or have enough creator fees built up? */
  async creatorFeesDue() {
    if (this.settings.current.paused || !this.solana.canSpend || Date.now() < this.fees.until) return false;
    try { return await this.solana.creatorFeesDue(this.settings.current); }
    catch (error) { await this.feeError(error); return false; }
  }

  /** Claims creator fees into the treasury as $CARDS. `checked` skips the due check the loop already made. */
  async creatorFees(checked = false) {
    if (!checked && !(await this.creatorFeesDue())) return null;
    if (this.settings.current.paused || !this.solana.canSpend) return null;
    try {
      const result = await this.solana.collectCreatorFees(this.settings.current);
      this.fees = { failures: 0, until: 0, lastError: '' };
      if (result) {
        await record(this.db, { id: result.id, bucket: 'treasury', kind: 'creator-fee', micros: result.usdcMicros, signature: result.signature, data: { cards: result.cardsUnits.toString() } });
        this.invalidate(); await audit(this.db, 'creator-fees', { ...result, cardsUnits: result.cardsUnits.toString() });
      }
      return result;
    } catch (error) {
      if (!(error instanceof PendingOperation)) await this.feeError(error);
      throw error;
    }
  }

  private async feeError(error: unknown) {
    const message = (error as Error).message, failures = this.fees.failures + 1, repeated = message === this.fees.lastError;
    // 10s, 20s, 40s … up to 10 minutes between attempts while it keeps failing.
    this.fees = { failures, until: Date.now() + Math.min(600_000, 10_000 * 2 ** Math.min(failures - 1, 6)), lastError: message };
    if (!repeated) await audit(this.db, 'creator-fees-error', { error: message, failures });
  }

  /** Runs every task, isolating failures so one stuck task cannot block the others. Fees first, then the refill. */
  async run() {
    const out: Record<string, unknown> = {};
    for (const [name, task] of [['creatorFees', () => this.creatorFees()], ['transfer', () => this.transferFees()], ['refill', () => this.refill()]] as const) {
      try { out[name] = await task(); }
      catch (error) {
        out[name] = { error: (error as Error).message };
        if (!(error instanceof PendingOperation) && name !== 'creatorFees') await audit(this.db, `treasury-${name}-error`, { error: (error as Error).message });
      }
    }
    return out;
  }

  /** Pack codes a holder can't open right now: free USDC is below the pack price (a holder's worst case). */
  async pausedForHolders(free?: number) {
    const f = free ?? await this.freeUsdc();
    return SELLING.filter(p => f < micros(p.priceUsd)).map(p => p.code);
  }

  async view(): Promise<TreasuryView> {
    const s = this.settings.current;
    const [balance, reserved, cards, queued, refilling] = await Promise.all([this.usdcBalance(), this.reserved(), this.cardsBalance(), this.queuedCards(), this.refillingCards()]);
    const price = await this.cardsPrice().catch(() => 0), free = cards - queued - refilling > 0n ? cards - queued - refilling : 0n;
    const total = (where: string) => sum(this.db, where);
    const counts = (await this.db.query<{ packs: number; holders: number }>("SELECT COUNT(*)::int AS packs, COUNT(*) FILTER (WHERE holder)::int AS holders FROM orders WHERE status='complete'")).rows[0];
    const toCards = (units: bigint) => Number(units) / CARDS_UNIT;
    return {
      live: this.solana.live, treasuryAddress: this.solana.treasuryAddress, opsAddress: this.solana.opsAddress,
      usdc: { balanceUsd: usd(balance), reservedUsd: usd(reserved), freeUsd: usd(balance - reserved), targetUsd: s.usdcReserveTargetUsd },
      cards: { balance: toCards(cards), queued: toCards(queued + refilling), free: toCards(free), priceUsd: price * CARDS_UNIT / 1e6, freeUsd: usd(Math.floor(Number(free) * price)) },
      burnCapBps: s.burnCapBps,
      pausedForHolders: s.paused ? SELLING.map(p => p.code) : await this.pausedForHolders(balance - reserved),
      totals: {
        creatorFeesUsd: usd(await total("bucket='treasury' AND kind='creator-fee'")),
        repaidUsd: usd(Math.abs(await total("bucket='treasury' AND kind='repay'"))),
        burnedUsd: usd(Math.abs(await total("bucket='burn' AND kind='burn'"))),
        packsOpened: counts.packs, holderPacks: counts.holders,
        refilledUsd: usd(await total("bucket='treasury' AND kind='refill'")),
        networkFeesUsd: usd(Math.abs(await total("bucket='treasury' AND kind='gas'"))),
      },
    };
  }
}
