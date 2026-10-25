import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, ArrowUpRight, Flame, HeartHandshake, X } from 'lucide-react';
import type { OrderView, Quote } from '../../../shared/types';
import { api, friendly, money, solscan } from '../api';
import { useApp, useTicker } from '../app';
import { ensureSigner, hasSigner, signPayment } from '../wallet';
import { CountUp, PackArt, Ring, SplitBar, TradingCard, isWatch, packStyle, useFocusTrap } from '../ui';

export type Pack = { code: string; priceUsd: number; quote: Quote };
export type BatchSummary = { packs: number; paidUsd: number; valueUsd: number; repaidUsd: number; burnUsd: number; refunded: number };
export const FINAL = ['complete', 'refunded', 'expired', 'review'];

/** Where the order is, as a share of the way round the ring and a line of text. */
function stage(status: OrderView['status'] | undefined, hasCard: boolean) {
  if (!status || status === 'awaiting_payment') return { at: 0.08, text: 'Approve the payment in your wallet', wait: true };
  if (status === 'paying') return { at: 0.28, text: 'Confirming your payment' };
  if (status === 'paid' || status === 'buying') return { at: 0.55, text: 'Ripping the pack on Collector Crypt' };
  if (status === 'delivering') return { at: 0.8, text: 'Sending the card to your wallet' };
  if (status === 'settling') return { at: 0.92, text: hasCard ? 'Settling the burn and your repay' : 'Settling' };
  return { at: 1, text: '' };
}

const SPARKLES = Array.from({ length: 10 }, (_, i) => ({ left: `${8 + (i * 37) % 84}%`, top: `${6 + (i * 53) % 80}%`, d: `${(i % 5) * 0.25}s` }));
const CONFETTI = ['#ff4b3e', '#ff8a3d', '#ffc23c', '#12b886', '#2e6bff', '#7c5cff'];

/**
 * The rip: a full-screen stage. The pack floats inside a progress ring, spins while Collector Crypt
 * opens it, then bursts; the card flips over from its back and its foil follows the pointer. The burn
 * and the repay land as two tokens. Reopening a finished order shows the card straight away.
 */
