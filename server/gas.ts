import { randomUUID } from 'node:crypto';
import { audit, record, sum, type Database } from './db';
import { Jobs, PendingOperation } from './jobs';
import type { Solana } from './ports';
import type { Treasury } from './treasury';
import type { SettingsStore } from './settings';
import { micros, usd } from '../shared/economics';

export const lamports = (sol: number) => BigInt(Math.round(sol * 1e9));
const sol = (value: bigint) => Number(value) / 1e9;
/** Enough for an OPS transaction's fees plus rent for a buyer's new token account. */
export const OPS_MIN_TO_SIGN = lamports(0.01);
/** Smallest top-up worth a transaction. */
const MIN_TRANSFER = lamports(0.005);

/**
 * Keeps both wallets able to pay Solana network fees:
 * - OPS below `gas.opsMinSol`: TREASURY sends it SOL, up to `gas.opsTargetSol`.
 * - TREASURY below `gas.treasuryMinSol` (counting that transfer): TREASURY first buys SOL with `gas.buyUsd` of its
 *   USDC, at most `gas.maxUsdPerDay` a day. That spend is recorded in the ledger as `gas`.
 * TREASURY never sends below `gasReserveSol`, so it can always sign its own payouts.
 * Each cycle is a job with fixed amounts, so a crash resumes the same swap and transfer instead of repeating them.
 */
export class Gas {
  private ops: { lamports: bigint; at: number } | null = null;
  private opsUsdc: { ready: boolean; at: number } | null = null;
  private warnedAt = 0;
  constructor(readonly db: Database, readonly jobs: Jobs, readonly solana: Solana, readonly treasury: Treasury, readonly settings: SettingsStore) {}

  /** Whether OPS can pay for its next transactions. Cached briefly: the order loop asks every couple of seconds. */
  async opsReady() {
    if (!this.ops || Date.now() - this.ops.at > 10_000) this.ops = { lamports: await this.solana.solBalance('ops'), at: Date.now() };
    return this.ops.lamports >= OPS_MIN_TO_SIGN;
  }

  /** Whether OPS can receive buyers' USDC. Once true it stays true; while false it is rechecked every 10 seconds. */
  async opsUsdcReady() {
    if (!this.opsUsdc || (!this.opsUsdc.ready && Date.now() - this.opsUsdc.at > 10_000)) this.opsUsdc = { ready: await this.solana.hasUsdcAccount('ops'), at: Date.now() };
    return this.opsUsdc.ready;
  }

  /** Creates OPS and TREASURY's USDC token accounts if missing: a new wallet cannot receive USDC without one. */
  async accounts() {
    for (const wallet of ['ops', 'treasury'] as const) {
      if (await this.solana.hasUsdcAccount(wallet)) continue;
      try {
        const signature = await this.solana.createUsdcAccount(wallet, `usdc-account:${wallet}`, this.settings.current);
        await audit(this.db, 'usdc-account-created', { wallet, signature });
      } catch (error) { if (!(error instanceof PendingOperation)) await this.warn(`Could not create the ${wallet.toUpperCase()} USDC account: ${(error as Error).message}`); }
    }
    this.opsUsdc = null;
  }

  /** USDC the treasury spent on SOL over the last 24 hours. */
  async spentToday() { return -(await sum(this.db, "bucket='treasury' AND kind='gas' AND created_at>=$1", [Date.now() - 86_400_000])); }

  async status() {
    const [ops, treasury, spent] = await Promise.all([this.solana.solBalance('ops'), this.solana.solBalance('treasury'), this.spentToday()]);
    const [opsUsdc, treasuryUsdc] = await Promise.all([this.solana.hasUsdcAccount('ops'), this.solana.hasUsdcAccount('treasury')]);
    return { opsSol: sol(ops), treasurySol: sol(treasury), spentTodayUsd: usd(spent), opsReady: ops >= OPS_MIN_TO_SIGN, opsUsdcAccount: opsUsdc, treasuryUsdcAccount: treasuryUsdc };
  }

  async ensure() {
    if (!this.solana.canSpend) return null;
    await this.accounts();
    return this.topUp();
  }

