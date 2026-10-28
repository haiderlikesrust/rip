import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db';
import { DEFAULT_SETTINGS } from '../shared/economics';
import type { Settings } from '../shared/types';

const bps = z.number().int().min(0).max(10_000);
const walletAddress = z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Enter a Solana wallet address.');
/** Up to a week between packs. */
const cooldownMinutes = z.number().finite().min(0).max(7 * 24 * 60);
export const settingsSchema: z.ZodType<Settings> = z.object({
  paused: z.boolean(),
  burnCapBps: bps,
  holderMinTokens: z.number().finite().min(0).max(1e15),
  holderWindowHours: z.number().finite().min(0).max(24 * 30),
  usdcReserveTargetUsd: z.number().finite().min(0).max(10_000_000),
  serviceFeeBps: z.number().int().min(0).max(5_000),
  cooldown: z.object({ minutes: cooldownMinutes, wallets: z.array(z.object({ wallet: walletAddress, minutes: cooldownMinutes })).max(200) }),
  pausedPacks: z.array(z.string().min(1).max(40)).max(64),
  creatorFeeMinUsd: z.number().finite().min(0).max(100_000),
  maxPriceImpactBps: z.number().int().min(10).max(5_000),
  feeTransferThresholdUsd: z.number().finite().min(1).max(1_000_000),
  gasReserveSol: z.number().finite().min(0.01).max(100),
  gas: z.object({ opsMinSol: z.number().finite().min(0.02).max(100), opsTargetSol: z.number().finite().min(0.02).max(100), treasuryMinSol: z.number().finite().min(0.02).max(100), buyUsd: z.number().finite().min(1).max(1_000), maxUsdPerDay: z.number().finite().min(0).max(10_000) }),
  slippageBps: z.number().int().min(1).max(500),
}).superRefine((s, ctx) => {
  if (s.gas.opsTargetSol <= s.gas.opsMinSol) ctx.addIssue({ code: 'custom', path: ['gas', 'opsTargetSol'], message: 'OPS refill level must be above its top-up trigger.' });
  if (s.gas.opsMinSol < s.gasReserveSol) ctx.addIssue({ code: 'custom', path: ['gas', 'opsMinSol'], message: 'OPS top-up trigger must be at least the gas reserve.' });
  if (s.gas.treasuryMinSol < s.gasReserveSol) ctx.addIssue({ code: 'custom', path: ['gas', 'treasuryMinSol'], message: 'TREASURY minimum must be at least the gas reserve.' });
});

export class SettingsStore {
  current: Settings = DEFAULT_SETTINGS;
  constructor(readonly db: Database) {}
  async load() {
    const row = (await this.db.query('SELECT data FROM settings WHERE id=1')).rows[0];
    // New fields added in later versions fall back to their defaults.
    this.current = row ? settingsSchema.parse({ ...DEFAULT_SETTINGS, ...row.data, cooldown: { ...DEFAULT_SETTINGS.cooldown, ...row.data.cooldown }, gas: { ...DEFAULT_SETTINGS.gas, ...row.data.gas } }) : DEFAULT_SETTINGS;
    return this.current;
  }
  async save(settings: Settings) {
    const parsed = settingsSchema.parse(settings);
    await this.db.query('INSERT INTO settings(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [JSON.stringify(parsed)]);
    this.current = parsed;
  }
}

/** A short fingerprint of the saved settings, used to refuse saves made from a stale admin page. */
export const settingsVersion = (settings: Settings) => createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 16);