export function RipOverlay({ pack, order, batch, summary, onNext, onUpdate, onAgain, onClose }: {
  pack: Pack; order: OrderView | null; batch: { index: number; count: number } | null; summary: BatchSummary | null;
  onNext: () => void; onUpdate: (o: OrderView) => void; onAgain: () => void; onClose: () => void;
}) {
  const ticker = useTicker();
  const shell = useRef<HTMLDivElement>(null);
  useFocusTrap(true, shell, onClose);
  const status = order?.status, card = order?.card ?? null;
  // The reveal plays only if this screen showed the pack first (or for every pack of a batch).
  const watched = useRef<Record<string, boolean>>({});
  const id = order?.id ?? 'new';
  if (watched.current[id] === undefined) watched.current[id] = !card || !!batch;
  const playing = watched.current[id];
  const failed = status === 'refunded' || status === 'expired' || status === 'review' || status === 'refunding';
  const done = status === 'complete', more = !!batch && batch.index < batch.count - 1;
  const hit = !!order && order.valueUsd !== null && order.valueUsd >= order.priceUsd;
  const holder = order?.holder ?? pack.quote.holder;
  const s = stage(status, !!card), style = packStyle(pack.code, pack.priceUsd);
  const [name, set, grade] = (card?.name ?? '').split(' · ');
  const glow = { '--glow': style.color } as CSSProperties;

  return createPortal(<div ref={shell} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Ripping your pack" className="fixed inset-0 z-50 overflow-y-auto text-white outline-none" style={glow}>
    <div className="fixed inset-0 bg-[#0b1124]/95 backdrop-blur-xl" />
    <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(60%_50%_at_50%_35%,color-mix(in_srgb,var(--glow)_45%,transparent),transparent_70%)]" />
    {done && hit && <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">{Array.from({ length: 36 }, (_, i) =>
      <i key={i} className="confetti-piece" style={{ left: `${(i * 29) % 100}%`, background: CONFETTI[i % CONFETTI.length], '--d': `${(i % 9) * 0.08}s`, '--dx': `${((i * 13) % 80) - 40}px`, '--t': `${2 + (i % 5) * 0.3}s` } as CSSProperties} />)}</div>}

    <button onClick={onClose} aria-label="Close" className="fixed right-4 top-4 z-10 grid size-11 place-items-center rounded-full bg-white/10 hover:bg-white/20"><X size={20} /></button>

    <div className="relative mx-auto flex min-h-full max-w-5xl flex-col items-center px-5 pb-10 pt-14">
      <div className="chip bg-white/10 text-white/85">{batch && `${batch.index + 1} of ${batch.count} · `}{style.name} · {money(pack.priceUsd)} · {holder ? 'Holder: loss repaid' : 'Not a holder'}</div>

      {/* Stage */}
      <div className="rip-stage relative mt-6 grid h-[360px] w-full max-w-[340px] place-items-center sm:h-[400px]">
        {!card && <>
          <div className="absolute"><Ring value={s.at} size={320} stroke={6} color="var(--glow)" track="rgb(255 255 255 / .1)" spin={!!s.wait} /></div>
          <div className={`w-[210px] ${failed ? 'opacity-40 grayscale' : status === 'paid' || status === 'buying' ? 'pack-spin' : status === 'delivering' ? 'pack-shake' : 'pack-idle'}`}><PackArt code={pack.code} priceUsd={pack.priceUsd} /></div>
        </>}
        {card && <>
          {playing && <div className="pack-burst absolute w-[210px]" aria-hidden="true"><PackArt code={pack.code} priceUsd={pack.priceUsd} /></div>}
          {playing && <div className="light-burst" aria-hidden="true" />}
          {hit && <div className="beams" aria-hidden="true" />}
          {hit && SPARKLES.map((p, i) => <i key={i} className="sparkle" style={{ left: p.left, top: p.top, '--d': p.d } as CSSProperties} aria-hidden="true" />)}
          <div className={`relative w-[220px] sm:w-[240px] ${playing ? 'card-arrive' : 'fade-up'}`} style={{ transformStyle: 'preserve-3d' }}>
            <TradingCard card={card} priceUsd={order!.priceUsd} tilt watch={isWatch(pack.code)} foil={hit ? 0.6 : 0.3} />
          </div>
          {done && (order!.burn?.usd ?? 0) > 0 && <Token side="left" delay={playing ? 1.9 : 0} tone="ember" icon={<Flame size={18} />} label="Burn" value={order!.burn!.usd} />}
          {done && (order!.repayUsd ?? 0) > 0 && <Token side="right" delay={playing ? 2.15 : 0} tone="mint" icon={<HeartHandshake size={18} />} label="Repaid" value={order!.repayUsd!} />}
        </>}
      </div>

      {/* Caption */}
      <div className="mt-4 text-center" aria-live="polite">
        {card ? <>
          <h2 className="font-display text-3xl font-bold sm:text-4xl">{name}</h2>
          <p className="text-white/60">{[set, grade].filter(Boolean).join(' · ')}</p>
          {order!.valueUsd !== null && <div className={`mt-2 font-display text-5xl font-bold ${hit ? 'text-gold' : ''}`}><CountUp value={order!.valueUsd} format={n => money(n)} duration={playing ? 1600 : 0} /></div>}
          {done && <p className="mt-1 text-sm font-semibold text-white/70">{hit ? 'A hit! The card beat the pack price.' : holder ? `Under the pack price, so the ${money(order!.repayUsd ?? 0)} difference is back in your wallet.` : `Hold ${ticker} to get losses like this repaid.`}</p>}
        </> : failed ? <>
          <h2 className="font-display text-3xl font-bold">{status === 'refunding' ? 'Refunding your payment' : status === 'refunded' ? 'Refunded in full' : status === 'expired' ? 'Payment window closed' : 'Needs a quick check'}</h2>
          <p className="mx-auto mt-2 max-w-md text-white/65">{status === 'review' ? 'Your payment is safe. The team has been alerted and will finish this order.' : order?.message}</p>
        </> : <>
          <h2 className="font-display text-2xl font-bold sm:text-3xl">{s.text}</h2>
          <p className="mt-1 text-white/55">{order?.message && status !== 'awaiting_payment' ? order.message : 'This takes a few seconds.'}</p>
        </>}
      </div>

      {/* Result */}
      {order && order.valueUsd !== null && !failed && <div className="fade-up mt-8 w-full max-w-2xl rounded-[28px] bg-white/[0.06] p-5 ring-1 ring-white/10 sm:p-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Glass label="You paid" value={money(order.totalUsd)} />
          <Glass label="Card value" value={money(order.valueUsd)} tone={hit ? 'text-gold' : ''} />
          <Glass label="Repaid" value={hit ? 'No loss' : !holder ? '—' : order.repayUsd === null ? '…' : `+${money(order.repayUsd)}`} tone={!hit && holder ? 'text-[#5ee6b8]' : 'text-white/60'} />
          <Glass label={order.burn?.status === 'burned' ? 'Burned' : 'Burn queued'} value={order.burn ? money(order.burn.usd) : '…'} tone="text-[#ff9b7a]" />
        </div>
        {order.repayUsd !== null && !hit && <div className="mt-5"><SplitBar priceUsd={order.priceUsd} valueUsd={order.valueUsd} repayUsd={order.repayUsd} /></div>}
        {order.burn?.status === 'skipped' && <p className="mt-3 text-sm text-white/60">The burn fund was empty, so this pull burned nothing.</p>}
        {done && card && <SellBack order={order} onSold={onUpdate} />}
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs font-bold text-white/55">
          {([['Payment', order.paymentSignature], ['Pack', order.packSignature], ['Card', order.nftSignature], ['Repay', order.repaySignature], ['Burn', order.burn?.signature], ['Refund', order.refundSignature]] as const).filter(([, sig]) => sig).map(([label, sig]) =>
            <a key={label} className="inline-flex items-center gap-0.5 hover:text-white" href={solscan('tx', sig!)} target="_blank" rel="noreferrer">{label}<ArrowUpRight size={12} /></a>)}
        </div>
      </div>}

      {summary && !more && <div className="fade-up mt-4 w-full max-w-2xl rounded-[28px] bg-white/[0.06] p-5 ring-1 ring-white/10">
        <div className="eyebrow !text-white/55">{summary.packs} packs{summary.refunded ? ` · ${summary.refunded} refunded` : ''}</div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Glass label="Paid" value={money(summary.paidUsd)} /><Glass label="Cards worth" value={money(summary.valueUsd)} />
          <Glass label="Repaid" value={summary.repaidUsd ? `+${money(summary.repaidUsd)}` : '—'} tone="text-[#5ee6b8]" /><Glass label="Burned" value={money(summary.burnUsd)} tone="text-[#ff9b7a]" />
        </div>
      </div>}

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        {more && status && FINAL.includes(status) ? <button className="btn btn-ember h-14 px-7 text-lg" onClick={onNext}>Next pack<ArrowRight size={18} /></button>
          : done && <button className="btn btn-ember h-14 px-7 text-lg" onClick={onAgain}>{batch ? `Rip ${batch.count} more` : 'Rip another'}</button>}
        <button className="btn h-14 bg-white/10 px-7 text-lg text-white hover:bg-white/15" onClick={onClose}>{status && FINAL.includes(status) && !more ? 'Done' : 'Keep it going in the background'}</button>
      </div>
    </div>
  </div>, document.body);
}

