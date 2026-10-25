import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Chain } from './chain';
import { config } from './config';
import { quote, swapInParts } from './swap';
import { micros } from '../shared/economics';
import type { Settings } from '../shared/types';

const { OnlinePumpSdk, PUMP_SDK, feeSharingConfigPda, normalizeQuoteMint } = createRequire(import.meta.url)('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');

type Claimable = { quoteMint: string; amount: bigint; creator: string; sharing: boolean; graduated: boolean };

const unfinishedCycle = async (treasury: Chain) => (await treasury.jobs.db.query("SELECT * FROM jobs WHERE kind='fee-cycle' AND status<>'complete' ORDER BY created_at LIMIT 1")).rows[0];

/** What the TREASURY wallet could claim right now, or null. Read-only, so it is safe to call every few seconds. */
async function claimable(treasury: Chain): Promise<Claimable | null> {
  const { rpc, signer } = treasury.require();
  const mint = new PublicKey(config.MEMECOIN_MINT), sdk = new OnlinePumpSdk(rpc), curve = await sdk.fetchBondingCurve(mint);
  if (curve.isHolderReward) throw new Error('This mint routes fees to holder rewards, not its creator.');
  const quoteMint = normalizeQuoteMint(curve.quoteMint), sharing = curve.creator.equals(feeSharingConfigPda(mint));
  if (!sharing && !curve.creator.equals(signer.publicKey)) throw new Error('The TREASURY wallet is not this coin’s creator-fee recipient.');
  if (sharing) {
    const info = await rpc.getAccountInfo(curve.creator); if (!info) throw new Error('Fee sharing account is missing.');
    const shared = PUMP_SDK.decodeSharingConfig(info);
    if (!shared.shareholders.some(s => s.address.equals(signer.publicKey))) throw new Error('The TREASURY wallet is not a fee-sharing shareholder of this coin.');
  }
  const balances = await sdk.getCreatorVaultQuoteBalances(curve.creator), balance = balances.find(b => b.mint.equals(quoteMint));
  if (!balance || balance.total.isZero()) return null;
  return { quoteMint: quoteMint.toBase58(), amount: BigInt(balance.total.toString()), creator: curve.creator.toBase58(), sharing, graduated: curve.complete };
}

/** USDC per smallest unit of a mint, from a Jupiter quote. Reused for 30 seconds: the due check runs every second. */
const unitPrices = new Map<string, { at: number; usdcPerUnit: number }>();

/** Roughly what `amount` of a mint is worth in USDC micros. Only decides and displays; swaps always quote afresh. */
export async function usdcValue(mint: string, amount: bigint, now = Date.now(), getQuote = quote) {
  if (mint === config.USDC_MINT) return Number(amount);
  if (amount <= 0n) return 0;
  return Math.floor(Number(amount) * await usdcPerUnit(mint, amount, now, getQuote));
}

/** USDC micros per smallest unit of `mint`, quoted on `probe` units and cached for 30 seconds. */
export async function usdcPerUnit(mint: string, probe: bigint, now = Date.now(), getQuote = quote) {
  if (mint === config.USDC_MINT) return 1;
  const cached = unitPrices.get(mint);
  if (cached && now - cached.at <= 30_000) return cached.usdcPerUnit;
  const out = Number((await getQuote(mint, config.USDC_MINT, probe)).outAmount ?? 0);
  const usdcPerUnit = probe > 0n ? out / Number(probe) : 0;
  unitPrices.set(mint, { at: now, usdcPerUnit });
  return usdcPerUnit;
}

/** True when a claim cycle is unfinished, or enough fees have built up to be worth claiming (`creatorFeeMinUsd`). */
export async function creatorFeesDue(treasury: Chain, settings: Settings) {
  if (await unfinishedCycle(treasury)) return true;
  const c = await claimable(treasury);
  if (!c) return false;
  if (settings.creatorFeeMinUsd <= 0) return true;
  return await usdcValue(c.quoteMint, c.amount) >= micros(settings.creatorFeeMinUsd);
}

