import type { Quote, Settings } from './types';

/** All money is integer micro-USDC (6 decimals). */
export const MICROS = 1_000_000;
export const usd = (micros: number) => micros / MICROS;
export const micros = (dollars: number) => Math.round(dollars * MICROS);
const bps = (amount: number, rate: number) => Math.floor(amount * rate / 10_000);

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  burnCapBps: 5_000,
  holderMinTokens: 1_000_000,
  holderWindowHours: 0,
  usdcReserveTargetUsd: 1_000,
  serviceFeeBps: 0,
  cooldown: { minutes: 0, wallets: [] },
  pausedPacks: [],
  creatorFeeMinUsd: 2,
  maxPriceImpactBps: 300,
  feeTransferThresholdUsd: 5,
  gasReserveSol: 0.05,
  gas: { opsMinSol: 0.1, opsTargetSol: 0.25, treasuryMinSol: 0.15, buyUsd: 15, maxUsdPerDay: 50 },
  slippageBps: 100,
};

/** A holder's loss is repaid in full: max(0, price − insured value). Non-holders get nothing back. */
export function repayMicros(priceMicros: number, insuredMicros: number, holder: boolean) {
  if (!holder) return 0;
  return Math.max(0, priceMicros - Math.max(0, insuredMicros));
}

/** What a paid order holds back from free USDC until it settles: a holder's worst case, a card worth $0. */
export const maxRepayReservation = (priceMicros: number, holder: boolean) => holder ? priceMicros : 0;

/** USD of our coin to buy back and burn for one pull: the card's insured value, capped at X% of the free fund. */
export function burnUsdMicros(insuredMicros: number, freeFundUsdMicros: number, capBps: number) {
  const cap = bps(Math.max(0, freeFundUsdMicros), capBps);
  return Math.max(0, Math.min(Math.max(0, insuredMicros), cap));
}

/**
 * $CARDS units worth `usdMicros` at `usdcPerUnit` (USDC micros per smallest $CARDS unit), floored and never
 * more than `available`. Fixed when the pull settles, so later price moves don't change what was promised.
 */
export function cardsForUsd(usdMicros: number, usdcPerUnit: number, available: bigint) {
  if (usdMicros <= 0 || !(usdcPerUnit > 0)) return 0n;
  const units = BigInt(Math.floor(usdMicros / usdcPerUnit));
  return units < available ? units : (available > 0n ? available : 0n);
}

/** Whole coins → smallest units. */
export const tokenUnits = (whole: number, decimals: number) => BigInt(Math.round(whole * 10 ** Math.min(decimals, 6))) * 10n ** BigInt(Math.max(0, decimals - 6));
/** Smallest units → a whole-coin decimal string, trimmed: 1234500000n at 6 decimals is "1234.5". */
export function wholeTokens(units: bigint, decimals: number) {
  const negative = units < 0n, abs = negative ? -units : units, base = 10n ** BigInt(decimals);
  const whole = abs / base, fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** The holder line: the lowest balance over the window must reach the minimum. A minimum of 0 makes nobody a holder. */
export const isHolder = (lowestUnits: bigint, requiredUnits: bigint) => requiredUnits > 0n && lowestUnits >= requiredUnits;

export const serviceFeeMicros = (priceMicros: number, feeBps: number) => bps(priceMicros, feeBps);

/**
 * The price a wallet pays for one pack and whether it can open now. Holders need the treasury's free USDC
 * to cover a full repay; non-holders never wait on the treasury.
 */
export function quote(priceUsd: number, holder: boolean, settings: Settings, freeUsdcMicros: number, code: string): Quote {
  const priceMicros = micros(priceUsd), feeMicros = serviceFeeMicros(priceMicros, settings.serviceFeeBps), totalMicros = priceMicros + feeMicros;
  const maxRepayMicros = maxRepayReservation(priceMicros, holder);
  const base = { priceMicros, feeMicros, totalMicros, holder, maxRepayMicros };
  if (settings.paused) return { ...base, open: false, reason: 'Pack opening is paused right now.' };
  if (settings.pausedPacks.includes(code)) return { ...base, open: false, reason: 'This pack is paused right now.' };
  if (maxRepayMicros > 0 && freeUsdcMicros < maxRepayMicros) return { ...base, open: false, reason: 'The repay reserve is refilling from creator fees. Holder packs at this price reopen shortly.' };
  return { ...base, open: true, reason: null };
}

/** Free USDC relative to its target, as basis points clamped to [0, 10000]. */
export function reserveHealthBps(freeMicros: number, targetMicros: number) {
  if (targetMicros <= 0) return 10_000;
  return Math.max(0, Math.min(10_000, Math.floor(freeMicros * 10_000 / targetMicros)));
}