function Token({ side, delay, tone, icon, label, value }: { side: 'left' | 'right'; delay: number; tone: 'ember' | 'mint'; icon: React.ReactNode; label: string; value: number }) {
  const [shown, setShown] = useState(delay === 0);
  useEffect(() => { if (delay === 0) return; const t = setTimeout(() => setShown(true), delay * 1000); return () => clearTimeout(t); }, [delay]);
  if (!shown) return null;
  const bg = tone === 'ember' ? 'bg-gradient-to-br from-ember to-ember-2' : 'bg-mint';
  return <div className={`absolute top-[62%] z-10 ${side === 'left' ? 'left-0 sm:-left-16 token-left' : 'right-0 sm:-right-16 token-right'}`}>
    <div className={`relative flex items-center gap-2 rounded-full ${bg} py-2 pl-2 pr-4 shadow-[0_14px_30px_-10px_rgb(0_0_0/0.6)]`}>
      <span className="grid size-9 place-items-center rounded-full bg-white/20">{icon}</span>
      <span className="grid leading-tight"><span className="text-[0.65rem] font-bold uppercase tracking-wider text-white/80">{label}</span><span className="font-display text-lg font-bold"><CountUp value={value} format={n => money(n)} duration={900} /></span></span>
      {tone === 'ember' && <div className="embers" aria-hidden="true">{[12, 30, 50, 70, 88].map((x, i) => <i key={i} style={{ '--x': `${x}%`, '--d': `${i * 0.35}s`, '--h': '70px', '--t': '1.8s' } as CSSProperties} />)}</div>}
    </div>
  </div>;
}

