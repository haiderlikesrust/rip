import type { HolderHistory, Solana } from './ports';
import { balanceAt } from './coin-history';
import type { SettingsStore } from './settings';
import { config } from './config';
import { isHolder, tokenUnits, wholeTokens } from '../shared/economics';
import type { HolderView } from '../shared/types';

const HOUR = 3_600_000;

export type HolderCheck = { configured: boolean; holder: boolean; balance: bigint; lowest: bigint; required: bigint; reason: string | null };

/**
 * Who counts as a holder: the wallet's *lowest* coin balance over the last `holderWindowHours`, read from
 * on-chain history, must reach `holderMinTokens`. Buying right before a pull, or moving one bag between
 * wallets, does not count until it has been held for the whole window.
 */
export class Holders {
  private histories = new Map<string, { at: number; since: number; value: Promise<HolderHistory> }>();
  constructor(readonly solana: Solana, readonly settings: SettingsStore) {}

  /** On-chain history back to `since`, cached for a minute: the packs page and the order that follows ask together. */
  private history(wallet: string, since: number, now = Date.now()) {
    const cached = this.histories.get(wallet);
    if (cached && now - cached.at < 60_000 && cached.since <= since) return cached.value;
    const value = this.solana.holderHistory(wallet, since);
    if (this.histories.size > 5_000) this.histories.delete(this.histories.keys().next().value!);
    this.histories.set(wallet, { at: now, since, value });
    value.catch(() => this.histories.delete(wallet));
    return value;
  }

  /** Drops a wallet's cached history (orders re-check fresh; practice tools change it). */
  forget(wallet: string) { this.histories.delete(wallet); }

  required() { return tokenUnits(this.settings.current.holderMinTokens, this.solana.holderDecimals); }

  /** `fresh` re-reads the chain; orders always do, the packs page may use the minute-old history. */
  async check(wallet: string, options: { fresh?: boolean } = { fresh: true }): Promise<HolderCheck> {
    const s = this.settings.current, required = this.required(), now = Date.now();
    if (!this.solana.holderMint) return { configured: false, holder: false, balance: 0n, lowest: 0n, required, reason: 'The coin is not configured yet.' };
    if (options.fresh) this.forget(wallet);
    let balance: bigint, lowest: bigint;
    if (s.holderWindowHours <= 0) { balance = await this.solana.holderBalance(wallet); lowest = balance; }
    else {
      const since = now - s.holderWindowHours * HOUR, history = await this.history(wallet, since, now);
      // A history too long to read back fully is judged on what was read, ending at the current balance.
      const start = balanceAt(history.changes, since) ?? (history.complete ? 0n : history.current);
      balance = history.current;
      lowest = [start, ...history.changes.filter(c => c.at > since).map(c => c.balance), history.current].reduce((a, b) => b < a ? b : a);
    }
    const holder = isHolder(lowest, required);
    const d = this.solana.holderDecimals, need = `${Number(wholeTokens(required, d)).toLocaleString('en-US')} $${config.COIN_SYMBOL}`;
    const reason = holder ? null
      : required <= 0n ? 'Loss repays are not switched on yet.'
      : s.holderWindowHours > 0 ? `Hold at least ${need} for ${s.holderWindowHours}h to get losses repaid. Your lowest balance in that time was ${Number(wholeTokens(lowest, d)).toLocaleString('en-US')}.`
      : `Hold at least ${need} to get losses repaid.`;
    return { configured: true, holder, balance, lowest, required, reason };
  }

  async view(wallet: string): Promise<HolderView> {
    const c = await this.check(wallet, { fresh: false }), d = this.solana.holderDecimals;
    return { configured: c.configured, holder: c.holder, balance: wholeTokens(c.balance, d), lowest: wholeTokens(c.lowest, d), required: wholeTokens(c.required, d), windowHours: this.settings.current.holderWindowHours, reason: c.reason };
  }
}
