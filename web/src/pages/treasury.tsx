import { useEffect, useState } from 'react';
import { ArrowUpRight, Flame, HeartHandshake, Landmark } from 'lucide-react';
import type { TreasuryView } from '../../../shared/types';
import { packDef } from '../../../shared/packs';
import { api, money, pct, short, solscan } from '../api';
import { useApp, useTicker } from '../app';
import { PageHead, Reveal, Ring, SectionHead, Stat, packStyle } from '../ui';

/** The dev wallet in the open: how creator fees flow, the two buckets as gauges, and every total. */
export function TreasuryPage() {
  const { version } = useApp();
  const ticker = useTicker();
  const [t, setT] = useState<TreasuryView | null>(null);
  useEffect(() => {
    const load = () => api<TreasuryView>('/treasury').then(setT).catch(() => {});
    load(); const id = setInterval(() => { if (!document.hidden) load(); }, 15_000); return () => clearInterval(id);
  }, [version]);

  return <div>
    <PageHead eyebrow={<><Landmark size={14} />Treasury</>} tone="bg-sky-soft text-sky" title="Where the money flows" sub="The treasury is the dev wallet. Creator fees arrive as $CARDS and fund two things: burns, and a USDC reserve that repays holders. Repays always come first.">
      {t?.treasuryAddress && <a href={solscan('account', t.treasuryAddress)} target="_blank" rel="noreferrer" className="chip mt-5 bg-card shadow-[var(--shadow-soft)] hover:text-sky">{short(t.treasuryAddress)}<ArrowUpRight size={13} /></a>}
    </PageHead>

    <Reveal className="panel mt-10 overflow-hidden p-4 sm:p-8"><div className="no-scrollbar overflow-x-auto"><div className="min-w-[640px]"><FlowDiagram t={t} ticker={ticker} /></div></div></Reveal>

    <section className="grid gap-6 pt-10 md:grid-cols-2">
      <Reveal className="panel p-7">
        <div className="flex items-center justify-between"><h2 className="flex items-center gap-2 font-display text-2xl font-bold"><HeartHandshake className="text-mint" />Repay reserve</h2><span className="chip bg-mint-soft text-mint">USDC</span></div>
        <div className="mt-6 flex flex-wrap items-center gap-6">
          <Ring value={t ? t.usdc.freeUsd / Math.max(t.usdc.targetUsd, t.usdc.freeUsd, 1) : 0} size={150} stroke={14} color="var(--color-mint)">
            <div><div className="font-display text-2xl font-bold tnum">{t ? money(t.usdc.freeUsd) : '—'}</div><div className="text-[0.7rem] font-bold uppercase tracking-wider text-sub">free</div></div>
          </Ring>
          <dl className="grid flex-1 gap-3 text-sm">
            <Row label="Held" value={t ? money(t.usdc.balanceUsd) : '—'} />
            <Row label="Set aside for packs opening now" value={t ? money(t.usdc.reservedUsd) : '—'} />
            <Row label="Refill target" value={t ? money(t.usdc.targetUsd) : '—'} />
          </dl>
        </div>
        {!!t?.pausedForHolders.length && <p className="mt-5 rounded-2xl bg-gold-soft p-4 text-sm"><b>Refilling.</b> Holder packs at {t.pausedForHolders.map(code => { const p = packDef(code); return p ? `${packStyle(code, p.priceUsd).name} ${money(p.priceUsd)}` : code; }).join(', ')} wait until the reserve can cover a full repay. Everyone else keeps ripping.</p>}
      </Reveal>
      <Reveal delay={0.08} className="panel p-7">
        <div className="flex items-center justify-between"><h2 className="flex items-center gap-2 font-display text-2xl font-bold"><Flame className="text-ember" />Burn fund</h2><span className="chip bg-ember-soft text-ember">$CARDS</span></div>
        <div className="mt-6 flex flex-wrap items-center gap-6">
          <Ring value={t && t.cards.balance > 0 ? t.cards.free / t.cards.balance : 0} size={150} stroke={14} color="var(--color-ember)">
            <div><div className="font-display text-2xl font-bold tnum">{t ? money(t.cards.freeUsd) : '—'}</div><div className="text-[0.7rem] font-bold uppercase tracking-wider text-sub">free</div></div>
          </Ring>
          <dl className="grid flex-1 gap-3 text-sm">
            <Row label="$CARDS held" value={t ? t.cards.balance.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'} />
            <Row label="Promised to burns or a refill" value={t ? t.cards.queued.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'} />
            <Row label="$CARDS price" value={t ? money(t.cards.priceUsd) : '—'} />
            <Row label="Max per pull" value={t ? pct(t.burnCapBps) : '—'} />
          </dl>
        </div>
      </Reveal>
    </section>

    <section className="pt-14">
      <SectionHead title="All time" />
      <Reveal className="panel grid grid-cols-2 gap-6 p-7 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Creator fees" value={t ? money(t.totals.creatorFeesUsd) : '—'} />
        <Stat label="Repaid" value={t ? money(t.totals.repaidUsd) : '—'} tone="text-mint" />
        <Stat label="Burned" value={t ? money(t.totals.burnedUsd) : '—'} tone="text-ember" />
        <Stat label="Sold to refill" value={t ? money(t.totals.refilledUsd) : '—'} tone="text-sky" />
        <Stat label="Packs ripped" value={t ? t.totals.packsOpened.toLocaleString('en-US') : '—'} hint={t ? `${t.totals.holderPacks} by holders` : undefined} />
        <Stat label="Network fees" value={t ? money(t.totals.networkFeesUsd) : '—'} />
      </Reveal>
    </section>

    <Reveal as="section" className="panel-soft mt-14 p-7 text-sub">
      <h2 className="font-display text-xl font-bold text-ink">What one pack costs the treasury</h2>
      <p className="mt-2">For a holder's pack: <b className="text-ink">the loss</b> (pack price − card value) plus <b className="text-ink">the burn</b> (card value, capped at {t ? pct(t.burnCapBps) : 'a share'} of the free fund). For anyone else's: just the burn. Hits don't offset losses, so repays cost the average loss on losing pulls every time; burns shrink by themselves when volume is high, and creator fees top both back up.</p>
    </Reveal>
  </div>;
}

/** Creator fees → treasury → burn fund and repay reserve, with the money moving along the lines. */
function FlowDiagram({ t, ticker }: { t: TreasuryView | null; ticker: string }) {
  const node = (x: number, y: number, w: number, title: string, value: string, tone: string) => <g transform={`translate(${x} ${y})`}>
    <rect width={w} height="74" rx="20" fill="var(--color-card)" stroke="var(--color-edge)" strokeWidth="1.5" />
    <circle cx="26" cy="37" r="9" fill={tone} />
    <text x="46" y="31" fontFamily="var(--font-display)" fontWeight="600" fontSize="13" fill="var(--color-sub)">{title}</text>
    <text x="46" y="54" fontFamily="var(--font-display)" fontWeight="700" fontSize="19" fill="var(--color-ink)">{value}</text>
  </g>;
  const line = (d: string, color: string) => <><path d={d} fill="none" stroke="var(--color-edge)" strokeWidth="6" strokeLinecap="round" /><path d={d} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" className="flow" /></>;
  return <svg viewBox="0 0 900 300" className="block w-full" role="img" aria-label={`Creator fees flow into the treasury, which funds burns of ${ticker} and a USDC reserve for repays.`}>
    {line('M220 150 H330', 'var(--color-gold)')}
    {line('M560 150 C610 150 610 70 660 70', 'var(--color-ember)')}
    {line('M560 150 C610 150 610 230 660 230', 'var(--color-mint)')}
    {line('M760 107 V193', 'var(--color-sky)')}
    {node(10, 113, 210, 'Creator fees', t ? money(t.totals.creatorFeesUsd) : '—', 'var(--color-gold)')}
    {node(330, 113, 230, 'Treasury (dev wallet)', t ? money(t.usdc.balanceUsd + t.cards.freeUsd) : '—', 'var(--color-sky)')}
    {node(660, 33, 230, `Burns ${ticker}`, t ? money(t.totals.burnedUsd) : '—', 'var(--color-ember)')}
    {node(660, 193, 230, 'Repays holders', t ? money(t.totals.repaidUsd) : '—', 'var(--color-mint)')}
    <text x="772" y="155" fontFamily="var(--font-display)" fontWeight="600" fontSize="11" fill="var(--color-sub)">$CARDS → USDC</text>
    <text x="772" y="170" fontFamily="var(--font-display)" fontWeight="600" fontSize="11" fill="var(--color-sub)">refills first</text>
  </svg>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-baseline justify-between gap-3 border-b border-edge pb-2 last:border-0"><dt className="text-sub">{label}</dt><dd className="font-display font-bold tnum">{value}</dd></div>;
}
