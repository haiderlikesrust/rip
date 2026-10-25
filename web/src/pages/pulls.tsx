import { useState } from 'react';
import { ArrowUpRight, Flame, HeartHandshake, Layers, RotateCcw } from 'lucide-react';
import type { SitePull } from '../../../shared/types';
import { ago, money, solscan } from '../api';
import { useApp } from '../app';
import { useSitePulls } from '../parts/pulls';
import { CountUp, Empty, PageHead, Reveal, SectionHead, TradingCard, isWatch, packStyle } from '../ui';

/** Your binder: every card you ripped. Tap a card to flip it and read its receipt. */
export function PullsPage() {
  const { me, connect } = useApp();
  const mine = useSitePulls(me.wallet ? '/me/pulls' : '/pulls/recent');
  const everyone = useSitePulls('/pulls/recent');
  const totals = me.wallet && mine ? mine.reduce((t, p) => ({ paid: t.paid + p.priceUsd, value: t.value + p.valueUsd, repaid: t.repaid + p.repayUsd, burned: t.burned + p.burnUsd }), { paid: 0, value: 0, repaid: 0, burned: 0 }) : null;

  return <div>
    <PageHead eyebrow={<><Layers size={14} />Binder</>} tone="bg-violet-soft text-violet" title="Your binder" sub="Every card you ripped, with what it burned and what came back. Tap a card to flip it." />
    {!me.wallet ? <div className="mt-10"><Empty title="Connect to open your binder" text="Every pack you rip lands here with its receipts." action={<button className="btn btn-ink" onClick={connect}>Connect wallet</button>} /></div>
      : !mine ? <div className="mt-10 grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <div key={i} className="aspect-[5/7] animate-pulse rounded-2xl bg-soft" />)}</div>
      : !mine.length ? <div className="mt-10"><Empty title="Your binder is empty" text="Rip your first pack and it shows up here with every receipt." /></div>
      : <>
        {totals && <Reveal className="panel mt-10 grid grid-cols-2 gap-6 p-6 sm:grid-cols-4 sm:p-7">
          {([['Spent', totals.paid, ''], ['Cards worth', totals.value, totals.value >= totals.paid ? 'text-mint' : ''], ['Repaid to you', totals.repaid, 'text-mint'], ['Your pulls burned', totals.burned, 'text-ember']] as const).map(([label, value, tone]) =>
            <div key={label}><div className="eyebrow">{label}</div><div className={`mt-1 font-display text-3xl font-bold ${tone}`}><CountUp value={value} format={n => money(n)} /></div></div>)}
        </Reveal>}
        <div className="mt-8 grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">{mine.map((p, i) => <Reveal key={p.id} delay={Math.min(i, 10) * 0.04}><BinderCard pull={p} /></Reveal>)}</div>
      </>}

    {!!everyone?.length && <section className="pt-20">
      <SectionHead title="Fresh from everyone" />
      <div className="no-scrollbar -mx-4 flex gap-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6">
        {everyone.slice(0, 16).map(p => <div key={p.id} className="w-36 shrink-0"><TradingCard card={{ name: p.card?.name ?? 'Graded card', image: p.card?.image ?? null, insuredValueUsd: p.valueUsd }} priceUsd={p.priceUsd} watch={isWatch(p.code)} tilt />
          <div className="mt-2 flex justify-between text-xs font-bold"><span className="text-sub">{p.wallet}</span><span className="tnum">{money(p.valueUsd)}</span></div></div>)}
      </div>
    </section>}
  </div>;
}

/** A card that flips over to its receipt. */
function BinderCard({ pull }: { pull: SitePull }) {
  const [back, setBack] = useState(false);
  const st = packStyle(pull.code, pull.priceUsd), name = (pull.card?.name ?? 'Graded card').split(' · ')[0], up = pull.valueUsd >= pull.priceUsd;
  return <div>
    <div role="button" tabIndex={0} onClick={() => setBack(b => !b)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBack(b => !b); } }} aria-pressed={back} aria-label={`${name}: ${back ? 'show card' : 'show receipt'}`} className="block w-full cursor-pointer [perspective:1000px]">
      <div className="relative aspect-[5/7] transition-transform duration-700 [transform-style:preserve-3d]" style={{ transform: back ? 'rotateY(180deg)' : undefined }}>
        <div className="absolute inset-0 [backface-visibility:hidden]"><TradingCard card={{ name: pull.card?.name ?? 'Graded card', image: pull.card?.image ?? null, insuredValueUsd: pull.valueUsd }} priceUsd={pull.priceUsd} watch={isWatch(pull.code)} /></div>
        <div className="absolute inset-0 flex flex-col rounded-2xl bg-card p-4 text-left shadow-[var(--shadow-lift)] [backface-visibility:hidden] [transform:rotateY(180deg)]" style={{ boxShadow: `inset 0 0 0 3px ${st.color}, var(--shadow-lift)` }}>
          <div className="eyebrow">{st.name} · {money(pull.priceUsd)}</div>
          <div className="mt-1 font-display text-base font-bold leading-tight">{name}</div>
          <dl className="mt-3 grid gap-1.5 text-xs">
            <div className="flex justify-between"><dt className="text-sub">Card</dt><dd className={`font-bold tnum ${up ? 'text-mint' : ''}`}>{money(pull.valueUsd)}</dd></div>
            <div className="flex justify-between"><dt className="text-sub">Repaid</dt><dd className="font-bold tnum text-mint">{pull.repayUsd ? `+${money(pull.repayUsd)}` : '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-sub">Burn</dt><dd className="font-bold tnum text-ember">{pull.burnUsd ? `${money(pull.burnUsd)}${pull.burnStatus === 'burned' ? '' : ' (queued)'}` : '—'}</dd></div>
          </dl>
          <div className="mt-auto flex flex-wrap gap-1">
            {([['Pay', pull.txs.payment], ['Pack', pull.txs.pack], ['Card', pull.txs.card], ['Repay', pull.txs.repay], ['Burn', pull.txs.burn]] as const).filter(([, sig]) => sig).map(([label, sig]) =>
              <a key={label} href={solscan('tx', sig!)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="chip h-6 bg-soft px-2 text-[0.65rem] hover:bg-edge">{label}<ArrowUpRight size={10} /></a>)}
          </div>
        </div>
      </div>
    </div>
    <div className="mt-2 flex items-center justify-between gap-2 px-1">
      <span className="truncate text-sm font-bold">{name}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-bold">
        {pull.burnUsd > 0 && <Flame size={13} className="text-ember" />}{pull.repayUsd > 0 && <HeartHandshake size={13} className="text-mint" />}
        <button onClick={() => setBack(b => !b)} aria-label="Flip" className="text-dim hover:text-ink"><RotateCcw size={13} /></button>
      </span>
    </div>
    <div className="px-1 text-xs text-dim">{ago(pull.at)}</div>
  </div>;
}
