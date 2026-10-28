import { useState, type ReactNode } from 'react';
import { BookOpen, ChevronDown, Flame, HeartHandshake, Landmark, Package } from 'lucide-react';
import { money, pct } from '../api';
import { Link, useApp, useTicker } from '../app';
import { PageHead, Reveal, SplitBar } from '../ui';

const PRICES = [25, 50, 100, 250, 500];

/** How it works: four steps, a calculator to try the rules, and the questions people ask. */
export function HowPage() {
  const { config } = useApp();
  const ticker = useTicker(), s = config?.settings;
  const cap = s?.burnCapBps ?? 5000;

  return <div>
    <PageHead eyebrow={<><BookOpen size={14} />How it works</>} tone="bg-gold-soft text-ink" title={<>Every pull burns.<br />Holders never lose.</>} sub={`Rip a graded Pokémon card pack. The treasury burns ${ticker} worth the card, and if you're a holder and the card's worth less than you paid, you get the difference back.`} />

    <ol className="mt-14 grid gap-5 md:grid-cols-2">
      {[[Package, 'bg-sky text-white', 'Rip a pack', `Pay the pack price in USDC${s?.serviceFeeBps ? ` (plus a ${pct(s.serviceFeeBps)} service fee)` : ''}. Our OPS wallet buys and opens the pack on Collector Crypt, and the graded card NFT lands in your wallet.`],
        [Flame, 'bg-gradient-to-br from-ember to-ember-2 text-white', 'The pull burns', `The treasury buys back ${ticker} worth the card's insured value and burns it, for every pull, holder or not. At most ${pct(cap)} of the free fund goes on one pull.`],
        [HeartHandshake, 'bg-mint text-white', 'Holders get losses back', 'If the card comes in under the pack price, holders get the full difference in USDC as soon as the pull settles. A hit? The card is all yours.'],
        [Landmark, 'bg-violet text-white', 'Creator fees pay for it', `The treasury is the dev wallet. It collects the coin's creator fees in $CARDS. That's the burn fund, and some of it is sold to keep a USDC reserve for repays.`]].map(([Icon, tone, title, text], i) => {
        const I = Icon as typeof Package;
        return <Reveal as="li" key={title as string} delay={i * 0.06} className="panel lift relative overflow-hidden p-7">
          <span className="absolute -right-3 -top-6 font-display text-[7rem] font-bold leading-none text-soft">{i + 1}</span>
          <span className={`relative grid size-14 place-items-center rounded-2xl ${tone}`}><I size={26} /></span>
          <h3 className="relative mt-5 font-display text-2xl font-bold">{title as string}</h3>
          <p className="relative mt-2 text-sub">{text as string}</p>
        </Reveal>;
      })}
    </ol>

    <Reveal className="pt-16"><Calculator cap={cap} /></Reveal>

    <section className="pt-16">
      <h2 className="font-display text-3xl font-bold">Questions</h2>
      <div className="mt-6 grid gap-3">
        <Faq q="Who counts as a holder?">{s?.holderWindowHours
          ? <>Your <b>lowest</b> {ticker} balance over the last {s.holderWindowHours} hours must be at least <b>{s.holderMinTokens.toLocaleString('en-US')} {ticker}</b>, read from the chain when you start an order. Buying right before a pull, or moving a bag between wallets, doesn't count until it has been held for the whole window.</>
          : <>Your wallet holds at least <b>{s ? s.holderMinTokens.toLocaleString('en-US') : '—'} {ticker}</b> when you start an order, read from the chain right then. There's no waiting period: hold it when you rip, and that pack's loss is repaid.</>}</Faq>
        <Faq q="Why would holder packs pause?">Before a holder's pack is bought, its worst-case repay (the full price, as if the card were worth nothing) is set aside from the USDC reserve. If the reserve can't cover that at some price, holder packs at that price wait until creator fees refill it. Everyone else keeps ripping.</Faq>
        <Faq q="When does the burn actually happen?">Right after it settles. Each pull's burn is fixed in $CARDS at that moment, then bought back in one swap into {ticker} and burned, usually within seconds. Every burn is on the <Link href="/burns" className="font-bold text-ember">burn timeline</Link>.</Faq>
        <Faq q="Can the burns run out?">They can get smaller, but they can't empty the fund. One pull never uses more than {pct(cap)} of what's free, so heavy volume shrinks each burn until creator fees top the fund up again.</Faq>
        <Faq q="What if a pack can't be bought?">If Collector Crypt is sold out, or fails before we've paid them, you're refunded in full automatically. If something needs a human, your payment is safe and the order waits for the team.</Faq>
        <Faq q="Is this insurance?">No. Loss repays are a discretionary perk for holders, paid from the treasury under these published rules, not a guarantee. Card values are Collector Crypt's insured values at the time of the pull. Not affiliated with Nintendo, The Pokémon Company or Collector Crypt.</Faq>
      </div>
    </section>
  </div>;
}

