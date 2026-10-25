import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createBurnCheckedInstruction, getMint } from '@solana/spl-token';
import bs58 from 'bs58';
import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { config } from './config';
import { Jobs, PendingOperation, ReviewRequired } from './jobs';
import type { Settings } from '../shared/types';

export const CORE_PROGRAM = MPL_CORE_PROGRAM_ID;
/** Newest transaction format we read from chain history. Wallets and apps now send version 1; asking for less makes the RPC refuse. */
export const MAX_TX_VERSION = 1;
export type TxPolicy = { kind: 'swap' | 'internal'; inputMint?: string; maxInput?: bigint; minInput?: bigint; outputMint?: string; minOutput?: bigint; allowedPrograms?: string[] };

export function connection(url = config.SOLANA_RPC_URL) {
  return url ? new Connection(url, { commitment: 'confirmed', confirmTransactionInitialTimeout: 20_000, disableRetryOnRateLimit: true, fetch: (u, init) => fetch(u, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal as AbortSignal] : []), AbortSignal.timeout(8000)]) }) }) : null;
}

/**
 * One signing wallet. Every transaction is persisted in `jobs` before broadcast and
 * reconciled against chain history, so a crash or retry never pays twice.
 * Adapted from grailshot/server/chain.ts.
 */
export class Chain {
  constructor(readonly jobs: Jobs, readonly signer: Keypair | null, readonly connection: Connection | null, readonly label: string) {}
  get address() { return this.signer?.publicKey.toBase58() ?? null; }
  require() { if (!config.live || !this.connection || !this.signer) throw new Error(`Mainnet signing is disabled or the ${this.label} wallet is not configured.`); return { rpc: this.connection, signer: this.signer }; }

