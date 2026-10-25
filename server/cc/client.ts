import { PublicKey } from '@solana/web3.js';
import { PACK_CATALOG } from '../../shared/packs';

export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export type Card = { mint: string; name: string; image: string | null; insuredValueUsd: number | null; rarity: string | null; transferSignature: string | null };
export type Buyback = { available: boolean; amountMicros: number | null; expiresAt: number | null };
export class ApiError extends Error {
  constructor(readonly status: number, readonly detail = '') { super(`Collector Crypt returned HTTP ${status}${detail ? `: ${detail}` : ''}.`); }
}
/** Collector Crypt refusing to sell from a machine right now ("Machine is low", "off", "empty", "off balance"). Nothing is charged. */
export const machineUnavailable = (error: unknown) => error instanceof ApiError && /machine is (low|off|empty)|off balance/i.test(error.detail);
export class CollectorCrypt {
  constructor(private readonly apiKey = '', private readonly fetcher: typeof fetch = fetch) {}
  private async request(path: string, body?: unknown, timeoutMs = 15_000): Promise<any> {
    const response = await this.fetcher(`https://gacha.collectorcrypt.com/api${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      // Keep Collector Crypt's own reason (e.g. "Machine is low"): it decides between retrying and refunding.
      const body: any = await response.json().catch(() => null);
      throw new ApiError(response.status, [body?.error, body?.details, body?.message].filter(x => typeof x === 'string' && x).join(' · ').slice(0, 160));
    }
    return response.json();
  }
  /** Collector Crypt's public machines, plus the unlisted ones our catalog sells on purpose (see `unlisted`). */
  async machines(): Promise<any[]> {
    const result = await this.request('/machines');
    if (!Array.isArray(result.machines)) throw new Error('Unexpected machine catalog.');
    return result.machines.filter((m: any) => m.public || PACK_CATALOG.some(p => p.unlisted && p.code === m.code));
  }
  async generatePack(playerAddress: string, packType: string, priceUsdc: number) {
    new PublicKey(playerAddress);
    if (!Number.isSafeInteger(priceUsdc) || priceUsdc <= 0) throw new Error('Use a positive whole-USDC pack price.');
    const machine = (await this.machines()).find(m => m.code === packType && m.price === priceUsdc && m.contains === 1);
    if (!machine) throw new Error('That pack is not in the public catalog.');
    const order = await this.request('/generatePack', { playerAddress, packType: machine.code, turbo: false });
    if (typeof order.memo !== 'string' || typeof order.transaction !== 'string') throw new Error('Invalid pack order.');
    return { memo: order.memo as string, transaction: order.transaction as string };
  }
  packStatus(memo: string): Promise<any> { return this.request(`/pack/status?${new URLSearchParams({ memo })}`); }
  /** Live machine availability. */
  gachaStatus(): Promise<any> { return this.request('/status'); }
  /** Opens an already-paid pack, or returns its existing award. Never buys a pack. */
  openPack(memo: string): Promise<any> { return this.request('/openPack', { memo }); }
  async buybackQuote(mint: string): Promise<Buyback> {
    new PublicKey(mint);
    const quote = await this.request(`/buyback/available?${new URLSearchParams({ nft: mint })}`);
    if (quote.available === false) return { available: false, amountMicros: null, expiresAt: null };
    const amount = Number(quote.amount), expires = Date.parse(quote.buybackExpiresAt ?? '');
    if (quote.available !== true || !Number.isSafeInteger(amount) || amount < 10_000 || amount > 280_000_000_000) throw new Error('Invalid buyback quote.');
    return { available: true, amountMicros: amount, expiresAt: Number.isFinite(expires) ? expires : null };
  }
  /** A sell-back transaction for the card's owner to sign. USDC goes to the owner. */
  async buyback(playerAddress: string, nftAddress: string) {
    new PublicKey(playerAddress); new PublicKey(nftAddress);
    const offer = await this.request('/buyback', { playerAddress, nftAddress });
    const amount = Number(offer.refundAmount);
    if (typeof offer.serializedTransaction !== 'string' || !Number.isSafeInteger(amount) || amount < 10_000 || amount > 280_000_000_000) throw new Error('Collector Crypt did not return a sell offer.');
    return { transaction: offer.serializedTransaction as string, amountMicros: amount };
  }
  /**
   * Broadcasts a signed tx through Collector Crypt so they register it (packs and buybacks).
   * Prefer this over a raw RPC send for pack payments: their indexer often misses those.
   */
  async submitTransaction(signedTransaction: string): Promise<{ signature: string; confirmationStatus?: string }> {
    // Their handler waits for confirmation (often 1–several seconds); give it more room than a status poll.
    const result = await this.request('/submitTransaction', { signedTransaction }, 45_000);
    if (!result.success || typeof result.signature !== 'string') throw new Error('Collector Crypt did not accept the signed transaction.');
    return { signature: result.signature, confirmationStatus: typeof result.confirmationStatus === 'string' ? result.confirmationStatus : undefined };
  }
  /** Reads metadata for an existing purchase by memo (no payment or opening). */
  async cardDetails(memo: string, dasRpcUrl?: string): Promise<Card | null> {
    const status = await this.packStatus(memo);
    if (!status.send?.nft_address) return null;
    const asset = dasRpcUrl ? await this.asset(status.send.nft_address, dasRpcUrl) : undefined;
    return normalizeCard({ nft_address: status.send.nft_address, nftWon: asset, transactionSignature: status.send.transaction_signature }, status);
  }
  /** Requires an RPC provider supporting Solana DAS getAsset (including Core/compressed cards). */
  async asset(mint: string, dasRpcUrl: string): Promise<any> {
    new PublicKey(mint);
    const response = await this.fetcher(dasRpcUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }) });
    if (!response.ok) throw new Error('Asset RPC request failed.');
    const body: any = await response.json();
    if (body.error || !body.result || body.result.id !== mint) throw new Error('Asset unavailable. Check that this RPC supports DAS getAsset.');
    return body.result;
  }
}

export function normalizeCard(opened: any, status: any): Card {
  const nft = opened.nftWon ?? {}, metadata = nft.content?.metadata ?? nft.metadata ?? {};
  const attributes = Array.isArray(metadata.attributes) ? metadata.attributes : [];
  const rawValue = status.send?.insured_value ?? attributes.find((a: any) => /insured.?value/i.test(a.trait_type))?.value;
  const value = rawValue == null || rawValue === '' ? NaN : Number(rawValue);
  const rawImage = nft.content?.links?.image ?? nft.content?.files?.[0]?.uri ?? metadata.image ?? nft.image;
  let image: string | null = null;
  try { const url = new URL(rawImage); if (url.protocol === 'https:' && !url.username && !url.password) image = url.href; } catch {}
  return { mint: new PublicKey(opened.nft_address).toBase58(), name: metadata.name ?? nft.name ?? 'Pokémon collectible', image,
    insuredValueUsd: Number.isFinite(value) && value >= 0 ? value : null, rarity: opened.rarity ?? null,
    transferSignature: opened.transactionSignature ?? status.send?.transaction_signature ?? null };
}
