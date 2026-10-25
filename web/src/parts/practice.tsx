import { useState } from 'react';
import { FlaskConical, X } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../app';

/** Practice-mode controls: a round button in the corner that opens a small panel. */
export function PracticeDock() {
  const { refresh, notify, bump, me } = useApp();
  const [open, setOpen] = useState(false);
  const run = async (path: string, body: unknown, message: string) => {
    try { await api(path, body); notify(message); await refresh(); bump(); } catch (e) { notify((e as Error).message); }
  };
  const holder = me.holder?.holder ?? false;
  return <div className="fixed bottom-5 left-5 z-40">
    {open && <div className="panel pop-in absolute bottom-16 left-0 w-[min(20rem,calc(100vw-2.5rem))] origin-bottom-left p-5">
      <div className="flex items-center justify-between"><span className="font-display text-lg font-bold">Practice lab</span><button aria-label="Close" onClick={() => setOpen(false)} className="grid size-8 place-items-center rounded-full bg-soft text-sub"><X size={15} /></button></div>
      <p className="mt-1 text-xs text-sub">Fake balances and a mocked Collector Crypt. No real money.</p>
      <div className="eyebrow mt-4">You are</div>
      <div className="mt-2 grid grid-cols-2 gap-1 rounded-full bg-soft p-1">
        {[[true, 'A holder'], [false, 'Not a holder']].map(([value, label]) => <button key={String(value)} onClick={() => run('/practice/holder', { holder: value }, value ? 'You now hold 1% of supply, held for a month.' : 'You now hold none of the coin.')}
          className={`h-9 rounded-full font-display text-sm font-semibold transition ${holder === value ? 'bg-card text-ink shadow' : 'text-sub'}`}>{label as string}</button>)}
      </div>
      <div className="eyebrow mt-4">Treasury</div>
      <div className="mt-2 grid gap-2">
        <button className="btn btn-soft btn-sm" onClick={() => run('/practice/creator-fees', { usd: 500 }, 'Claimed $500 of creator fees as $CARDS.')}>Claim $500 creator fees</button>
        <div className="grid grid-cols-2 gap-2">
          <button className="btn btn-soft btn-sm" onClick={() => run('/practice/treasury-usdc', { usd: 0 }, 'Treasury USDC set to $0: holder packs pause until it refills.')}>Empty USDC</button>
          <button className="btn btn-soft btn-sm" onClick={() => run('/practice/treasury-usdc', { usd: 1_500 }, 'Treasury USDC set to $1,500.')}>Reset USDC</button>
        </div>
      </div>
    </div>}
    <button onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label="Practice tools" className="grid size-14 place-items-center rounded-full bg-violet text-white shadow-[0_12px_28px_-10px_var(--color-violet)] transition hover:scale-105"><FlaskConical size={22} /></button>
  </div>;
}