  async balance(mint: string, owner = this.address!) {
    if (!this.connection || !owner) return 0n;
    if (mint === NATIVE_MINT.toBase58()) return BigInt(await this.connection.getBalance(new PublicKey(owner), 'confirmed'));
    const accounts = await this.connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed');
    return accounts.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  async build(instructions: TransactionInstruction[]) {
    const { rpc, signer } = this.require();
    const block = await rpc.getLatestBlockhash('confirmed');
    return new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: block.blockhash, instructions }).compileToV0Message());
  }

  /** Simulates an externally built transaction (a Jupiter swap) and checks every balance and authority it touches. */
  async validateExternal(tx: VersionedTransaction, policy: TxPolicy, settings: Settings) {
    const { rpc, signer } = this.require();
    const lookups = await Promise.all(tx.message.addressTableLookups.map(async l => { const table = await rpc.getAddressLookupTable(l.accountKey); if (!table.value) throw new Error('Missing transaction address table.'); return table.value; }));
    const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: lookups });
    if (!message.payerKey.equals(signer.publicKey)) throw new Error(`Transaction fee payer does not match the ${this.label} wallet.`);
    const programs = new Set(policy.allowedPrograms ?? []);
    for (const ix of message.instructions) {
      const program = ix.programId.toBase58();
      if (programs.size && !programs.has(program)) throw new ReviewRequired(`Unexpected transaction program ${program}`);
      if ([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(program) && ![3, 9, 12, 17].includes(ix.data[0])) throw new ReviewRequired('Unexpected token authority operation.');
    }
    const groups = await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(programId => rpc.getTokenAccountsByOwner(signer.publicKey, { programId })));
    const owned = groups.flatMap(g => g.value); const addresses = [signer.publicKey, ...owned.map(a => a.pubkey)];
    for (const mint of [policy.inputMint, policy.outputMint].filter(Boolean) as string[]) {
      if (mint === NATIVE_MINT.toBase58()) continue;
      const info = await rpc.getAccountInfo(new PublicKey(mint)); if (!info) throw new Error('Token mint not found.');
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), signer.publicKey, false, info.owner);
      if (!addresses.some(a => a.equals(ata))) addresses.push(ata);
    }
    if (addresses.length > 90) throw new ReviewRequired('Use a dedicated wallet with fewer than 90 token accounts.');
    const before = await rpc.getMultipleAccountsInfo(addresses, 'confirmed');
    const simulation = await rpc.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: addresses.map(a => a.toBase58()) }, commitment: 'confirmed' });
    if (simulation.value.err) throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
    const after = simulation.value.accounts; if (!after || after.length !== addresses.length) throw new Error('Missing simulation account results.');
    // The wallet itself must stay a plain System-owned account: an `assign` would hand it to another program.
    if (after[0] && (after[0].owner !== SystemProgram.programId.toBase58() || after[0].data?.[0])) throw new ReviewRequired('Transaction would change who controls the wallet.');
    const deltas = new Map<string, bigint>();
    for (let i = 1; i < addresses.length; i++) {
      const old = before[i]?.data, newBytes = after[i]?.data?.[0] ? Buffer.from(after[i]!.data[0], 'base64') : null;
      const a = old && old.length >= 165 ? AccountLayout.decode(old) : null, b = newBytes && newBytes.length >= 165 ? AccountLayout.decode(newBytes) : null;
      if (a && b && !a.mint.equals(b.mint)) throw new ReviewRequired('Wallet token mint changed.');
      if (before[i] && after[i] && before[i]!.owner.toBase58() !== after[i]!.owner) throw new ReviewRequired('Wallet token program changed.');
      if (b && (!b.owner.equals(signer.publicKey) || b.delegateOption !== a?.delegateOption && b.delegateOption !== 0 || b.closeAuthorityOption !== a?.closeAuthorityOption && b.closeAuthorityOption !== 0)) throw new ReviewRequired('Wallet ownership or authority changed.');
      if (a && b && (a.delegateOption !== b.delegateOption || !a.delegate.equals(b.delegate) || a.closeAuthorityOption !== b.closeAuthorityOption || !a.closeAuthority.equals(b.closeAuthority))) throw new ReviewRequired('Wallet token authority changed.');
      const mint = (a?.mint ?? b?.mint)?.toBase58(); if (mint) deltas.set(mint, (deltas.get(mint) ?? 0n) + (b?.amount ?? 0n) - (a?.amount ?? 0n));
    }
    const solDelta = BigInt(after[0]?.lamports ?? 0) - BigInt(before[0]?.lamports ?? 0); const maxNative = policy.inputMint === NATIVE_MINT.toBase58() ? (policy.maxInput ?? 0n) : 0n;
    if (solDelta < -(maxNative + 20_000_000n) || BigInt(after[0]?.lamports ?? 0) < BigInt(Math.round(settings.gasReserveSol * 1e9))) throw new ReviewRequired('Transaction exceeds gas allowance or wallet reserve.');
    for (const [mint, delta] of deltas) if (delta < 0n && (mint !== policy.inputMint || -delta > (policy.maxInput ?? 0n))) throw new ReviewRequired('Unexpected wallet token debit.');
    if (policy.inputMint && policy.inputMint !== NATIVE_MINT.toBase58() && -(deltas.get(policy.inputMint) ?? 0n) < (policy.minInput ?? 0n)) throw new ReviewRequired('Swap input does not match.');
    if (policy.outputMint === NATIVE_MINT.toBase58()) {
      // Native SOL lands in the wallet itself (or a wSOL account), net of this transaction's fees: allow 0.002 SOL for them.
      if (solDelta + (deltas.get(policy.outputMint) ?? 0n) + 2_000_000n < (policy.minOutput ?? 0n)) throw new ReviewRequired('Swap output is below the minimum.');
    } else if (policy.outputMint && (deltas.get(policy.outputMint) ?? 0n) < (policy.minOutput ?? 0n)) throw new ReviewRequired('Swap output is below the minimum.');
  }

  async execute(id: string, kind: string, build: () => Promise<VersionedTransaction>, settings: Settings, policy: TxPolicy = { kind: 'internal' }) {
    const { rpc, signer } = this.require(); let job = await this.jobs.get(id);
    if (job?.status === 'confirmed') return job.data.signature as string;
    if (job?.status === 'failed') {
      if (!job.data.automaticRetry || !job.data.signature) throw new ReviewRequired(job.error || 'Transaction needs review.');
      if (Date.now() - Number(job.updated_at) < 30_000) throw new PendingOperation('Retrying the failed transaction after reconciliation.');
      await this.recover(id); job = await this.jobs.get(id);
      if (job.status === 'confirmed') return job.data.signature as string;
      if (job.status !== 'retryable') throw new PendingOperation('Waiting for the previous transaction to settle.');
    }
    if (!job?.data.raw) {
      // A transaction that keeps failing the same way must reach a human, not loop forever.
      if ((job?.data.attempts?.length ?? 0) >= 3) throw new ReviewRequired(`This ${kind} failed 3 times: ${job?.data.attempts?.at(-1)?.error ?? 'unknown error'}`);
      const tx = await build(); if (policy.kind !== 'internal') await this.validateExternal(tx, policy, settings);
      tx.sign([signer]); const signature = bs58.encode(tx.signatures[0]);
      const data = { ...(job?.data ?? {}), raw: Buffer.from(tx.serialize()).toString('base64'), signature, blockhash: tx.message.recentBlockhash };
      // Persist the exact signed bytes before any broadcast; retries reuse this signature.
      await this.jobs.put(id, kind, 'prepared', data); job = await this.jobs.get(id);
    }
    const data = job.data; const status = (await rpc.getSignatureStatuses([data.signature], { searchTransactionHistory: true })).value[0];
    if (status?.err) { if (!['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) throw new PendingOperation('Waiting for the failed transaction to reach confirmation.'); await this.jobs.put(id, kind, 'failed', { ...data, automaticRetry: true }, JSON.stringify(status.err)); throw new PendingOperation('Transaction failed on-chain; automatic recovery is scheduled.'); }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') { await this.jobs.put(id, kind, 'confirmed', data); return data.signature as string; }
    const valid = await rpc.isBlockhashValid(data.blockhash, { commitment: 'confirmed' });
    if (!valid.value && !status) {
      const landed = await rpc.getTransaction(data.signature, { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' });
      if (landed?.meta && !landed.meta.err) { await this.jobs.put(id, kind, 'confirmed', data); return data.signature as string; }
      if (landed && !landed.meta) throw new PendingOperation('Waiting for complete transaction history.');
      await this.jobs.put(id, kind, 'failed', { ...data, automaticRetry: true }, 'Blockhash expired; chain history has no successful transaction.');
      throw new PendingOperation('Transaction expired; automatic recovery is scheduled.');
    }
    if (!status) await rpc.sendRawTransaction(Buffer.from(data.raw, 'base64'), { skipPreflight: false, maxRetries: 2 });
    await this.jobs.put(id, kind, 'submitted', data); throw new PendingOperation('Waiting for transaction confirmation.');
  }

  async recover(id: string) {
    const job = await this.jobs.get(id); if (!job) throw new Error('Job not found.');
    if (job.data.signature) {
      const { rpc } = this.require(); const status = (await rpc.getSignatureStatuses([job.data.signature], { searchTransactionHistory: true })).value[0];
      if (status?.err && !['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) throw new PendingOperation('Waiting for the failed transaction to reach confirmation.');
      if (status && !status.err) { if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') await this.jobs.put(id, job.kind, 'confirmed', job.data); return; }
      if (!status && (await rpc.isBlockhashValid(job.data.blockhash, { commitment: 'confirmed' })).value) throw new PendingOperation('Transaction is still valid; reconciliation must finish first.');
      const landed = await rpc.getTransaction(job.data.signature, { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' });
      if (landed && !landed.meta) throw new PendingOperation('Waiting for complete transaction history.');
      if (landed?.meta && !landed.meta.err) { await this.jobs.put(id, job.kind, 'confirmed', job.data); return; }
    }
    await this.jobs.put(id, job.kind, 'retryable', { attempts: [...(job.data.attempts ?? []), { signature: job.data.signature, error: job.error }], ...Object.fromEntries(Object.entries(job.data).filter(([key]) => !['raw', 'signature', 'blockhash', 'attempts', 'automaticRetry'].includes(key))) });
  }

  /** Change in this wallet's balance of `mint` caused by a confirmed transaction. */
  async tokenDelta(signature: string, mint: string): Promise<bigint> {
    const { rpc, signer } = this.require(); const tx = await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: MAX_TX_VERSION });
    if (!tx || !tx.meta) throw new PendingOperation('Waiting for transaction accounting.'); if (tx.meta.err) throw new ReviewRequired('Transaction failed.');
    if (mint === NATIVE_MINT.toBase58()) { const index = tx.transaction.message.staticAccountKeys.findIndex(k => k.equals(signer.publicKey)); if (index < 0) return 0n; return BigInt(tx.meta.postBalances[index] - tx.meta.preBalances[index] + (index === 0 ? tx.meta.fee : 0)); }
    const total = (rows: any[]): bigint => rows.filter(a => a.owner === this.address && a.mint === mint).reduce((s, a) => s + BigInt(a.uiTokenAmount.amount), 0n);
    return total(tx.meta.postTokenBalances ?? []) - total(tx.meta.preTokenBalances ?? []);
  }

  /** Idempotent USDC payout: creates the recipient's ATA if needed, then a checked transfer. */
  async payUsdc(id: string, to: string, amount: bigint, settings: Settings) {
    if (amount <= 0n) throw new Error('Payout amount must be positive.');
    return this.execute(id, 'usdc-payout', async () => {
      const { signer } = this.require(); const mint = new PublicKey(config.USDC_MINT), recipient = new PublicKey(to);
      const source = getAssociatedTokenAddressSync(mint, signer.publicKey), destination = getAssociatedTokenAddressSync(mint, recipient, true);
      if (await this.balance(config.USDC_MINT) < amount) throw new PendingOperation(`The ${this.label} wallet is waiting for USDC to cover this payout.`);
      return this.build([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
        createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, destination, recipient, mint),
        createTransferCheckedInstruction(source, mint, destination, signer.publicKey, amount, 6),
      ]);
    }, settings);
  }

  /** Creates this wallet's own token account for `mint` (no-op on chain if it already exists). */
  async createOwnTokenAccount(id: string, mint: string, settings: Settings) {
    return this.execute(id, 'token-account', async () => {
      const { signer } = this.require(), m = new PublicKey(mint);
      return this.build([ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }), createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, getAssociatedTokenAddressSync(m, signer.publicKey), signer.publicKey, m)]);
    }, settings);
  }

  /** Idempotent native SOL transfer (network-fee top-ups between our own wallets). */
  async sendSol(id: string, to: string, lamports: bigint, settings: Settings) {
    if (lamports <= 0n) throw new Error('Transfer amount must be positive.');
    return this.execute(id, 'sol-transfer', async () => {
      const { signer } = this.require();
      if (await this.balance(NATIVE_MINT.toBase58()) < lamports + BigInt(Math.round(settings.gasReserveSol * 1e9))) throw new PendingOperation(`The ${this.label} wallet is waiting for SOL to cover this transfer.`);
      return this.build([ComputeBudgetProgram.setComputeUnitLimit({ units: 5_000 }), SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(to), lamports })]);
    }, settings);
  }

  /** Burns tokens held by this wallet. Works for both SPL Token and Token-2022 mints. */
  async burn(id: string, mintAddress: string, amount: bigint, settings: Settings) {
    if (amount <= 0n) throw new Error('Burn amount must be positive.');
    return this.execute(id, 'burn', async () => {
      const { rpc, signer } = this.require(); const mint = new PublicKey(mintAddress);
      const info = await rpc.getAccountInfo(mint); if (!info) throw new Error('Token mint not found.');
      const programId = info.owner; if (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID)) throw new ReviewRequired('Token mint uses an unknown token program.');
      const decimals = (await getMint(rpc, mint, 'confirmed', programId)).decimals;
      const account = getAssociatedTokenAddressSync(mint, signer.publicKey, false, programId);
      return this.build([ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), createBurnCheckedInstruction(account, mint, signer.publicKey, amount, decimals, [], programId)]);
    }, settings);
  }

  async ownsNft(mint: string, wallet = this.address!) {
    const { rpc } = this.require(); const account = await rpc.getAccountInfo(new PublicKey(mint)); if (!account) return false;
    if (account.owner.toBase58() === CORE_PROGRAM) { const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults'); const { fetchAsset } = await import('@metaplex-foundation/mpl-core'); const asset = await fetchAsset(createUmi(config.SOLANA_RPC_URL), mint); return asset.owner === wallet; }
    return (await this.balance(mint, wallet)) === 1n;
  }

  async transferNft(id: string, mint: string, recipient: string, settings: Settings) {
    return this.execute(id, 'nft-transfer', async () => {
      // Collector Crypt may report the send before our RPC sees it: retry (with backoff) rather than review.
      if (!await this.ownsNft(mint)) throw new Error(`Waiting for the card to arrive in the ${this.label} wallet.`);
      const { signer, rpc } = this.require(); const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults'); const { keypairIdentity, publicKey } = await import('@metaplex-foundation/umi'); const umi = createUmi(config.SOLANA_RPC_URL); umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(signer.secretKey)));
      const info = await rpc.getAccountInfo(new PublicKey(mint)); let builder;
      if (info?.owner.toBase58() === CORE_PROGRAM) { const core = await import('@metaplex-foundation/mpl-core'); umi.use(core.mplCore()); const asset = await core.fetchAsset(umi, mint), collectionKey = core.collectionAddress(asset), collection = collectionKey ? await core.fetchCollection(umi, collectionKey) : undefined; builder = core.transfer(umi, { asset, collection, newOwner: publicKey(recipient) }); }
      else { const mpl = await import('@metaplex-foundation/mpl-token-metadata'); umi.use(mpl.mplTokenMetadata()); const asset = await mpl.fetchDigitalAsset(umi, publicKey(mint)); const tokenStandard = asset.metadata.tokenStandard.__option === 'Some' ? asset.metadata.tokenStandard.value : mpl.TokenStandard.NonFungible; const rules = asset.metadata.programmableConfig.__option === 'Some' && asset.metadata.programmableConfig.value.ruleSet.__option === 'Some' ? asset.metadata.programmableConfig.value.ruleSet.value : undefined; builder = mpl.transferV1(umi, { mint: publicKey(mint), tokenOwner: umi.identity.publicKey, destinationOwner: publicKey(recipient), tokenStandard, authorizationRules: rules, amount: 1 }); }
      const instructions = builder.getInstructions().map(ix => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map(k => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) }));
      return this.build([ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }), ...instructions]);
    }, settings);
  }
}
