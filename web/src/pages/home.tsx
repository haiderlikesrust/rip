import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowRight, Check, Flame, HeartHandshake, Minus, Package, Plus, Sparkles } from 'lucide-react';
import type { BurnsView, OrderView, TreasuryView } from '../../../shared/types';
import { api, friendly, money, pct } from '../api';
import { Link, useApp, useTicker } from '../app';
import { ensureSigner, hasSigner, signPayment, signPayments } from '../wallet';
import { useShowcase } from '../showcase';
import { LiveFeed, Ticker } from '../parts/pulls';
import { FINAL, RipOverlay, type BatchSummary, type Pack } from '../parts/rip';
import { CountUp, PackArt, Reveal, Ring, SectionHead, TradingCard, packStyle } from '../ui';

const IN_PROGRESS = ['paying', 'paid', 'buying', 'delivering', 'settling', 'refunding'];
type Batch = { ids: string[]; index: number };
const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export function HomePage() {
  const { me, config, connect, notify, refresh, version, bump } = useApp();
  const ticker = useTicker();
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [packsFailed, setPacksFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [nextPackAt, setNextPackAt] = useState<number | null>(null);
  const now = useNow(!!nextPackAt), waitMs = nextPackAt ? Math.max(0, nextPackAt - now) : 0;
  const [qty, setQty] = useState(1), [maxPerOpen, setMaxPerOpen] = useState(5), count = Math.min(qty, maxPerOpen);
  const [batch, setBatch] = useState<Batch | null>(null), batchRef = useRef<Batch | null>(null);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const toBatch = (b: Batch | null) => { batchRef.current = b; setBatch(b); };
  const [treasury, setTreasury] = useState<TreasuryView | null>(null);
  const [burns, setBurns] = useState<BurnsView | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [opening, setOpening] = useState<Pack | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout>>(undefined);
  const following = useRef<string | null>(null), inFlight = useRef(false), aborted = useRef(false);

  const load = useCallback(() => {
    setPacksFailed(false);
    api<{ packs: Pack[]; nextPackAt: number | null; maxPerOpen?: number }>('/packs').then(r => { setPacks(r.packs); setNextPackAt(r.nextPackAt ?? null); setMaxPerOpen(r.maxPerOpen ?? 1); }).catch(() => setPacksFailed(true));
    api<TreasuryView>('/treasury').then(setTreasury).catch(() => {});
    api<BurnsView>('/burns').then(setBurns).catch(() => {});
  }, []);
  useEffect(load, [load, version, me.wallet]);
  useEffect(() => () => { following.current = null; clearTimeout(poll.current); }, []);

  /** Polls one order, one request at a time. A reply for an order we stopped following is dropped. */
  function follow(id: string) {
    clearTimeout(poll.current); following.current = id;
    const tick = async () => {
      try {
        const next = await api<OrderView>(`/orders/${id}`);
        if (following.current !== id) return;
        setOrder(next);
        if (FINAL.includes(next.status)) {
          following.current = null; bump(); refresh().catch(() => {});
          const b = batchRef.current;
          if (b && b.index === b.ids.length - 1) Promise.all(b.ids.map(o => api<OrderView>(`/orders/${o}`))).then(all => { if (batchRef.current === b) setSummary(sum(all)); }).catch(() => {});
          return;
        }
      } catch (e) {
        if (following.current !== id) return;
        const status = (e as { status?: number }).status;
        if (status === 401 || status === 404) { following.current = null; notify('This order can no longer be followed here. Its result shows in your binder.'); return; }
      }
      poll.current = setTimeout(tick, 900);
    };
    poll.current = setTimeout(tick, 400);
  }

  /** Opens `count` packs of one machine: one wallet approval for all the payments, then the reveals one by one. */
  async function open(pack: Pack, count = 1) {
    if (!me.wallet) return connect();
    if (inFlight.current) return;
    inFlight.current = true; aborted.current = false;
    setOpening(pack); setOrder(null); toBatch(null); setSummary(null);
    let unpaid: string[] = [];
    try {
      const practice = config?.mode === 'practice' && !hasSigner();
      if (!practice) {
        try { await ensureSigner(me.wallet); }
        catch (e) { notify((e as Error).message); if ((e as { reconnect?: boolean }).reconnect) connect(); setOpening(null); return; }
      }
      if (aborted.current) return;
      const created = await api<{ orders: OrderView[]; transactions: string[] }>('/orders', { code: pack.code, count });
      unpaid = created.orders.map(o => o.id);
      if (aborted.current) return;
      setOrder(created.orders[0]);
      const signed = practice ? created.orders.map(() => 'practice') : count > 1 ? await signPayments(created.transactions) : [await signPayment(created.transactions[0])];
      if (aborted.current) return;
      // Pay in order; if one is refused (the repay reserve ran low), the rest are released, not charged.
      const paid: string[] = []; let refused: Error | null = null;
      for (const [i, o] of created.orders.entries()) {
        try { const view = await api<OrderView>(`/orders/${o.id}/pay`, { signed: signed[i] }); if (!paid.length) setOrder(view); }
        catch (e) {
          // A dropped connection can hide a payment that was sent: check before calling it a failure.
          const check = await api<OrderView>(`/orders/${o.id}`).catch(() => null);
          if (!check || check.status === 'awaiting_payment') { refused = e as Error; break; }
          if (!paid.length) setOrder(check);
        }
        paid.push(o.id); unpaid = unpaid.filter(id => id !== o.id);
      }
      if (!paid.length) throw refused ?? new Error('The payment did not go through. Nothing was charged.');
      if (refused) notify(`Opened ${paid.length} of ${count}. ${friendly(refused)} Nothing was charged for the rest.`);
      if (paid.length > 1) toBatch({ ids: paid, index: 0 });
      follow(paid[0]);
    } catch (e) {
      if (!aborted.current) { notify(friendly(e as Error)); setOpening(null); setOrder(null); load(); }
    } finally {
      for (const id of unpaid) await api(`/orders/${id}/cancel`, {}).catch(() => {});
      inFlight.current = false;
    }
  }

  async function nextInBatch() {
    const b = batchRef.current;
    if (!b || b.index >= b.ids.length - 1) return;
    const nb = { ids: b.ids, index: b.index + 1 }, id = nb.ids[nb.index];
    const view = await api<OrderView>(`/orders/${id}`).catch(() => null);
    toBatch(nb);
    if (view) setOrder(view);
    follow(id);
  }

  const close = () => {
    const running = !!order && IN_PROGRESS.includes(order.status);
    const others = batchRef.current ? batchRef.current.ids.length - batchRef.current.index - 1 : 0;
    aborted.current = true; following.current = null; clearTimeout(poll.current);
    setOpening(null); setOrder(null); toBatch(null); setSummary(null);
    if (running || others) notify(`Your ${others ? 'packs keep' : 'pack keeps'} ripping in the background. Find ${others ? 'them' : 'it'} in your binder.`);
    load();
  };

  const s = config?.settings, holder = me.holder?.holder ?? false;
  const pick = packs?.find(p => p.code === selected) ?? packs?.[0] ?? null;

  return <>
    <Hero burns={burns} treasury={treasury} />
    <Ticker />

    {/* Counters */}
    <Reveal className="panel mt-6 grid grid-cols-2 gap-y-6 p-6 sm:p-8 lg:grid-cols-4">
      <Counter tone="text-ember" icon={<Flame size={18} />} label="Burned in buybacks" value={burns?.totals.usd ?? 0} money />
      <Counter tone="text-ember" icon={<Sparkles size={18} />} label={`${ticker} gone forever`} value={Number(burns?.totals.coinBurned ?? 0)} compact />
      <Counter tone="text-mint" icon={<HeartHandshake size={18} />} label="Repaid to holders" value={treasury?.totals.repaidUsd ?? 0} money />
      <Counter tone="text-sky" icon={<Package size={18} />} label="Packs ripped" value={treasury?.totals.packsOpened ?? 0} />
    </Reveal>

    {/* Pick and rip */}
    <section id="rip" className="scroll-mt-24 pt-20">
      <SectionHead title="Choose a pack" sub={holder ? 'You\'re a holder: every loss comes back to you in USDC.' : 'Every pull burns supply. Holders also get their losses back.'} />
      {packsFailed && <div className="panel flex flex-wrap items-center justify-between gap-3 p-5"><span>Couldn't load the packs. Collector Crypt may be slow right now.</span><button className="btn btn-ghost btn-sm" onClick={load}>Try again</button></div>}
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="no-scrollbar -mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-3 lg:overflow-visible lg:px-0">
          {!packs && !packsFailed && Array.from({ length: 6 }, (_, i) => <div key={i} className="h-64 w-44 shrink-0 animate-pulse rounded-[28px] bg-soft lg:w-auto" />)}
          {packs?.map((p, i) => {
            const st = packStyle(p.code, p.priceUsd), on = pick?.code === p.code;
            return <button key={p.code} onClick={() => setSelected(p.code)} aria-pressed={on} style={{ '--c': st.color, animationDelay: `${i * 50}ms` } as CSSProperties}
              className={`fade-up group relative w-44 shrink-0 snap-start rounded-[28px] bg-card p-3 text-left shadow-[var(--shadow-soft)] transition duration-300 hover:-translate-y-1 lg:w-auto ${on ? 'ring-[3px] ring-[var(--c)]' : ''}`}>
              <div className="rounded-[22px] p-2" style={{ background: `color-mix(in srgb, ${st.color} 12%, transparent)` }}><PackArt code={p.code} priceUsd={p.priceUsd} className="transition-transform duration-500 group-hover:scale-105 group-hover:-rotate-2" /></div>
              <div className="mt-3 flex items-baseline justify-between gap-2 px-1"><span className="font-display text-lg font-bold">{st.name}</span><span className="font-display font-bold tnum">{money(p.priceUsd)}</span></div>
              {!p.quote.open && me.wallet && <span className="mt-1 block px-1 text-xs font-bold text-ember">Paused for holders</span>}
              {on && <span className="absolute right-4 top-4 grid size-7 place-items-center rounded-full text-white" style={{ background: st.color }}><Check size={15} /></span>}
            </button>;
          })}
        </div>
        {pick && <PackPanel pack={pick} signedIn={!!me.wallet} busy={!!opening} waitMs={waitMs} count={count} max={maxPerOpen} setQty={setQty} onRip={() => open(pick, count)} capBps={s?.burnCapBps ?? 5000} />}
      </div>
    </section>

    {/* Status and live feed */}
    <section className="grid gap-6 pt-20 lg:grid-cols-[380px_1fr]">
      <Reveal><HolderCard /></Reveal>
      <Reveal delay={0.08} className="panel p-6 sm:p-7">
        <div className="mb-5 flex items-center justify-between"><h2 className="flex items-center gap-2.5 font-display text-2xl font-bold"><span className="pulse-dot" />Live rips</h2><Link href="/pulls" className="font-display text-sm font-semibold text-sub hover:text-ink">Your binder →</Link></div>
        <LiveFeed />
      </Reveal>
    </section>

    {/* The loop */}
    <section className="pt-20">
      <SectionHead title="One rip. Two good things." action={<Link href="/how" className="btn btn-ghost btn-sm">How it works<ArrowRight size={15} /></Link>} />
      <div className="grid gap-5 md:grid-cols-3">
        {[[Package, 'bg-sky-soft text-sky', 'You rip a real pack', 'Pay in USDC. We buy and open a graded Pokémon card pack on Collector Crypt, and the card NFT lands in your wallet.'],
          [Flame, 'bg-ember-soft text-ember', 'The pull burns supply', `Creator fees buy back ${ticker} worth your card's insured value, then burn it. Capped at ${s ? pct(s.burnCapBps) : 'a share'} of the fund per pull.`],
          [HeartHandshake, 'bg-mint-soft text-mint', 'Holders never take an L', 'Card worth less than the pack? Holders get the whole difference back in USDC, straight away.']].map(([Icon, tone, title, text], i) => {
          const I = Icon as typeof Package;
          return <Reveal key={title as string} delay={i * 0.08} className="panel lift p-7">
            <span className={`grid size-14 place-items-center rounded-2xl ${tone}`}><I size={26} /></span>
            <h3 className="mt-5 font-display text-xl font-bold">{title as string}</h3>
            <p className="mt-2 text-sub">{text as string}</p>
          </Reveal>;
        })}
      </div>
    </section>

    {opening && <RipOverlay pack={opening} order={order} batch={batch ? { index: batch.index, count: batch.ids.length } : null} summary={summary}
      onNext={nextInBatch} onUpdate={setOrder} onClose={close}
      onAgain={() => { const p = packs?.find(x => x.code === opening.code) ?? opening, n = batch ? batch.ids.length : 1; close(); setTimeout(() => open(p, n), 60); }} />}
  </>;
}

/** The opening: a big rounded headline and a fan of floating cards. */
function Hero({ burns, treasury }: { burns: BurnsView | null; treasury: TreasuryView | null }) {
  const ticker = useTicker(), showcase = useShowcase();
  // Real recent pulls from Collector Crypt, the most valuable in the middle. Until they load, the fan shows card backs.
  const real = showcase ? [...showcase.hero, ...(showcase.example ? [showcase.example] : [])] : [];
  const at = (i: number) => real[i] ? { name: real[i].name, image: real[i].image, insuredValueUsd: real[i].insuredValueUsd } : null;
  const fan = [
    { card: at(1), r: '-14deg', x: '-62%', delay: '0s' },
    { card: at(0), r: '0deg', x: '0%', delay: '-2s' },
    { card: at(2), r: '14deg', x: '62%', delay: '-4s' },
  ];
  return <section className="grid items-center gap-12 pt-10 sm:pt-16 lg:grid-cols-[1.1fr_1fr]">
    <div className="fade-up text-center lg:text-left">
      <span className="chip bg-card text-ink shadow-[var(--shadow-soft)]"><span className="pulse-dot" />Every pull burns {ticker}</span>
      <h1 className="mt-6 font-display text-[3.1rem] font-bold leading-[0.98] tracking-tight sm:text-7xl">Rip a pack.<br /><span className="text-burn">Burn the supply.</span></h1>
      <p className="mx-auto mt-6 max-w-xl text-lg text-sub lg:mx-0">Open graded Pokémon card packs on Solana. Each pull buys back and burns {ticker} worth the card you got, and holders get every loss repaid in USDC.</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3 lg:justify-start">
        <a href="#rip" className="btn btn-ember h-14 px-8 text-lg">Start ripping<ArrowRight size={19} /></a>
        <Link href="/burns" className="btn btn-ghost h-14 px-7 text-lg">See the burns</Link>
      </div>
    </div>
    <div className="relative mx-auto h-[360px] w-full max-w-[460px] sm:h-[420px]">
      {fan.map((f, i) => <div key={i} className="absolute left-1/2 top-6 w-[160px] sm:w-[190px]" style={{ translate: `calc(${f.x} - 50%) 0`, zIndex: i === 1 ? 2 : 1 }}>
        <div className="animate-[var(--animate-float)]" style={{ '--r': f.r, animationDelay: f.delay } as CSSProperties}><TradingCard card={f.card ?? { name: 'Card', image: null, insuredValueUsd: null }} flipped={!f.card} tilt={!!f.card} foil={0.45} /></div>
      </div>)}
      {burns && <Bubble className="left-0 top-[64%]" tone="bg-gradient-to-r from-ember to-ember-2 text-white" icon={<Flame size={15} />} text={`${money(burns.totals.usd)} burned`} delay="-1s" />}
      {treasury && <Bubble className="right-0 top-[8%]" tone="bg-mint text-white" icon={<HeartHandshake size={15} />} text={`${money(treasury.totals.repaidUsd)} repaid`} delay="-3s" />}
    </div>
  </section>;
}

function Bubble({ className, tone, icon, text, delay }: { className: string; tone: string; icon: React.ReactNode; text: string; delay: string }) {
  return <div className={`absolute z-10 ${className}`}><div className={`chip h-10 animate-[var(--animate-float)] px-4 text-sm shadow-[var(--shadow-lift)] ${tone}`} style={{ animationDelay: delay } as CSSProperties}>{icon}{text}</div></div>;
}

function Counter({ icon, tone, label, value, money: isMoney, compact: isCompact }: { icon: React.ReactNode; tone: string; label: string; value: number; money?: boolean; compact?: boolean }) {
  return <div className="min-w-0 px-2 text-center sm:text-left">
    <div className={`flex items-center justify-center gap-1.5 sm:justify-start ${tone}`}>{icon}<span className="eyebrow !text-current">{label}</span></div>
    <div className="mt-1 truncate font-display text-3xl font-bold sm:text-4xl"><CountUp value={value} format={n => isMoney ? money(n) : isCompact ? compact(n) : Math.round(n).toLocaleString('en-US')} /></div>
  </div>;
}

/** The selected pack: big art, what happens when you rip it, how many, and the button. */
function PackPanel({ pack, signedIn, busy, waitMs, count, max, setQty, onRip, capBps }: { pack: Pack; signedIn: boolean; busy: boolean; waitMs: number; count: number; max: number; setQty: (n: number) => void; onRip: () => void; capBps: number }) {
  const ticker = useTicker(), q = pack.quote, st = packStyle(pack.code, pack.priceUsd);
  const cooling = signedIn && waitMs > 0, blocked = signedIn && (!q.open || cooling);
  return <aside key={pack.code} className="panel fade-up h-fit p-6 lg:sticky lg:top-24" style={{ '--c': st.color } as CSSProperties}>
    <div className="relative rounded-[22px] p-4" style={{ background: `radial-gradient(circle at 50% 40%, color-mix(in srgb, ${st.color} 28%, transparent), transparent 70%)` }}>
      <PackArt code={pack.code} priceUsd={pack.priceUsd} className="pack-idle mx-auto max-w-[220px]" />
    </div>
    <div className="mt-2 flex items-end justify-between gap-3">
      <div><div className="eyebrow">{st.item === 'watch' ? 'Luxury watch pack' : 'Graded card pack'}</div><h3 className="font-display text-3xl font-bold">{st.name}</h3></div>
      <div className="text-right font-display text-3xl font-bold tnum">{money(q.totalMicros * count / 1e6)}</div>
    </div>
    <ul className="mt-5 grid gap-2.5 text-sm">
      <li className="flex gap-3 rounded-2xl bg-ember-soft p-3"><Flame size={18} className="mt-0.5 shrink-0 text-ember" /><span><b>Burns {ticker}</b> worth the card's insured value (up to {pct(capBps)} of the fund per pull).</span></li>
      <li className={`flex gap-3 rounded-2xl p-3 ${q.holder ? 'bg-mint-soft' : 'bg-soft'}`}><HeartHandshake size={18} className={`mt-0.5 shrink-0 ${q.holder ? 'text-mint' : 'text-dim'}`} /><span>{q.holder ? <><b>Your loss is repaid 100%</b> in USDC if the card comes in under {money(pack.priceUsd)}.</> : signedIn ? <>Hold {ticker} to get losses repaid. You still burn supply either way.</> : <>Holders get every loss repaid in USDC.</>}</span></li>
      {q.feeMicros > 0 && <li className="px-3 text-xs text-sub">Includes a {money(q.feeMicros / 1e6)} service fee per pack, which goes to the treasury.</li>}
    </ul>
    {signedIn && !q.open && <p className="mt-4 rounded-2xl bg-gold-soft p-3 text-sm font-semibold">{q.reason}</p>}
    <div className="mt-5 flex items-center gap-3">
      <div className="flex items-center rounded-full bg-soft p-1" aria-label="Packs to rip">
        <button className="grid size-10 place-items-center rounded-full hover:bg-card disabled:opacity-30" disabled={count <= 1} onClick={() => setQty(Math.max(1, count - 1))} aria-label="One fewer"><Minus size={16} /></button>
        <span className="w-8 text-center font-display text-lg font-bold tnum" aria-live="polite">{count}</span>
        <button className="grid size-10 place-items-center rounded-full hover:bg-card disabled:opacity-30" disabled={count >= max} onClick={() => setQty(Math.min(max, count + 1))} aria-label="One more"><Plus size={16} /></button>
      </div>
      <button className="btn btn-ember h-14 flex-1 text-lg" disabled={busy || blocked} onClick={onRip}>
        {cooling ? <>Next in <span className="tnum">{clock(waitMs)}</span></> : signedIn ? <>Rip {count > 1 ? `${count} packs` : 'it'}<ArrowRight size={18} /></> : 'Connect to rip'}
      </button>
    </div>
  </aside>;
}

/** Your holder status as a ring: lowest balance over the window against the minimum. */
function HolderCard() {
  const { me, connect, config } = useApp();
  const ticker = useTicker(), h = me.holder, s = config?.settings;
  const required = Number(h?.required ?? s?.holderMinTokens ?? 0), lowest = Number(h?.lowest ?? 0), share = required > 0 ? Math.min(1, lowest / required) : 0;
  return <div className="panel h-full p-6 sm:p-7">
    <h2 className="font-display text-2xl font-bold">Your status</h2>
    <div className="mt-5 flex items-center gap-5">
      <Ring value={me.wallet ? share : 0} size={128} stroke={12} color={h?.holder ? 'var(--color-mint)' : 'var(--color-gold)'}>
        <div><div className="font-display text-2xl font-bold">{me.wallet ? `${Math.round(share * 100)}%` : '—'}</div><div className="text-[0.7rem] font-bold uppercase tracking-wider text-sub">of the line</div></div>
      </Ring>
      <div className="min-w-0">
        {!me.wallet ? <><p className="font-display text-lg font-bold">Connect to check</p><p className="mt-1 text-sm text-sub">Holders get every loss repaid in USDC.</p><button className="btn btn-ink btn-sm mt-3" onClick={connect}>Connect</button></>
          : h?.holder ? <><p className="flex items-center gap-1.5 font-display text-lg font-bold text-mint"><Check size={18} />You're a holder</p><p className="mt-1 text-sm text-sub">Losses on your packs come back 100%.</p></>
          : <><p className="font-display text-lg font-bold">Not a holder yet</p><p className="mt-1 text-sm text-sub">Hold {required.toLocaleString('en-US')} {ticker}{h?.windowHours ? ` for ${h.windowHours}h` : ''}. Your lowest balance counts.</p></>}
      </div>
    </div>
    {me.wallet && h && <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
      <div className="rounded-2xl bg-softer p-3"><div className="eyebrow">Balance</div><div className="font-display text-lg font-bold tnum">{compact(Number(h.balance))}</div></div>
      <div className="rounded-2xl bg-softer p-3"><div className="eyebrow">Needed</div><div className="font-display text-lg font-bold tnum">{compact(required)}</div></div>
    </div>}
  </div>;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** "4:05" or "1:02:09". */
const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

/** What a batch came to: refunded packs cost nothing, so they are left out of the totals. */
function sum(orders: OrderView[]): BatchSummary {
  const kept = orders.filter(o => o.status !== 'refunded' && o.status !== 'expired');
  const add = (f: (o: OrderView) => number | null | undefined) => Math.round(kept.reduce((t, o) => t + (f(o) ?? 0), 0) * 100) / 100;
  return { packs: orders.length, paidUsd: add(o => o.totalUsd), valueUsd: add(o => o.valueUsd), repaidUsd: add(o => o.repayUsd), burnUsd: add(o => o.burn?.usd), refunded: orders.length - kept.length };
}
