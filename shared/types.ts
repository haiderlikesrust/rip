export type Settings = {
  /** Stops new orders, repays, burns and fee routing. In-flight orders still settle or refund. */
  paused: boolean;
  /** Most of the free $CARDS burn fund one pull may burn. 5000 = 50%: burn = min(insured value, X% of fund). */
  burnCapBps: number;
  /** Whole coins a wallet must hold (its lowest balance over the window) to get losses repaid. */
  holderMinTokens: number;
  /** Hours the lowest balance is measured over, from on-chain history. 0 = the balance right now. */
  holderWindowHours: number;
  /** USDC the treasury tries to keep for repays. Claimed $CARDS is sold to refill it before anything is burned. */
  usdcReserveTargetUsd: number;
  /** Optional service fee on top of the pack price, sent on to the treasury. 0 = none. */
  serviceFeeBps: number;
  /** Minutes a wallet waits between packs. `wallets` override it per wallet. 0 = no wait. */
  cooldown: { minutes: number; wallets: { wallet: string; minutes: number }[] };
  /** Pack machine codes paused by an admin. */
  pausedPacks: string[];
  /** Creator fees are claimed once at least this much (USD) has built up. 0 = any amount. */
  creatorFeeMinUsd: number;
  /** Largest price impact one swap may have; bigger sales are split into parts. 300 = 3%. */
  maxPriceImpactBps: number;
  /** OPS sends collected service fees on to the treasury once they reach this much (USD). */
  feeTransferThresholdUsd: number;
  gasReserveSol: number;
  /**
   * Keeps both wallets able to pay network fees. When OPS drops below `opsMinSol`, TREASURY sends it SOL up
   * to `opsTargetSol`. When TREASURY itself drops below `treasuryMinSol`, it buys SOL with `buyUsd` of its
   * USDC, at most `maxUsdPerDay` a day (0 = never buy).
   */
  gas: { opsMinSol: number; opsTargetSol: number; treasuryMinSol: number; buyUsd: number; maxUsdPerDay: number };
  slippageBps: number;
};

export type Card = { mint: string; name: string; image: string | null; insuredValueUsd: number | null; rarity: string | null; transferSignature: string | null };

export type Quote = {
  priceMicros: number; feeMicros: number; totalMicros: number;
  /** The wallet holds enough of the coin to have a loss repaid. */
  holder: boolean;
  /** Largest repay this pack can cost the treasury (the whole price, when the card is worth nothing). */
  maxRepayMicros: number;
  /** False when the treasury's free USDC can't cover a holder's worst case right now: holder packs pause. */
  open: boolean;
  reason: string | null;
};

export type OrderStatus = 'awaiting_payment' | 'paying' | 'paid' | 'buying' | 'delivering' | 'settling' | 'refunding' | 'complete' | 'refunded' | 'expired' | 'review';
export type BurnStatus = 'queued' | 'batched' | 'burned' | 'skipped';

export type OrderView = {
  id: string; status: OrderStatus; wallet: string; packCode: string; priceUsd: number; feeUsd: number; totalUsd: number;
  holder: boolean; card: Card | null; valueUsd: number | null; repayUsd: number | null;
  /** The buyback-and-burn this pull triggered, once its size is fixed at settlement. */
  burn: { usd: number; status: BurnStatus; signature: string | null } | null;
  paymentSignature: string | null; repaySignature: string | null; refundSignature: string | null; nftSignature: string | null; packSignature: string | null;
  message: string | null; createdAt: number;
  /** Set once the card was sold back to Collector Crypt. */
  sale: { amountUsd: number; signature: string } | null;
};

export type HolderView = {
  configured: boolean;
  holder: boolean;
  /** Whole coins, as decimal strings. */
  balance: string; lowest: string; required: string;
  windowHours: number;
  reason: string | null;
};

export type TreasuryView = {
  live: boolean; treasuryAddress: string | null; opsAddress: string | null;
  usdc: { balanceUsd: number; reservedUsd: number; freeUsd: number; targetUsd: number };
  cards: { balance: number; queued: number; free: number; priceUsd: number; freeUsd: number };
  burnCapBps: number;
  /** Pack codes holders can't open right now because free USDC is below the pack price. */
  pausedForHolders: string[];
  totals: { creatorFeesUsd: number; repaidUsd: number; burnedUsd: number; packsOpened: number; holderPacks: number; refilledUsd: number; networkFeesUsd: number };
};

export type BurnBatchView = {
  id: string; status: string; cardsIn: number; usd: number; coinBurned: string; pulls: number;
  swapSignature: string | null; burnSignature: string | null; createdAt: number; burnedAt: number | null;
};
export type BurnsView = {
  /** Whole coins burned (decimal string), its share of the original supply in basis points, and USD spent. */
  totals: { coinBurned: string; usd: number; supplyBps: number; batches: number; queuedUsd: number; queuedPulls: number };
  batches: BurnBatchView[];
};

/** A pack opened here: the card, what was repaid and burned, and the transactions behind it. Wallets are shortened. */
export type SitePull = {
  id: string; code: string; priceUsd: number; valueUsd: number; repayUsd: number; burnUsd: number; burnStatus: BurnStatus | null; holder: boolean;
  at: number; wallet: string; card: { name: string; image: string | null } | null;
  txs: { payment: string | null; pack: string | null; card: string | null; repay: string | null; burn: string | null };
};
