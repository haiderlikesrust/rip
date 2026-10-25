import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config';
import { buildPayment, validateSignedPayment, type PaymentIntent } from './payment';
import { PendingOperation } from './jobs';
import type { BuiltPayment, PackMachine, PackProvider, PaymentState, PurchaseResult, Solana, Wallet } from './ports';
import type { Settings } from '../shared/types';
import { SELLING, packDef } from '../shared/packs';

const fakeSignature = () => bs58.encode(randomBytes(64));
const fakeAddress = () => Keypair.generate().publicKey.toBase58();
/** $CARDS and the coin both use 6 decimals. */
const UNIT = 1_000_000n;

/**
 * Practice-mode Solana: in-memory balances, instant confirmations, no keys or RPC.
 * Every new wallet starts as a holder so the site is usable locally; the practice drawer switches that off.
 */
export class MockSolana implements Solana {
  readonly live = false;
  canSpend = true;
  readonly opsAddress = fakeAddress();
  readonly treasuryAddress = fakeAddress();
  readonly holderMint = 'PRACTICE';
  readonly holderDecimals = 6;
  readonly initialSupply = 1_000_000_000n * UNIT;
  /** Coin burned so far, in smallest units; the supply shrinks by it. */
  burned = 0n;
  readonly usdc = new Map<string, bigint>();
  readonly holders = new Map<string, bigint>();
  /** The treasury's $CARDS, in smallest units. */
  cards = 40_000n * UNIT;
  /** Practice prices: $0.25 per $CARDS and $0.0004 per coin. */
  cardsPriceUsd = 0.25;
  coinPriceUsd = 0.0004;
  private submitted = new Map<string, { signature: string; at: number }>();
  private paid = new Map<string, string>();
  /** Number of status checks before a payment confirms; 0 makes tests deterministic. */
  confirmAfterChecks = 0;
  private checks = new Map<string, number>();
  defaultHolderPpm = 10_000;

  constructor() { this.usdc.set(this.treasuryAddress, 1_500_000_000n); }
  /** Coin balance changes per wallet, oldest first. A wallet nobody set has held the default since `defaultHeldSince`. */
  readonly holdings = new Map<string, { at: number; balance: bigint }[]>();
  defaultHeldSince = Date.now() - 30 * 86_400_000;
  private defaultBalance() { return this.initialSupply * BigInt(this.defaultHolderPpm) / 1_000_000n; }
  async holderBalance(owner: string) { return this.holders.get(owner) ?? this.defaultBalance(); }
  async holderHistory(owner: string, sinceMs: number) {
    const all = this.holdings.get(owner) ?? [{ at: this.defaultHeldSince, balance: this.defaultBalance() }];
    const prior = all.filter(c => c.at < sinceMs).at(-1);
    return { changes: [...(prior ? [prior] : []), ...all.filter(c => c.at >= sinceMs)], current: await this.holderBalance(owner), firstAt: all.find(c => c.balance > 0n)?.at ?? null, complete: true };
  }
  async holderSupply() { return this.initialSupply - this.burned; }
  async usdcBalance(owner: string) { return this.usdc.get(owner) ?? 0n; }
  async cardsBalance() { return this.cards; }
  /** USDC micros per smallest $CARDS unit: both have 6 decimals, so it is just the dollar price. */
  async cardsPrice() { return this.cardsPriceUsd; }
  /** Sets a wallet's balance as of `at` (now by default), as if it bought or sold then. */
  setHolderPpm(owner: string, ppm: number, at = Date.now()) {
    const balance = this.initialSupply * BigInt(ppm) / 1_000_000n;
    const list = this.holdings.get(owner) ?? (this.holders.has(owner) ? [] : [{ at: this.defaultHeldSince, balance: this.defaultBalance() }]);
    this.holdings.set(owner, [...list.filter(c => c.at < at), { at, balance }].sort((a, b) => a.at - b.at));
    this.holders.set(owner, this.holdings.get(owner)!.at(-1)!.balance);
  }
  private move(from: string | null, to: string, amount: bigint) {
    if (from) { const balance = this.usdc.get(from) ?? 0n; if (balance < amount) throw new PendingOperation('Waiting for USDC to cover this payout.'); this.usdc.set(from, balance - amount); }
    this.usdc.set(to, (this.usdc.get(to) ?? 0n) + amount);
  }
  private address(wallet: Wallet) { return wallet === 'ops' ? this.opsAddress : this.treasuryAddress; }