function Glass({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0 rounded-2xl bg-white/[0.06] px-4 py-3"><div className="text-[0.7rem] font-bold uppercase tracking-wider text-white/50">{label}</div><div className={`mt-0.5 truncate font-display text-xl font-bold tnum ${tone}`}>{value}</div></div>;
}

type SaleQuote = { available: boolean; amountUsd: number | null; expiresAt: number | null };

/** Collector Crypt's sell-back offer for the card just pulled, signed by the buyer's own wallet. */
function SellBack({ order, onSold }: { order: OrderView; onSold: (o: OrderView) => void }) {
  const { config, me, notify } = useApp();
  const [quote, setQuote] = useState<SaleQuote | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (order.sale) return;
    api<SaleQuote>(`/orders/${order.id}/sell`).then(setQuote).catch(() => setQuote({ available: false, amountUsd: null, expiresAt: null }));
  }, [order.id, order.sale]);
  if (order.sale) return <p className="mt-4 rounded-2xl bg-sky/20 px-4 py-3 text-sm">Sold back for <b>{money(order.sale.amountUsd)}</b>. The USDC is in your wallet.</p>;
  if (!quote?.available || quote.amountUsd === null) return null;
  async function sell() {
    if (busy) return;
    setBusy(true);
    try {
      const practice = config?.mode === 'practice' && !hasSigner();
      if (!practice && me.wallet) await ensureSigner(me.wallet);
      const offer = await api<{ transaction: string; amountUsd: number }>(`/orders/${order.id}/sell`, {});
      const signed = practice ? offer.transaction : await signPayment(offer.transaction);
      onSold(await api<OrderView>(`/orders/${order.id}/sell/submit`, { signed }));
      notify(`Sold for ${money(offer.amountUsd)}.`);
    } catch (e) { notify(friendly(e as Error)); } finally { setBusy(false); }
  }
  const hours = quote.expiresAt ? Math.max(0, Math.round((quote.expiresAt - Date.now()) / 3_600_000)) : null;
  return <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/[0.06] px-4 py-3">
    <span className="text-sm text-white/70">Rather have cash? Collector Crypt buys it back{hours !== null ? ` for ${hours}h more` : ''}.</span>
    <button className="btn btn-sm bg-white text-[#101935]" disabled={busy} onClick={sell}>{busy ? 'Selling…' : `Sell for ${money(quote.amountUsd)}`}</button>
  </div>;
}
