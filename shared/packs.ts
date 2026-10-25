/** Collector Crypt machines we sell, by their machine code. A code is what identifies a pack: $500 is both a Pokémon and a watch pack. */
export type PackKind = 'pokemon' | 'watch';
/**
 * `retired`: no longer sold, but still known so past orders, claims and receipts read correctly.
 * `unlisted`: Collector Crypt keeps the machine off its public menu (`public: false`) but it is open and selling; sold here anyway.
 */
export type PackDef = { code: string; priceUsd: number; kind: PackKind; retired?: boolean; unlisted?: boolean };

/** In price order. Collector Crypt's "WATCH 250" and "WATCH 500" pay out graded Pokémon cards, so they sell as card packs. */
export const PACK_CATALOG: PackDef[] = [
  { code: 'pokemon_25', priceUsd: 25, kind: 'pokemon' },
  { code: 'pokemon_50', priceUsd: 50, kind: 'pokemon' },
  { code: 'pokemon_100', priceUsd: 100, kind: 'pokemon' },
  { code: 'pokemon_250', priceUsd: 250, kind: 'pokemon' },
  { code: 'ewatch_250', priceUsd: 250, kind: 'pokemon' },
  { code: 'pokemon_500', priceUsd: 500, kind: 'pokemon' },
  { code: 'ewatch_500', priceUsd: 500, kind: 'pokemon' },
  // Collector Crypt's "Watch $500": the machine that actually pays out watches. It has no machine image there, so the site draws one.
  { code: 'ewatches_500', priceUsd: 500, kind: 'watch', unlisted: true },
  // Off sale: Collector Crypt has no machine image for it. Kept so any orders on it still read.
  { code: 'pokemon_151', priceUsd: 151, kind: 'pokemon', unlisted: true, retired: true },
];

/** The machines on sale now. */
export const SELLING = PACK_CATALOG.filter(p => !p.retired);

export const packDef = (code: string | null | undefined) => PACK_CATALOG.find(p => p.code === code) ?? null;
/** Orders and claims from before pack codes existed were all Pokémon packs. */
export const packCode = (code: string | null | undefined, priceUsd: number) => code || `pokemon_${priceUsd}`;