  private built = new Map<string, number>();
  /** Unsigned payments expire like a real blockhash would. */
  paymentLifetimeMs = 120_000;
  async buildUserPayment(user: string, micros: number, memo: string): Promise<BuiltPayment> {
    const payment = buildPayment({ user, recipient: this.opsAddress, usdcMint: config.USDC_MINT, micros, memo }, fakeAddress());
    this.built.set(payment.intent.reference, Date.now());
    return payment;
  }
  /** Accepts a real wallet signature, or the literal `practice` in practice mode. */
  async submitUserPayment(intent: PaymentIntent, signedBase64: string) {
    const signature = signedBase64 === 'practice' ? fakeSignature() : bs58.encode(validateSignedPayment(signedBase64, intent).signatures[0]);
    this.submitted.set(intent.reference, { signature, at: Date.now() });
    return signature;
  }
  async paymentStatus(payment: BuiltPayment, known: string | null): Promise<PaymentState> {
    const sent = this.submitted.get(payment.intent.reference);
    if (!sent || (known && known !== sent.signature)) return Date.now() - (this.built.get(payment.intent.reference) ?? 0) > this.paymentLifetimeMs ? { state: 'expired' } : { state: 'pending' };
    const n = (this.checks.get(sent.signature) ?? 0) + 1; this.checks.set(sent.signature, n);
    if (n <= this.confirmAfterChecks) return { state: 'pending' };
    if (!this.paid.has(sent.signature)) { this.paid.set(sent.signature, payment.intent.user); this.move(null, this.opsAddress, BigInt(payment.intent.micros)); }
    return { state: 'confirmed', signature: sent.signature };
  }

  private done = new Map<string, string>();
  async pay(from: Wallet, jobId: string, to: string, micros: number, _settings: Settings) {
    const existing = this.done.get(jobId); if (existing) return existing;
    this.move(this.address(from), to, BigInt(micros));
    const signature = fakeSignature(); this.done.set(jobId, signature); return signature;
  }
  async transferNft(jobId: string) { const existing = this.done.get(jobId); if (existing) return existing; const s = fakeSignature(); this.done.set(jobId, s); return s; }

  private sales = new Map<string, { usdcMicros: number; signature: string }>();
  async sellCards(jobId: string, units: bigint) {
    const existing = this.sales.get(jobId); if (existing) return existing;
    if (this.cards < units) throw new PendingOperation('Waiting for $CARDS to cover this sale.');
    const usdcMicros = Math.floor(Number(units) * this.cardsPriceUsd);
    this.cards -= units; this.move(null, this.treasuryAddress, BigInt(usdcMicros));
    const result = { usdcMicros, signature: fakeSignature() }; this.sales.set(jobId, result); return result;
  }
  private burns = new Map<string, { tokens: bigint; swapSignature: string; burnSignature: string }>();
  /** Tests can make the next burns fail like a swap outage. */
  burnFailures = 0;
  async buybackAndBurn(jobId: string, cardsUnits: bigint) {
    const existing = this.burns.get(jobId); if (existing) return existing;
    if (this.burnFailures > 0) { this.burnFailures--; throw new Error('No supported swap route.'); }
    if (this.cards < cardsUnits) throw new PendingOperation('Waiting for $CARDS to cover this burn.');
    const usd = Number(cardsUnits) / Number(UNIT) * this.cardsPriceUsd;
    const tokens = BigInt(Math.floor(usd / this.coinPriceUsd)) * UNIT;
    this.cards -= cardsUnits; this.burned += tokens;
    const result = { tokens, swapSignature: fakeSignature(), burnSignature: fakeSignature() }; this.burns.set(jobId, result); return result;
  }
  /** Tests and the practice drawer queue creator-fee claims (or errors). */
  readonly feeResults: ({ id: string; cardsUnits: bigint; usdcMicros: number; signature: string } | Error)[] = [];
  async collectCreatorFees() {
    const next = this.feeResults.shift(); if (next instanceof Error) throw next;
    if (next) this.cards += next.cardsUnits;
    return next ?? null;
  }
  async creatorFeesDue() { return this.feeResults.length > 0; }
  /** Practice helper: creator fees worth `usd` have built up in $CARDS. */
  queueCreatorFees(usd: number) {
    const cardsUnits = BigInt(Math.floor(usd / this.cardsPriceUsd * 1e6));
    this.feeResults.push({ id: `fees:${randomUUID()}`, cardsUnits, usdcMicros: Math.round(usd * 1e6), signature: fakeSignature() });
  }
  /** Practice helper: sets the treasury's USDC, e.g. to see holder packs pause when it runs low. */
  setTreasuryUsdc(micros: number) { this.usdc.set(this.treasuryAddress, BigInt(Math.max(0, Math.round(micros)))); }

