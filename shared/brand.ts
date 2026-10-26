/** Rename the site here. The coin's ticker comes from config (VITE_COIN_SYMBOL / COIN_SYMBOL). */
export const BRAND = {
  name: 'Ripburn',
  tagline: 'Rip packs. Burn supply. Holders never take an L.',
  description: 'Open Pokémon card packs on-chain. Every pull buys back and burns the coin, and holders get any loss repaid in USDC.',
  /** The X (Twitter) handle, without the @. */
  x: 'ripburncards',
} as const;
export const X_URL = `https://x.com/${BRAND.x}`;
