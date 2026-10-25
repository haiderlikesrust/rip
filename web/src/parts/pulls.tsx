import { useEffect, useRef, useState } from 'react';
import { Flame, HeartHandshake } from 'lucide-react';
import type { SitePull } from '../../../shared/types';
import { ago, api, money } from '../api';
import { useApp } from '../app';
import { hueFor, packStyle } from '../ui';

/** Packs opened here, refreshed while the page is visible and whenever an order finishes. */
export function useSitePulls(path = '/pulls/recent', every = 15_000) {
  const { version } = useApp();
  const [items, setItems] = useState<SitePull[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api<{ items: SitePull[] }>(path).then(r => { if (live) setItems(r.items); }).catch(() => { if (live) setItems(i => i ?? []); });
    load(); const id = setInterval(() => { if (!document.hidden) load(); }, every);
    return () => { live = false; clearInterval(id); };
  }, [path, every, version]);
  return items;
}

/** A small thumbnail: the card's photo, or a color tile with its initial. */
export function Thumb({ pull, size = 'size-12' }: { pull: SitePull; size?: string }) {
  const name = (pull.card?.name ?? 'Card').split(' · ')[0];
  return pull.card?.image
    ? <img src={pull.card.image} alt="" referrerPolicy="no-referrer" loading="lazy" className={`${size} shrink-0 rounded-xl object-cover`} />
    : <span className={`${size} grid shrink-0 place-items-center rounded-xl font-display text-lg font-bold text-white`} style={{ background: hueFor(name) }}>{name.slice(0, 1)}</span>;
}

/** The live feed: one row per pull, new ones sliding in at the top. */
export function LiveFeed({ limit = 8 }: { limit?: number }) {
  const pulls = useSitePulls();
  // Rows that arrived since the last refresh slide in; the first load doesn't animate.
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!pulls) return;
    const ids = pulls.map(p => p.id);
    if (known.current) setFresh(new Set(ids.filter(id => !known.current!.has(id))));
    known.current = new Set(ids);
  }, [pulls]);
  if (!pulls) return <div className="grid gap-2">{Array.from({ length: 4 }, (_, i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-soft" />)}</div>;
  if (!pulls.length) return <p className="rounded-2xl bg-softer p-5 text-sm text-sub">No rips yet. The first pack opened here shows up right away.</p>;
  return <ul className="grid gap-2">
    {pulls.slice(0, limit).map(p => {
      const name = (p.card?.name ?? 'Graded card').split(' · ')[0], up = p.valueUsd >= p.priceUsd;
      return <li key={p.id} className={`flex items-center gap-3 rounded-2xl bg-softer p-2.5 pr-4 ${fresh.has(p.id) ? 'feed-in' : ''}`}>
        <Thumb pull={p} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2"><span className="truncate font-display font-bold">{name}</span>{up && <span className="chip h-5 bg-gold-soft px-2 text-[0.65rem] text-ink">Hit</span>}</div>
          <div className="truncate text-xs text-sub">{p.wallet} · {packStyle(p.code, p.priceUsd).name} {money(p.priceUsd)} · {ago(p.at)}</div>
        </div>
        <div className="grid shrink-0 justify-items-end gap-0.5 text-right">
          <span className={`font-display font-bold tnum ${up ? 'text-mint' : ''}`}>{money(p.valueUsd)}</span>
          <span className="flex gap-2 text-[0.7rem] font-bold">
            {p.burnUsd > 0 && <span className="inline-flex items-center gap-0.5 text-ember"><Flame size={11} />{money(p.burnUsd)}</span>}
            {p.repayUsd > 0 && <span className="inline-flex items-center gap-0.5 text-mint"><HeartHandshake size={11} />{money(p.repayUsd)}</span>}
          </span>
        </div>
      </li>;
    })}
  </ul>;
}

/** A sideways ticker of the latest pulls, for the top of the home page. */
export function Ticker() {
  const pulls = useSitePulls();
  if (!pulls?.length) return null;
  const items = pulls.slice(0, 12), loop = [...items, ...items];
  return <div className="relative overflow-hidden py-3 [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]">
    <div className="marquee gap-3">
      {loop.map((p, i) => <span key={`${p.id}-${i}`} className="flex shrink-0 items-center gap-2 rounded-full bg-card py-1.5 pl-1.5 pr-4 text-sm shadow-[var(--shadow-soft)]">
        <Thumb pull={p} size="size-7" /><span className="font-display font-semibold">{(p.card?.name ?? 'Card').split(' · ')[0]}</span>
        <span className="tnum font-bold">{money(p.valueUsd)}</span>{p.burnUsd > 0 && <span className="inline-flex items-center gap-0.5 font-bold text-ember"><Flame size={12} />{money(p.burnUsd)}</span>}
      </span>)}
    </div>
  </div>;
}