  /** Practice buyers have plenty unless a test sets their funds. */
  readonly funds = new Map<string, { usdcAccount: boolean; usdcMicros: bigint; lamports: bigint }>();
  async walletFunds(owner: string) { return this.funds.get(owner) ?? { usdcAccount: true, usdcMicros: 1_000_000_000_000n, lamports: 1_000_000_000n }; }
  readonly usdcAccounts = new Set<Wallet>(['ops', 'treasury']);
  async hasUsdcAccount(wallet: Wallet) { return this.usdcAccounts.has(wallet); }
  async createUsdcAccount(wallet: Wallet) { this.usdcAccounts.add(wallet); return fakeSignature(); }

  /** Lamports per wallet. Both start with 1 SOL. */
  readonly sol = new Map<Wallet, bigint>([['ops', 1_000_000_000n], ['treasury', 1_000_000_000n]]);
  /** Practice SOL price, used when the treasury buys SOL for fees. */
  solPriceUsd = 150;
  private gasDone = new Map<string, { lamports: bigint; signature: string }>();
  async solBalance(wallet: Wallet) { return this.sol.get(wallet) ?? 0n; }
  async sendGas(jobId: string, lamports: bigint) {
    const existing = this.gasDone.get(jobId); if (existing) return existing.signature;
    const treasury = this.sol.get('treasury') ?? 0n;
    if (treasury < lamports) throw new PendingOperation('The TREASURY wallet is waiting for SOL to cover this transfer.');
    this.sol.set('treasury', treasury - lamports); this.sol.set('ops', (this.sol.get('ops') ?? 0n) + lamports);
    const result = { lamports, signature: fakeSignature() }; this.gasDone.set(jobId, result); return result.signature;
  }
  async buyGas(jobId: string, usdcMicros: number) {
    const existing = this.gasDone.get(jobId); if (existing) return existing;
    this.move(this.treasuryAddress, fakeAddress(), BigInt(usdcMicros));
    const lamports = BigInt(Math.floor(usdcMicros * 1_000 / this.solPriceUsd));
    this.sol.set('treasury', (this.sol.get('treasury') ?? 0n) + lamports);
    const result = { lamports, signature: fakeSignature() }; this.gasDone.set(jobId, result); return result;
  }
}

const NAMES = ['Charizard', 'Pikachu', 'Umbreon', 'Mewtwo', 'Gengar', 'Rayquaza', 'Lugia', 'Eevee', 'Blastoise', 'Snorlax', 'Gyarados', 'Dragonite', 'Mew', 'Sylveon', 'Greninja', 'Lucario'];
const WATCHES = ['Submariner', 'Speedmaster', 'Black Bay', 'Santos', 'Carrera', 'Navitimer', 'Royal Oak', 'Nautilus'];
const MAKERS = ['Rolex', 'Omega', 'Tudor', 'Cartier', 'TAG Heuer', 'Breitling', 'Audemars Piguet', 'Patek Philippe'];
const SETS = ['Base Set', 'Evolving Skies', 'Hidden Fates', 'Crown Zenith', '151', 'Paldean Fates', 'Lost Origin', 'Celebrations'];

/** Deterministic pseudo-random numbers from a seed string. */
function seeded(seed: string) {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ((state >>> 0) % 1_000_000) / 1_000_000; };
}

/** Value relative to price: mostly losses, some near-misses, a few big hits. Mean is about 1.0. */
export function mockValueRatio(rand: () => number) {
  const u = rand();
  if (u < 0.6) return 0.35 + 0.55 * rand();
  if (u < 0.88) return 0.9 + 0.5 * rand();
  return 1.4 + 3.6 * rand() ** 2;
}

/** Practice-mode Collector Crypt: instant packs with a realistic loss distribution. */
export class MockPacks implements PackProvider {
  private purchases = new Map<string, { calls: number; result?: PurchaseResult }>();
  private records = new Map<string, any>();
  /** Calls to `buy` that return pending before the card arrives. */
  pendingCalls = 1;
  /** Calls to `buy` that fail like a network outage before Collector Crypt answers again. */
  outageCalls = 0;
  /** Calls to `buy` whose pack payment provably never landed (expired or failed on-chain). */
  unpaidFailures = 0;
  soldOut = new Set<number>();
  /** Machine codes Collector Crypt is refusing to sell from ("Machine is low"). */
  machineLow = new Set<string>();
  /** The next card arrives before Collector Crypt has recorded its insured value. */
  valueLater = false;
  /** Cards sold back, by mint. */
  readonly sold = new Set<string>();
  /** Real card photos (name and image) to dress practice pulls with; empty keeps the drawn fallback. */
  realCards: () => { name: string; image: string }[] = () => [];
  constructor(readonly ops: () => string) {}

