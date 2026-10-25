import { useEffect, useState } from 'react';
import { api } from './api';

export type ShowcaseCard = { name: string; image: string; insuredValueUsd: number; rarity: string | null };
export type Showcase = { packs: Record<string, string>; example: ShowcaseCard | null; hero: ShowcaseCard[] };

let request: Promise<Showcase> | null = null;

/** Collector Crypt's pack images and a real example card, fetched once per page load and shared. */
export function useShowcase() {
  const [showcase, setShowcase] = useState<Showcase | null>(null);
  useEffect(() => {
    request ??= api<Showcase>('/showcase').catch(() => ({ packs: {}, example: null, hero: [] }));
    let live = true;
    request.then(s => { if (live) setShowcase(s); });
    return () => { live = false; };
  }, []);
  return showcase;
}