/** Try the rules: a pack, a card value, holder or not → the repay and the burn. */
function Calculator({ cap }: { cap: number }) {
  const ticker = useTicker();
  const [price, setPrice] = useState(25), [ratio, setRatio] = useState(0.4), [holder, setHolder] = useState(true), [fund, setFund] = useState(1000);
  const value = Math.round(price * ratio * 100) / 100;
  const repay = holder ? Math.max(0, price - value) : 0, burn = Math.min(value, fund * cap / 10_000);
  return <div className="panel grid gap-8 p-6 sm:p-9 lg:grid-cols-[1fr_1fr]">
    <div>
      <h2 className="font-display text-3xl font-bold">Try it</h2>
      <p className="mt-1 text-sub">Pick a pack and slide the card's value.</p>
      <div className="mt-6 eyebrow">Pack</div>
      <div className="mt-2 flex flex-wrap gap-2">{PRICES.map(p => <button key={p} onClick={() => setPrice(p)} className={`chip h-10 px-4 text-sm ${p === price ? 'bg-ink text-card' : 'bg-soft text-ink'}`}>{money(p)}</button>)}</div>
      <label className="mt-6 block"><span className="eyebrow">Card value · {money(value)}</span>
        <input type="range" min="0" max="3" step="0.01" value={ratio} onChange={e => setRatio(Number(e.target.value))} className="mt-3 w-full accent-[var(--color-ember)]" /></label>
      <label className="mt-6 block"><span className="eyebrow">Free burn fund · {money(fund)}</span>
        <input type="range" min="0" max="5000" step="50" value={fund} onChange={e => setFund(Number(e.target.value))} className="mt-3 w-full accent-[var(--color-ember)]" /></label>
      <div className="mt-6 grid w-fit grid-cols-2 gap-1 rounded-full bg-soft p-1">
        {[[true, 'Holder'], [false, 'Not a holder']].map(([v, label]) => <button key={String(v)} onClick={() => setHolder(v as boolean)} className={`h-10 rounded-full px-4 font-display text-sm font-semibold ${holder === v ? 'bg-card shadow' : 'text-sub'}`}>{label as string}</button>)}
      </div>
    </div>
    <div className="grid content-center gap-4 rounded-[24px] bg-softer p-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-2xl bg-ember-soft p-4"><div className="eyebrow !text-ember">Burns</div><div className="mt-1 font-display text-3xl font-bold tnum">{money(burn)}</div><div className="text-xs text-sub">of {ticker}</div></div>
        <div className="rounded-2xl bg-mint-soft p-4"><div className="eyebrow !text-mint">Repaid</div><div className="mt-1 font-display text-3xl font-bold tnum">{money(repay)}</div><div className="text-xs text-sub">in USDC</div></div>
      </div>
      <SplitBar priceUsd={price} valueUsd={value} repayUsd={repay} />
      <p className="text-sm text-sub">{value >= price ? `A hit: the card beat the ${money(price)} pack, so there's no loss to repay. It still burns ${money(burn)}.`
        : holder ? `You keep a ${money(value)} card and get ${money(repay)} back, so you end up with ${money(price)} in value. The pull burns ${money(burn)}${burn < value ? ` (capped at ${pct(cap)} of the fund)` : ''}.`
        : `You keep a ${money(value)} card. Holders would get ${money(price - value)} back. The pull still burns ${money(burn)}.`}</p>
    </div>
  </div>;
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className="panel overflow-hidden">
    <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left font-display text-lg font-bold">{q}<ChevronDown size={20} className={`shrink-0 transition-transform duration-300 ${open ? 'rotate-180' : ''}`} /></button>
    <div className={`grid transition-[grid-template-rows] duration-300 ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}><div className="overflow-hidden"><p className="px-6 pb-6 text-sub [&_b]:text-ink">{children}</p></div></div>
  </div>;
}