  async machines(): Promise<PackMachine[]> { return SELLING.filter(p => !this.soldOut.has(p.priceUsd)).map(p => ({ priceUsd: p.priceUsd, code: p.code })); }

  async buy(purchaseId: string, code: string, priceUsd: number): Promise<PurchaseResult> {
    const entry = this.purchases.get(purchaseId) ?? { calls: 0 };
    this.purchases.set(purchaseId, entry);
    if (entry.result) return entry.result;
    if (this.outageCalls > 0) { this.outageCalls--; throw new TypeError('fetch failed'); }
    if (this.unpaidFailures > 0) { this.unpaidFailures--; throw new Error('Pack payment expired before landing; no USDC moved.'); }
    if (this.soldOut.has(priceUsd)) throw new Error('That pack is not in the public catalog.');
    if (this.machineLow.has(code) && !entry.calls) throw new Error('That pack is not available right now (Collector Crypt: Machine is low).');
    if (entry.calls++ < this.pendingCalls) return { state: 'pending', message: 'Payment submitted. Resume this order to check confirmation.' };
    const memo = `cc-${randomUUID()}`, signature = fakeSignature();
    const card = this.card(purchaseId, priceUsd, code);
    entry.result = { state: 'complete', memo, signature, card: this.valueLater ? { ...card, insuredValueUsd: null } : card };
    this.valueLater = false;
    this.records.set(memo, { pack: { status: 'confirmed', wallet: this.ops(), pack_type: code, transaction_signature: signature, refunded: false }, send: { status: 'confirmed', nft_address: card.mint, to_wallet: this.ops(), insured_value: card.insuredValueUsd } });
    return entry.result;
  }

  card(seed: string, priceUsd: number, code = `pokemon_${priceUsd}`) {
    const rand = seeded(seed), value = Math.round(priceUsd * mockValueRatio(rand) * 100) / 100;
    const watch = packDef(code)?.kind === 'watch', pick = (list: string[]) => list[Math.floor(rand() * list.length)];
    const name = watch ? pick(WATCHES) : pick(NAMES), set = watch ? pick(MAKERS) : pick(SETS), grade = watch ? 'Box & papers' : `PSA ${7 + Math.floor(rand() * 4)}`;
    const real = watch ? [] : this.realCards(), photo = real.length ? real[Math.floor(rand() * real.length)] : null;
    return { mint: new PublicKey(createHash('sha256').update(`mint:${seed}`).digest()).toBase58(), name: photo?.name ?? `${name} · ${set} · ${grade}`, image: photo?.image ?? null, insuredValueUsd: value, rarity: value >= priceUsd * 1.4 ? 'Epic' : value >= priceUsd ? 'Rare' : 'Common', transferSignature: null };
  }

  setRecord(memo: string, record: any) { this.records.set(memo, record); }
  /** Practice sell-back: 85% of the insured value, like Collector Crypt's lower machines. */
  async buybackQuote(mint: string) {
    const record = [...this.records.values()].find(r => r.send?.nft_address === mint);
    if (!record || this.sold.has(mint)) return { available: false, amountMicros: null, expiresAt: null };
    return { available: true, amountMicros: Math.round(Number(record.send.insured_value) * 0.85 * 1e6), expiresAt: Date.now() + 72 * 3_600_000 };
  }
  async buyback(_owner: string, mint: string) {
    const quote = await this.buybackQuote(mint); if (!quote.available) throw new Error('This card can no longer be sold back.');
    return { transaction: `practice-sale:${mint}`, amountMicros: quote.amountMicros! };
  }
  async submitBuyback(signed: string) { const mint = signed.startsWith('practice-sale:') ? signed.slice(14) : ''; if (mint) this.sold.add(mint); return fakeSignature(); }
  async status(memo: string) { return this.records.get(memo) ?? { pack: null, send: null }; }
  async asset(mint: string) {
    for (const r of this.records.values()) if (r.send?.nft_address === mint) return { name: `Card ${mint.slice(0, 4)}`, image: null };
    return null;
  }
}
