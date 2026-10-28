import { useEffect, useState, type CSSProperties } from 'react';
import { ArrowUpRight, Flame } from 'lucide-react';
import type { BurnsView, TreasuryView } from '../../../shared/types';
import { ago, api, money, pct, solscan } from '../api';
import { useApp, useTicker } from '../app';
import { CountUp, Empty, Reveal, Ring, SectionHead, Stat } from '../ui';

const EMBERS = Array.from({ length: 16 }, (_, i) => ({ '--x': `${(i * 61) % 100}%`, '--s': `${4 + (i % 4) * 2}px`, '--d': `${(i % 8) * 0.45}s`, '--t': `${3 + (i % 5) * 0.6}s`, '--dx': `${((i * 17) % 50) - 25}px`, '--h': `${200 + (i % 4) * 60}px` }));

/** Every buyback-and-burn: a flame and the running total, the fund that pays for them, and each burn on a timeline. */
export function BurnsPage() {
  const { version } = useApp();
  const ticker = useTicker();
  const [view, setView] = useState<BurnsView | null>(null);
  const [treasury, setTreasury] = useState<TreasuryView | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const load = () => { api<BurnsView>('/burns').then(setView).catch(() => {}); api<TreasuryView>('/treasury').then(setTreasury).catch(() => {}); };
    load(); const id = setInterval(() => { if (!document.hidden) load(); }, 15_000); return () => clearInterval(id);
  }, [version]);
  async function older() {
    const last = view?.batches.at(-1); if (!last || more) return;
    setMore(true);
    try { const next = await api<BurnsView>(`/burns?before=${last.createdAt}`); setView(v => v && { ...v, batches: [...v.batches, ...next.batches] }); } finally { setMore(false); }
  }
  const t = view?.totals, fund = treasury?.cards, cap = treasury?.burnCapBps ?? 5000;

  return <div>
    {/* Flame hero */}
    <section className="relative mt-8 overflow-hidden rounded-[36px] bg-[#101935] px-6 pb-12 pt-14 text-center text-white sm:mt-12 sm:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_60%_at_50%_100%,rgb(255_120_60/0.55),transparent_70%)]" />
      <div className="embers" aria-hidden="true">{EMBERS.map((e, i) => <i key={i} style={e as CSSProperties} />)}</div>
      <div className="relative mx-auto flex justify-center"><div className="flame" style={{ '--size': '86px' } as CSSProperties} aria-hidden="true"><i /><i /><i /></div></div>
      <div className="relative mt-6 font-display text-[0.8rem] font-semibold uppercase tracking-[0.25em] text-white/60">{ticker} burned forever</div>
      <div className="relative mt-2 font-display text-5xl font-bold tracking-tight sm:text-7xl"><CountUp value={Number(t?.coinBurned ?? 0)} format={n => Math.round(n).toLocaleString('en-US')} duration={1800} /></div>
      <div className="relative mx-auto mt-8 grid max-w-2xl grid-cols-3 gap-3">
        {[['Spent on buybacks', t ? money(t.usd) : '—'], ['Of supply', t ? `${t.supplyBps.toFixed(2)}%` : '—'], ['Waiting to burn', t ? money(t.queuedUsd) : '—']].map(([l, v]) =>
          <div key={l} className="rounded-2xl bg-white/[0.07] px-3 py-3 ring-1 ring-white/10"><div className="text-[0.65rem] font-bold uppercase tracking-wider text-white/55">{l}</div><div className="mt-0.5 font-display text-xl font-bold tnum sm:text-2xl">{v}</div></div>)}
      </div>
    </section>

    {/* How each burn is sized, and the fund */}
    <section className="grid gap-6 pt-14 lg:grid-cols-[1fr_1.1fr]">
      <Reveal className="panel p-7">
        <h2 className="font-display text-2xl font-bold">Every pull burns</h2>
        <p className="mt-2 text-sub">Rip any pack and the treasury buys back {ticker} worth the card's insured value, then burns it. One pull can use at most {pct(cap)} of the free fund, so a big hit never empties it.</p>
        <div className="mt-5 rounded-2xl bg-ember-soft px-5 py-4 text-center font-display text-lg font-bold">burn = min(card value, {pct(cap)} × fund)</div>
        <p className="mt-4 text-sm text-sub">It happens right after the pull settles: one swap of $CARDS into {ticker}, then one burn, both linked below.</p>
      </Reveal>
      <Reveal delay={0.08} className="panel flex flex-wrap items-center gap-6 p-7">
        <Ring value={fund && fund.balance > 0 ? fund.free / fund.balance : 0} size={170} stroke={16} color="var(--color-ember)" marker={cap / 10_000}>
          <div><Flame className="mx-auto text-ember" size={22} /><div className="mt-1 font-display text-2xl font-bold tnum">{fund ? money(fund.freeUsd) : '—'}</div><div className="text-[0.7rem] font-bold uppercase tracking-wider text-sub">free fund</div></div>
        </Ring>
        <div className="grid min-w-[12rem] flex-1 gap-4">
          <Stat label="Next pull can burn" value={fund ? money(fund.freeUsd * cap / 10_000) : '—'} tone="text-ember" />
          <Stat label="$CARDS in the fund" value={fund ? fund.balance.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'} hint={fund ? `${fund.queued.toLocaleString('en-US', { maximumFractionDigits: 0 })} promised to queued burns` : undefined} />
        </div>
      </Reveal>
    </section>

    {/* Timeline */}
    <section className="pt-16">
      <SectionHead title="Burn timeline" sub="Newest first. Each one is a single buyback and burn on Solana." />
      {view && !view.batches.length && <Empty title="No burns yet" text="The first burn runs seconds after the first pull settles." />}
      {!!view?.batches.length && <ol className="relative ml-3 border-l-[3px] border-dashed border-edge pl-8 sm:ml-5">
        {view.batches.map((b, i) => <Reveal as="li" key={b.id} delay={Math.min(i, 6) * 0.04} className="relative pb-6 last:pb-0">
          <span className={`absolute -left-[46px] top-4 grid size-7 place-items-center rounded-full ring-4 ring-bg ${b.status === 'burned' ? 'bg-gradient-to-br from-ember to-ember-2 text-white' : 'bg-gold text-ink'}`}><Flame size={14} /></span>
          <div className="panel lift flex flex-wrap items-center gap-x-6 gap-y-3 p-5">
            <div className="min-w-0 flex-1">
              <div className="font-display text-2xl font-bold tnum">{b.status === 'burned' ? `${Number(b.coinBurned).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${ticker} burned` : b.status === 'review' ? 'On hold' : `Buying back ${ticker}…`}</div>
              {/* The fund pays in $CARDS: they're swapped into the coin, and the coin is what gets burned. */}
              <div className="text-sm text-sub">{b.status === 'burned' ? 'Bought back' : 'Buying'} with {money(b.usd)} of $CARDS · {b.pulls} pull{b.pulls === 1 ? '' : 's'} · {ago(b.burnedAt ?? b.createdAt)}</div>
            </div>
            <div className="flex gap-2">
              {b.swapSignature && <a className="chip bg-soft hover:bg-edge" href={solscan('tx', b.swapSignature)} target="_blank" rel="noreferrer">Buyback<ArrowUpRight size={13} /></a>}
              {b.burnSignature && <a className="chip bg-ember-soft text-ember hover:brightness-95" href={solscan('tx', b.burnSignature)} target="_blank" rel="noreferrer">Burn<ArrowUpRight size={13} /></a>}
            </div>
          </div>
        </Reveal>)}
      </ol>}
      {view && view.batches.length >= 30 && <button className="btn btn-ghost mt-6" disabled={more} onClick={older}>{more ? 'Loading…' : 'Older burns'}</button>}
    </section>
  </div>;
}
