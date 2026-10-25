import { PACK_CATALOG } from '../shared/packs';

type Fetch = typeof fetch;
export type ShowcaseCard = { name: string; image: string; insuredValueUsd: number; rarity: string | null };
export type Showcase = { packs: Record<string, string>; example: ShowcaseCard | null; hero: ShowcaseCard[] };

const API = 'https://gacha.collectorcrypt.com/api';
const HOUR = 3_600_000;
const https = (url: unknown): url is string => typeof url === 'string' && url.startsWith('https://');

/**
 * Collector Crypt's own artwork for the site: each machine's pack image and one real card for the
 * worked example. Read from their public API (no key), cached for an hour, and empty when they are
 * unreachable, in which case the site falls back to its drawn boosters and card.
 */
export class ShowcaseSource {
  private cache: { at: number; value: Promise<Showcase> } | null = null;
  /** Every recent real pull with a photo, from the last load. Practice mode dresses its mock cards with these. */
  cards: ShowcaseCard[] = [];
  constructor(private readonly fetcher: Fetch = fetch) {}

  get(): Promise<Showcase> {
    if (!this.cache || Date.now() - this.cache.at > HOUR) {
      const value = this.load().catch(() => ({ packs: {}, example: null, hero: [] }));
      this.cache = { at: Date.now(), value };
      // Retry sooner after a failure.
      value.then(v => { if (!Object.keys(v.packs).length && this.cache?.value === value) this.cache.at = Date.now() - HOUR + 5 * 60_000; });
    }
    return this.cache.value;
  }

  private async json(path: string) {
    const response = await this.fetcher(`${API}${path}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Collector Crypt returned HTTP ${response.status}.`);
    return response.json() as Promise<any>;
  }

  private async load(): Promise<Showcase> {
    // Recent real $25 pulls: about half come in under the pack price, which is what the example shows.
    // Bigger packs' recent winners give the homepage its real hero cards.
    const [catalog, winners, big] = await Promise.all([this.json('/machines'), this.json('/getAllWinners?count=100&packType=pokemon_25').catch(() => null), this.json('/getAllWinners?count=100&packType=pokemon_250').catch(() => null)]);
    const packs: Record<string, string> = {};
    for (const m of catalog?.machines ?? []) if (PACK_CATALOG.some(p => p.code === m.code) && https(m.imageNobg)) packs[m.code] = m.imageNobg;
    const recent = [...(big?.data ?? []), ...(winners?.data ?? [])].map(fromWinner);
    this.cards = recent.map(toCard).filter((c): c is ShowcaseCard => !!c);
    return { packs, example: pickExample((winners?.data ?? []).map(fromWinner)), hero: pickHero(recent) };
  }
}

/** A real $25-pack card that came in under the pack price, with its photo: a genuine bad pull for the example. */
export function pickExample(nfts: any[]): ShowcaseCard | null {
  const cards = nfts.map(toCard).filter((c): c is ShowcaseCard => !!c && c.insuredValueUsd >= 5 && c.insuredValueUsd <= 20);
  return cards.sort((a, b) => a.insuredValueUsd - b.insuredValueUsd)[Math.floor(cards.length / 2)] ?? null;
}

/** The most valuable recent real pulls with photos, one per card, for the homepage fan. */
export function pickHero(nfts: any[], count = 3): ShowcaseCard[] {
  const seen = new Set<string>();
  return nfts.map(toCard).filter((c): c is ShowcaseCard => !!c).sort((a, b) => b.insuredValueUsd - a.insuredValueUsd)
    .filter(c => { const key = c.name.split(' · ')[0]; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, count);
}

/** A recent-winners entry in the NFT shape `toCard` reads. */
export function fromWinner(w: any) {
  const content = w?.nft?.content ?? {};
  // `name` is cut at 32 characters; `json_name` is the full one.
  return { name: content.metadata?.json_name ?? content.metadata?.name, truncated: !content.metadata?.json_name, image: content.files?.[0]?.cc_cdn ?? content.links?.image, insured_value: w?.insuredValue, attributes: content.metadata?.attributes, rarity: null };
}

const GRADING = /\s+(PSA|CGC|BGS|SGC|TAG|Beckett)\s+\d+(\.\d+)?\s*/i, NUMBERED = /^(?:\d{4}\s+)?(.*?)\s*#\S+\s+(.+)$/;

/** The card's own name from a Collector Crypt title: "2019 #69 Full Art/Moltres GX PSA 10 Hidden Fates Pokemon" → "Moltres GX". */
export function cardTitle(full: string) {
  const at = full.search(GRADING), raw = at >= 0 ? full.slice(0, at) : full, parts = raw.match(NUMBERED);
  return (parts ? parts[2] : raw.replace(/^\d{4}\s+/, '')).replace(/^(Full Art|F\/A)\//i, '').trim() || 'Graded card';
}

/** Collector Crypt NFT → "Name · Year · PSA 9", the format the slab label splits on. */
export function toCard(nft: any): ShowcaseCard | null {
  const attrs: { trait_type?: string; value?: string }[] = Array.isArray(nft?.attributes) ? nft.attributes : [];
  const attr = (name: string) => attrs.find(a => a.trait_type === name)?.value?.toString().trim() ?? '';
  const value = Number(nft?.insured_value ?? attr('Insured Value'));
  const image = [nft?.image, nft?.content?.links?.image].find(https);
  if (!image || !Number.isFinite(value) || value <= 0) return null;
  // Two name shapes, the grade getting its own place on the slab:
  //   "2025 Pokemon Prismatic Evolutions #136 Eri CGC 10"        → card "Eri", set "Prismatic Evolutions"
  //   "2019 #69 Full Art/Moltres GX PSA 10 Hidden Fates Pokemon" → card "Moltres GX", set "Hidden Fates"
  const full = String(nft?.name ?? '').trim();
  const at = full.search(GRADING), raw = at >= 0 ? full.slice(0, at) : full;
  // A cut-off name ends mid-set ("… CGC 9 EX H"), so only a full name's tail names the set.
  const after = at >= 0 && !nft?.truncated ? full.slice(at).replace(GRADING, '').replace(/^(Pristine|Gem Mint|Mint)\s+/i, '').replace(/\s+Pok[eé]mon$/i, '').trim() : '';
  const parts = raw.match(NUMBERED);
  const title = cardTitle(full);
  const set = (parts ? parts[1].replace(/^Pok[eé]mon\s+/i, '').trim() : '') || after || attr('Year');
  const grade = `${attr('Grading Company')} ${attr('The Grade').match(/\d+(\.\d+)?/)?.[0] ?? ''}`.trim();
  return { name: [title, set, grade].filter(Boolean).join(' · '), image, insuredValueUsd: value, rarity: typeof nft?.rarity === 'string' ? nft.rarity : null };
}
