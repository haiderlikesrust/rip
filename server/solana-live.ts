import { PublicKey, type Connection } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from './config';
import { MAX_TX_VERSION, type Chain } from './chain';
import { buildPayment, validatePaymentMessage, validateSignedPayment, type PaymentIntent } from './payment';
import { swap, swapInParts } from './swap';
import { collectCreatorFees, creatorFeesDue, usdcPerUnit } from './fees';
import type { BuiltPayment, HolderHistory, PaymentState, Solana, Wallet } from './ports';
import { readHolderHistory } from './coin-history';
import type { Settings } from '../shared/types';

/**
 * Reads a batch of parsed transactions. If the batch call fails, each one is read on its own and the
 * unreadable ones are skipped, so one odd transaction (a newer format, a pruned slot) cannot hide the rest.
 * When every single read fails too, the RPC itself is down: that error is raised, not "nothing found".
 */
export async function readParsedTransactions(rpc: Pick<Connection, 'getParsedTransactions' | 'getParsedTransaction'>, signatures: string[]) {
  const options = { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' as const };
  try { return await rpc.getParsedTransactions(signatures, options); }
  catch (error) {
    const each = await Promise.all(signatures.map(signature => rpc.getParsedTransaction(signature, options).then(tx => tx, () => undefined)));
    if (each.every(tx => tx === undefined)) throw error;
    return each.map(tx => tx ?? null);
  }
}

/** Turns a failed payment broadcast into one plain sentence; the raw RPC message is kept as `cause` for the logs. */
export function paymentFailure(message: string) {
  if (/debit an account but found no record|insufficient lamports|InsufficientFundsForFee|insufficient funds for fee/i.test(message)) return 'This wallet needs a little SOL (0.002 is plenty) to pay the Solana network fee. Nothing was charged.';
  if (/insufficient funds|0x1\b/i.test(message)) return 'This wallet does not have enough USDC for this pack. Nothing was charged.';
  if (/invalid account data|could not find account|AccountNotFound|0x3\b/i.test(message)) return 'This wallet has no USDC yet. Add USDC to it and try again. Nothing was charged.';
  if (/blockhash not found|block height exceeded|expired/i.test(message)) return 'The payment took too long to approve. Please try again. Nothing was charged.';
  return 'The payment could not be sent. Please try again. Nothing was charged.';
}

/** Mainnet adapter: OPS (pack buying) and TREASURY (dev wallet: creator fees, repays, burns) are separate signing wallets sharing one RPC. */
export class LiveSolana implements Solana {
  readonly live = config.live;
  private supplyCache: { value: bigint; at: number } | null = null;
  constructor(readonly ops: Chain, readonly treasury: Chain, readonly rpc: Connection | null) {}
  /** Read-only until mainnet is enabled with both signers and an RPC: no payment is accepted before that. */
  get canSpend() { return config.live && !!this.rpc && !!this.ops.signer && !!this.treasury.signer; }
  get opsAddress() { return this.ops.address; }
  get treasuryAddress() { return this.treasury.address; }
  get holderMint() { return config.MEMECOIN_MINT || null; }
  get holderDecimals() { return config.MEMECOIN_DECIMALS; }
  private requireRpc() { if (!this.rpc) throw new Error('Configure SOLANA_RPC_URL.'); return this.rpc; }

  async holderBalance(owner: string) {
    if (!this.rpc || !this.holderMint) return 0n;
    const accounts = await this.rpc.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(this.holderMint) }, 'confirmed');
    return accounts.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }
  async holderHistory(owner: string, sinceMs: number): Promise<HolderHistory> {
    if (!this.rpc || !this.holderMint) return { changes: [], current: 0n, firstAt: null, complete: true };
    return readHolderHistory(this.rpc, readParsedTransactions, owner, this.holderMint, sinceMs);
  }
  async holderSupply() {
    if (!this.rpc || !this.holderMint) return 0n;
    if (this.supplyCache && Date.now() - this.supplyCache.at < 600_000) return this.supplyCache.value;
    const supply = BigInt((await this.rpc.getTokenSupply(new PublicKey(this.holderMint), 'confirmed')).value.amount);
    this.supplyCache = { value: supply, at: Date.now() };
    return supply;
  }
  usdcBalance(owner: string) { return this.ops.balance(config.USDC_MINT, owner); }
  async cardsBalance() { return this.treasuryAddress && this.rpc ? this.treasury.balance(config.CARDS_MINT) : 0n; }
  /** Priced on 1,000 whole $CARDS (6 decimals), so the quote reflects real depth rather than dust. */
  cardsPrice() { return usdcPerUnit(config.CARDS_MINT, 1_000_000_000n); }

  async buildUserPayment(user: string, micros: number, memo: string): Promise<BuiltPayment> {
    if (!this.opsAddress) throw new Error('The OPS wallet is not configured.');
    const block = await this.requireRpc().getLatestBlockhash('confirmed');
    return buildPayment({ user, recipient: this.opsAddress, usdcMint: config.USDC_MINT, micros, memo }, block.blockhash);
  }

  async submitUserPayment(intent: PaymentIntent, signedBase64: string) {
    const tx = validateSignedPayment(signedBase64, intent);
    try { await this.requireRpc().sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }); }
    catch (error) {
      const message = (error as Error).message;
      // The wallet broadcast it too: the payment is on its way, not failed.
      if (/already been processed/i.test(message)) return bs58.encode(tx.signatures[0]);
      throw Object.assign(new Error(paymentFailure(message), { cause: message }), { statusCode: 400 });
    }
    return bs58.encode(tx.signatures[0]);
  }

  /** Finds a payment the wallet broadcast itself, by its unique reference key. */
  private async findByReference(intent: PaymentIntent) {
    const rpc = this.requireRpc();
    const signatures = await rpc.getSignaturesForAddress(new PublicKey(intent.reference), { limit: 25 }, 'confirmed');
    for (const s of signatures) {
      // The reference key is public once the payment lands; others' transactions mentioning it are skipped.
      if (s.err || (s.memo && !s.memo.includes(intent.memo))) continue;
      let tx;
      try { tx = await rpc.getTransaction(s.signature, { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' }); } catch { continue; }
      if (!tx?.meta || tx.meta.err) continue;
      try { validatePaymentMessage(tx.transaction.message, intent); return s.signature; } catch { /* a look-alike, not our payment */ }
    }
    return null;
  }

  async paymentStatus(payment: BuiltPayment, known: string | null): Promise<PaymentState> {
    const rpc = this.requireRpc();
    const signature = known ?? await this.findByReference(payment.intent);
    if (signature) {
      const status = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.err) return { state: 'failed', reason: JSON.stringify(status.err) };
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return { state: 'confirmed', signature };
      if (status) return { state: 'pending' };
    }
    if ((await rpc.isBlockhashValid(payment.blockhash, { commitment: 'confirmed' })).value) return { state: 'pending' };
    // The blockhash is dead, so the payment can never land. Check history once more before expiring.
    const late = signature ? await rpc.getTransaction(signature, { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' }) : null;
    if (late?.meta && !late.meta.err) return { state: 'confirmed', signature: signature! };
    if (!known && await this.findByReference(payment.intent)) return { state: 'pending' };
    return { state: 'expired' };
  }

  pay(from: Wallet, jobId: string, to: string, micros: number, settings: Settings) {
    return this.chain(from).payUsdc(jobId, to, BigInt(micros), settings);
  }
  private chain(wallet: Wallet) { return wallet === 'ops' ? this.ops : this.treasury; }
  transferNft(jobId: string, mint: string, to: string, settings: Settings) { return this.ops.transferNft(jobId, mint, to, settings); }

  async sellCards(jobId: string, units: bigint, settings: Settings) {
    const sold = await swapInParts(this.treasury, jobId, config.CARDS_MINT, config.USDC_MINT, units, settings);
    return { usdcMicros: Number(sold.received), signature: sold.signature };
  }

  /**
   * $CARDS → coin in one Jupiter swap when it routes; otherwise $CARDS → USDC → coin. The route chosen first is
   * remembered on the job, so a retry never switches halfway. Then the coin is burned (Token-2022 aware).
   */
  async buybackAndBurn(jobId: string, cardsUnits: bigint, settings: Settings) {
    if (!this.holderMint) throw new Error('Configure MEMECOIN_MINT.');
    const routeId = `${jobId}:route`, known = await this.treasury.jobs.get(routeId);
    let route: 'direct' | 'usdc' = known?.data?.route ?? 'direct';
    let bought: { received: bigint; signature: string };
    try {
      if (route === 'usdc') throw Object.assign(new Error('two-hop'), { twoHop: true });
      bought = await swapInParts(this.treasury, `${jobId}:swap`, config.CARDS_MINT, this.holderMint, cardsUnits, settings);
      if (!known) await this.treasury.jobs.put(routeId, 'burn-route', 'complete', { route });
    } catch (error) {
      const e = error as Error & { twoHop?: boolean };
      const noRoute = e.twoHop || (!known && /No supported swap route|route|COULD_NOT_FIND/i.test(e.message) && !(await this.treasury.jobs.get(`${jobId}:swap`))?.data?.parts?.length);
      if (!noRoute) throw error;
      route = 'usdc';
      if (!known) await this.treasury.jobs.put(routeId, 'burn-route', 'complete', { route });
      const usdc = await swapInParts(this.treasury, `${jobId}:usdc`, config.CARDS_MINT, config.USDC_MINT, cardsUnits, settings);
      bought = await swapInParts(this.treasury, `${jobId}:coin`, config.USDC_MINT, this.holderMint, usdc.received, settings);
    }
    const burnSignature = await this.treasury.burn(`${jobId}:burn`, this.holderMint, bought.received, settings);
    return { tokens: bought.received, swapSignature: bought.signature, burnSignature };
  }

  collectCreatorFees(settings: Settings) { return collectCreatorFees(this.treasury, settings); }
  creatorFeesDue(settings: Settings) { return creatorFeesDue(this.treasury, settings); }

  async walletFunds(owner: string) {
    const rpc = this.requireRpc(), key = new PublicKey(owner), ata = getAssociatedTokenAddressSync(new PublicKey(config.USDC_MINT), key, true);
    const [account, lamports] = await Promise.all([rpc.getParsedAccountInfo(ata, 'confirmed'), rpc.getBalance(key, 'confirmed')]);
    const parsed = (account.value?.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } } | undefined)?.parsed;
    return { usdcAccount: !!account.value, usdcMicros: BigInt(parsed?.info?.tokenAmount?.amount ?? 0), lamports: BigInt(lamports) };
  }

  async hasUsdcAccount(wallet: Wallet) {
    const owner = wallet === 'ops' ? this.opsAddress : this.treasuryAddress; if (!owner) return false;
    return !!(await this.requireRpc().getAccountInfo(getAssociatedTokenAddressSync(new PublicKey(config.USDC_MINT), new PublicKey(owner)), 'confirmed'));
  }

  createUsdcAccount(wallet: Wallet, jobId: string, settings: Settings) { return this.chain(wallet).createOwnTokenAccount(jobId, config.USDC_MINT, settings); }

  solBalance(wallet: Wallet) { return this.chain(wallet).balance(NATIVE_MINT.toBase58()); }

  sendGas(jobId: string, lamports: bigint, settings: Settings) {
    if (!this.opsAddress) throw new Error('The OPS wallet is not configured.');
    return this.treasury.sendSol(jobId, this.opsAddress, lamports, settings);
  }

  async buyGas(jobId: string, usdcMicros: number, settings: Settings) {
    const bought = await swap(this.treasury, jobId, config.USDC_MINT, NATIVE_MINT.toBase58(), BigInt(usdcMicros), settings);
    return { lamports: bought.received, signature: bought.signature };
  }
}