  private async topUp() {
    const s = this.settings.current, g = s.gas;
    let cycle = (await this.db.query("SELECT * FROM jobs WHERE kind='gas-cycle' AND status<>'complete' ORDER BY created_at LIMIT 1")).rows[0];
    if (!cycle) {
      const [ops, treasury] = await Promise.all([this.solana.solBalance('ops'), this.solana.solBalance('treasury')]);
      const send = ops < lamports(g.opsMinSol) ? lamports(g.opsTargetSol) - ops : 0n;
      let buy = 0;
      if (treasury - send < lamports(g.treasuryMinSol) && g.maxUsdPerDay > 0) {
        const room = micros(g.maxUsdPerDay) - await this.spentToday();
        buy = Math.max(0, Math.min(micros(g.buyUsd), room, await this.treasury.freeUsdc()));
        if (buy < micros(1)) { buy = 0; await this.warn('TREASURY is low on SOL and the daily budget for buying more is used up.'); }
      } else if (treasury - send < lamports(g.treasuryMinSol)) await this.warn('TREASURY is low on SOL and buying SOL is turned off. Send it some SOL.');
      if (send === 0n && buy === 0) return null;
      const id = `gas:${randomUUID()}`;
      await this.jobs.put(id, 'gas-cycle', 'started', { send: send.toString(), buyMicros: buy });
      cycle = await this.jobs.get(id);
    }
    const d = cycle.data;

    if (d.buyMicros > 0 && !d.bought) {
      try {
        const bought = await this.solana.buyGas(`${cycle.id}:buy`, d.buyMicros, s);
        await record(this.db, { id: `${cycle.id}:buy`, bucket: 'treasury', kind: 'gas', micros: -d.buyMicros, signature: bought.signature, data: { lamports: bought.lamports.toString() } });
        d.bought = bought.lamports.toString(); this.treasury.invalidate();
        await this.jobs.put(cycle.id, 'gas-cycle', 'bought', d);
      } catch (error) {
        // A swap that never got signed (no route, stale quote) is safe to skip: still send what TREASURY can spare.
        if (error instanceof PendingOperation || (await this.jobs.get(`${cycle.id}:buy`))?.data?.signature) throw error;
        await audit(this.db, 'gas-buy-error', { id: cycle.id, error: (error as Error).message });
        d.buyMicros = 0; d.buyError = (error as Error).message;
        await this.jobs.put(cycle.id, 'gas-cycle', 'started', d);
      }
    }

    if (BigInt(d.send) > 0n && !d.sent) {
      // Until the transfer is signed its amount can still follow TREASURY's balance, so a shrinking balance can't wedge the cycle.
      if (d.sendLamports && !(await this.jobs.get(`${cycle.id}:send`))?.data?.signature) delete d.sendLamports;
      if (!d.sendLamports) {
        // Fix the amount before signing so a resumed cycle sends exactly the same transfer.
        const spare = (await this.solana.solBalance('treasury')) - lamports(s.gasReserveSol);
        const amount = BigInt(d.send) < spare ? BigInt(d.send) : spare;
        if (amount < MIN_TRANSFER) {
          await this.warn('OPS needs SOL for network fees but TREASURY has none to spare.');
          await this.jobs.put(cycle.id, 'gas-cycle', 'complete', { ...d, skipped: 'TREASURY had no SOL to spare' });
          return null;
        }
        d.sendLamports = amount.toString();
        await this.jobs.put(cycle.id, 'gas-cycle', 'sending', d);
      }
      d.sent = await this.solana.sendGas(`${cycle.id}:send`, BigInt(d.sendLamports), s);
      this.ops = null;
    }
    await this.jobs.put(cycle.id, 'gas-cycle', 'complete', d);
    const result = { id: cycle.id as string, boughtUsd: usd(d.buyMicros), sentSol: sol(BigInt(d.sendLamports ?? 0)) };
    await audit(this.db, 'gas-topup', result);
    return result;
  }

  /** Low-SOL warnings go to the audit log at most once an hour. */
  private async warn(message: string) {
    if (Date.now() - this.warnedAt < 3_600_000) return;
    this.warnedAt = Date.now();
    await audit(this.db, 'gas-low', { message });
  }
}