/**
 * Claims our coin's pump.fun creator fees into the TREASURY wallet. They are kept as $CARDS: that is the
 * burn fund, and the repay reserve is refilled from it only when needed. A coin whose fees come in another
 * token (SOL) has them swapped into $CARDS, in parts if one swap would move the price too much.
 * Returns null when there is nothing to claim.
 */
export async function collectCreatorFees(treasury: Chain, settings: Settings) {
  const { rpc, signer } = treasury.require();
  let cycle = await unfinishedCycle(treasury);
  if (!cycle) {
    const c = await claimable(treasury);
    if (!c) return null;
    const id = `fees:${randomUUID()}`;
    await treasury.jobs.put(id, 'fee-cycle', 'claiming', { quoteMint: c.quoteMint, creator: c.creator, sharing: c.sharing, graduated: c.graduated });
    cycle = await treasury.jobs.get(id);
  }
  const d = cycle.data, quoteMint = new PublicKey(d.quoteMint), mint = new PublicKey(config.MEMECOIN_MINT), sdk = new OnlinePumpSdk(rpc);
  if (!d.claimSignature) {
    d.claimSignature = await treasury.execute(`${cycle.id}:claim`, 'fee-claim', async () => {
      const quoteTokenProgram = await sdk.fetchQuoteTokenProgram(quoteMint);
      const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 })];
      if (d.sharing) {
        const address = new PublicKey(d.creator), info = await rpc.getAccountInfo(address); if (!info) throw new Error('Sharing configuration is missing.');
        const shared = PUMP_SDK.decodeSharingConfig(info);
        if (d.graduated) ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({ payer: signer.publicKey, mint, quoteMint, quoteTokenProgram }));
        ixs.push(await PUMP_SDK.distributeCreatorFeesV2({ mint, sharingConfig: shared, sharingConfigAddress: address, quoteMint, quoteTokenProgram, payer: signer.publicKey, shouldInitializeAta: true }));
      } else {
        if (!quoteMint.equals(NATIVE_MINT)) ixs.push(createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, getAssociatedTokenAddressSync(quoteMint, signer.publicKey, false, quoteTokenProgram), signer.publicKey, quoteMint, quoteTokenProgram));
        ixs.push(...await sdk.collectCoinCreatorFeeV2Instructions(signer.publicKey, quoteMint, quoteTokenProgram, signer.publicKey));
      }
      return treasury.build(ixs);
    }, settings);
    await treasury.jobs.put(cycle.id, 'fee-cycle', 'routing', d);
  }
  if (!d.amount) { const delta = await treasury.tokenDelta(d.claimSignature, d.quoteMint); d.amount = (delta > 0n ? delta : 0n).toString(); await treasury.jobs.put(cycle.id, 'fee-cycle', 'routing', d); }
  if (BigInt(d.amount) === 0n) { await treasury.jobs.put(cycle.id, 'fee-cycle', 'complete', d); return null; }
  if (!d.cardsAmount) {
    // USDC fees go straight to the repay reserve; anything else that isn't $CARDS becomes $CARDS.
    if (d.quoteMint === config.CARDS_MINT || d.quoteMint === config.USDC_MINT) d.cardsAmount = d.quoteMint === config.CARDS_MINT ? d.amount : '0';
    else d.cardsAmount = (await swapInParts(treasury, `${cycle.id}:cards`, d.quoteMint, config.CARDS_MINT, BigInt(d.amount), settings)).received.toString();
    await treasury.jobs.put(cycle.id, 'fee-cycle', 'accounting', d);
  }
  const cardsUnits = BigInt(d.cardsAmount);
  const usdcMicros = d.quoteMint === config.USDC_MINT ? Number(d.amount) : await usdcValue(config.CARDS_MINT, cardsUnits).catch(() => 0);
  await treasury.jobs.put(cycle.id, 'fee-cycle', 'complete', { ...d, usdcMicros });
  return { id: cycle.id as string, cardsUnits, usdcMicros, signature: d.claimSignature as string };
}
