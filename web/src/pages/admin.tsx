import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Flame, Fuel, Gauge, HeartHandshake, Package, Plus, ScrollText, Shuffle, Trash2, TriangleAlert } from 'lucide-react';
import type { Settings } from '../../../shared/types';
import { SELLING } from '../../../shared/packs';
import { api, money, pct } from '../api';
import { useApp, useTicker } from '../app';
import { Empty, packStyle } from '../ui';

type Gas = { opsSol: number; treasurySol: number; spentTodayUsd: number; opsReady: boolean; opsUsdcAccount: boolean; treasuryUsdcAccount: boolean };
type Admin = { settings: Settings; version: string; gas: Gas | null; blockers: string[]; review: any[]; delayed: any[]; burnReview: any[]; jobs: any[]; audit: any[] };
const TABS = [['overview', 'Overview', Gauge], ['burn', 'Burns', Flame], ['repay', 'Repays', HeartHandshake], ['packs', 'Packs', Package], ['swaps', 'Fees & swaps', Shuffle], ['gas', 'Network fees', Fuel], ['attention', 'Attention', TriangleAlert], ['audit', 'Audit log', ScrollText]] as const;
type Tab = typeof TABS[number][0];

export function AdminPage() {
  const { me, notify, connect, version, refresh } = useApp();
  const ticker = useTicker();
  const [data, setData] = useState<Admin | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  // Reloading after an action keeps any unsaved edits; only a fresh load or a save resets the form.
  const load = (resetForm = true) => api<Admin>('/admin').then(d => { setData(d); if (resetForm) setForm(d.settings); }).catch(e => notify(e.message));
  useEffect(() => { if (me.owner) load(); }, [me.owner, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me.owner) return <div className="pt-16"><Empty title="Owner access only" text="Sign in with the owner wallet to manage the treasury and burns." action={<button className="btn btn-ink" onClick={connect}>Connect wallet</button>} /></div>;
  if (!data || !form) return <div className="py-24 text-center font-display text-sub">Loading…</div>;

  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm({ ...form, [key]: value });
  const n = (v: string) => Number(v);
  async function save() {
    if (saving) return;
    setSaving(true);
    try { await api('/admin/settings', form, 'PATCH', { 'If-Match': data!.version }); notify('Settings saved.'); await load(); await refresh(); } catch (e) { notify((e as Error).message); } finally { setSaving(false); }
  }
  async function act(path: string, body: unknown, message: string) { try { await api(path, body); notify(message); await load(false); } catch (e) { notify((e as Error).message); } }
  const attention = data.burnReview.length + data.delayed.length + data.review.length;

  return <div className="pt-10 sm:pt-14">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><span className="chip bg-ink text-card">Owner</span><h1 className="mt-3 font-display text-4xl font-bold sm:text-5xl">Control room</h1></div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-ghost" onClick={() => act('/admin/treasury/run', {}, 'Claimed creator fees, forwarded service fees and refilled the repay reserve.')}>Run treasury tasks</button>
        <button className="btn btn-ember" onClick={() => act('/admin/burns/run', {}, 'Ran the queued burns.')}><Flame size={17} />Burn queued now</button>
      </div>
    </div>

    <div className="mt-8 grid gap-6 lg:grid-cols-[220px_1fr]">
      <nav aria-label="Admin sections" className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 lg:sticky lg:top-24 lg:mx-0 lg:h-fit lg:flex-col lg:px-0">
        {TABS.map(([id, label, Icon]) => <button key={id} onClick={() => setTab(id)} aria-current={tab === id}
          className={`flex shrink-0 items-center gap-2.5 rounded-2xl px-4 py-3 text-left font-display font-semibold transition ${tab === id ? 'bg-card text-ink shadow-[var(--shadow-soft)]' : 'text-sub hover:bg-card/60'}`}>
          <Icon size={17} />{label}{id === 'attention' && attention > 0 && <span className="ml-auto grid size-6 place-items-center rounded-full bg-ember text-xs text-white">{attention}</span>}
        </button>)}
      </nav>

      <div className="fade-up min-w-0" key={tab}>
        {tab === 'overview' && <Card title="Launch readiness">
          <ul className="grid gap-2.5">
            {data.blockers.map(b => <li key={b} className="flex items-center gap-2.5 rounded-2xl bg-gold-soft px-4 py-3 text-sm font-semibold"><AlertTriangle size={16} className="shrink-0 text-ember" />{b}</li>)}
            {!data.blockers.length && <li className="flex items-center gap-2.5 rounded-2xl bg-mint-soft px-4 py-3 font-semibold text-mint"><CheckCircle2 size={16} />Ready for mainnet.</li>}
          </ul>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <Mini label="Burn cap" value={pct(form.burnCapBps)} /><Mini label="Holder line" value={`${form.holderMinTokens.toLocaleString('en-US')} ${ticker}`} /><Mini label="Reserve target" value={money(form.usdcReserveTargetUsd)} />
          </div>
          <div className="mt-6"><Toggle checked={form.paused} danger onChange={v => set('paused', v)} label={form.paused ? 'Paused: no new packs, repays or burns' : 'Running'} /></div>
        </Card>}

        {tab === 'burn' && <Card title="Buyback & burn" sub={`Each pull burns min(insured value, ${pct(form.burnCapBps)} of the free $CARDS fund) of ${ticker}, bought in one swap right after the pull settles.`}>
          <Grid>
            <Field label="Burn cap X %" hint="Most of the free fund one pull may use"><input className="field tnum" type="number" step="5" min="0" max="100" value={form.burnCapBps / 100} onChange={e => set('burnCapBps', Math.round(n(e.target.value) * 100))} /></Field>
          </Grid>
        </Card>}

        {tab === 'repay' && <Card title="Holder repays" sub="Holders get 100% of any loss (pack price − insured value) back in USDC. Holder packs pause at prices free USDC can't cover.">
          <Grid>
            <Field label={`Hold at least (${ticker})`} hint="Whole coins. 0 switches repays off"><input className="field tnum" type="number" value={form.holderMinTokens} onChange={e => set('holderMinTokens', n(e.target.value))} /></Field>
            <Field label="Held for (hours)" hint="Lowest balance over this window. 0 = balance now"><input className="field tnum" type="number" value={form.holderWindowHours} onChange={e => set('holderWindowHours', n(e.target.value))} /></Field>
            <Field label="USDC reserve target $" hint="$CARDS is sold to refill up to this before burns"><input className="field tnum" type="number" value={form.usdcReserveTargetUsd} onChange={e => set('usdcReserveTargetUsd', n(e.target.value))} /></Field>
          </Grid>
        </Card>}

        {tab === 'packs' && <Card title="Packs and pricing">
          <Grid>
            <Field label="Service fee %" hint="On top of the price, sent to the treasury. 0 = none"><input className="field tnum" type="number" step="0.5" value={form.serviceFeeBps / 100} onChange={e => set('serviceFeeBps', Math.round(n(e.target.value) * 100))} /></Field>
            <Field label="Cooldown minutes" hint="Between packs per wallet. 0 = none"><input className="field tnum" type="number" value={form.cooldown.minutes} onChange={e => set('cooldown', { ...form.cooldown, minutes: n(e.target.value) })} /></Field>
          </Grid>
          <div className="eyebrow mt-7">On sale (tap to pause)</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {SELLING.map(p => { const off = form.pausedPacks.includes(p.code), st = packStyle(p.code, p.priceUsd); return <button key={p.code} onClick={() => set('pausedPacks', off ? form.pausedPacks.filter(c => c !== p.code) : [...form.pausedPacks, p.code])} className={`chip h-10 px-4 ${off ? 'bg-ember-soft text-ember line-through' : 'bg-soft text-ink'}`}>
              <i className="size-2.5 rounded-full" style={{ background: st.color }} />{st.name} {money(p.priceUsd)}
            </button>; })}
          </div>
          <div className="eyebrow mt-7">Cooldown exceptions</div>
          <div className="mt-3 grid gap-2">
            {form.cooldown.wallets.map((w, i) => <div key={i} className="flex flex-wrap gap-2">
              <input className="field tnum min-w-0 flex-1" placeholder="Wallet address" value={w.wallet} onChange={e => set('cooldown', { ...form.cooldown, wallets: form.cooldown.wallets.map((x, j) => j === i ? { ...x, wallet: e.target.value } : x) })} />
              <input className="field tnum w-28" type="number" value={w.minutes} onChange={e => set('cooldown', { ...form.cooldown, wallets: form.cooldown.wallets.map((x, j) => j === i ? { ...x, minutes: n(e.target.value) } : x) })} />
              <button className="btn btn-soft btn-sm h-[2.9rem]" aria-label="Remove" onClick={() => set('cooldown', { ...form.cooldown, wallets: form.cooldown.wallets.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>
            </div>)}
            <button className="btn btn-soft btn-sm w-fit" onClick={() => set('cooldown', { ...form.cooldown, wallets: [...form.cooldown.wallets, { wallet: '', minutes: 0 }] })}><Plus size={15} />Add wallet</button>
          </div>
        </Card>}

        {tab === 'swaps' && <Card title="Creator fees and swaps">
          <Grid cols="sm:grid-cols-2">
            <Field label="Claim creator fees at $" hint="Claimed once this much has built up"><input className="field tnum" type="number" value={form.creatorFeeMinUsd} onChange={e => set('creatorFeeMinUsd', n(e.target.value))} /></Field>
            <Field label="Max price impact %" hint="$CARDS sales above this are split into parts. Buybacks never are"><input className="field tnum" type="number" step="0.5" value={form.maxPriceImpactBps / 100} onChange={e => set('maxPriceImpactBps', Math.round(n(e.target.value) * 100))} /></Field>
            <Field label="Slippage %"><input className="field tnum" type="number" step="0.1" value={form.slippageBps / 100} onChange={e => set('slippageBps', Math.round(n(e.target.value) * 100))} /></Field>
            <Field label="Forward service fees at $" hint="OPS → treasury"><input className="field tnum" type="number" value={form.feeTransferThresholdUsd} onChange={e => set('feeTransferThresholdUsd', n(e.target.value))} /></Field>
          </Grid>
        </Card>}

        {tab === 'gas' && <Card title="Network fees" sub="TREASURY tops OPS up with SOL, and buys SOL with a little USDC when it runs low itself.">
          {data.gas && <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <Mini label="OPS" value={`${data.gas.opsSol.toFixed(4)} SOL`} warn={!data.gas.opsReady || !data.gas.opsUsdcAccount} note={!data.gas.opsUsdcAccount ? 'No USDC account yet' : undefined} />
            <Mini label="TREASURY" value={`${data.gas.treasurySol.toFixed(4)} SOL`} warn={data.gas.treasurySol < form.gas.treasuryMinSol || !data.gas.treasuryUsdcAccount} note={!data.gas.treasuryUsdcAccount ? 'No USDC account yet' : undefined} />
            <Mini label="SOL bought today" value={money(data.gas.spentTodayUsd)} />
          </div>}
          <Grid>
            <Field label="Reserve SOL"><input className="field tnum" type="number" step="0.01" value={form.gasReserveSol} onChange={e => set('gasReserveSol', n(e.target.value))} /></Field>
            <Field label="OPS top-up below"><input className="field tnum" type="number" step="0.01" value={form.gas.opsMinSol} onChange={e => set('gas', { ...form.gas, opsMinSol: n(e.target.value) })} /></Field>
            <Field label="OPS refill to"><input className="field tnum" type="number" step="0.01" value={form.gas.opsTargetSol} onChange={e => set('gas', { ...form.gas, opsTargetSol: n(e.target.value) })} /></Field>
            <Field label="TREASURY keeps"><input className="field tnum" type="number" step="0.01" value={form.gas.treasuryMinSol} onChange={e => set('gas', { ...form.gas, treasuryMinSol: n(e.target.value) })} /></Field>
            <Field label="Buy SOL with $"><input className="field tnum" type="number" value={form.gas.buyUsd} onChange={e => set('gas', { ...form.gas, buyUsd: n(e.target.value) })} /></Field>
            <Field label="Max $ a day" hint="0 = never buy"><input className="field tnum" type="number" value={form.gas.maxUsdPerDay} onChange={e => set('gas', { ...form.gas, maxUsdPerDay: n(e.target.value) })} /></Field>
          </Grid>
          <button className="btn btn-soft btn-sm mt-5" onClick={() => act('/admin/gas/run', {}, 'Checked network fee balances.')}>Top up now</button>
        </Card>}

        {tab === 'attention' && <div className="grid gap-6">
          <Card title="Stuck burns" sub="A burn that keeps failing waits here. Its swap and burn resume as the same jobs.">
            {data.burnReview.length ? <Rows>{data.burnReview.map(b => <Item key={b.id} tag={b.status} tone="bg-ember-soft text-ember" id={b.id.slice(11, 19)} error={b.error} extra={`${money(Number(b.usd_micros) / 1e6)} · ${b.pulls} pulls`}>
              {b.status === 'review' && <button className="btn btn-soft btn-sm" onClick={() => act(`/admin/burns/${b.id}/retry`, {}, 'The burn will retry.')}>Retry</button>}
            </Item>)}</Rows> : <Quiet>All burns are flowing.</Quiet>}
          </Card>
          <Card title="Delayed orders" sub="Paid orders retrying on their own, waiting longer each time. After about 3 hours of failures they move to review.">
            {data.delayed.length ? <Rows>{data.delayed.map(o => <Item key={o.id} tag={o.status} tone="bg-gold-soft text-ink" id={o.id.slice(0, 8)} error={o.error} extra={`${o.failures} attempt${o.failures === 1 ? '' : 's'}`}>
              <button className="btn btn-soft btn-sm" onClick={() => act(`/admin/orders/${o.id}/retry-now`, {}, 'Retrying on the next pass.')}>Retry now</button>
            </Item>)}</Rows> : <Quiet>Nothing delayed.</Quiet>}
          </Card>
          <Card title="Needs review">
            {data.review.length ? <Rows>{data.review.map(o => <Item key={o.id} tag="review" tone="bg-ember-soft text-ember" id={o.id.slice(0, 8)} error={o.error}>
              <button className="btn btn-soft btn-sm" onClick={() => act(`/admin/orders/${o.id}/resolve`, { action: 'retry' }, 'Retrying.')}>Retry</button>
              <button className="btn btn-soft btn-sm" onClick={() => act(`/admin/orders/${o.id}/resolve`, { action: 'refund' }, 'Refund queued.')}>Refund</button>
            </Item>)}</Rows> : <Quiet>Nothing stuck.</Quiet>}
          </Card>
        </div>}

        {tab === 'audit' && <Card title="Audit log">
          <div className="max-h-[32rem] overflow-auto text-xs">{data.audit.map(a => <div key={a.id} className="grid gap-1 border-b border-edge py-2.5 last:border-0 sm:grid-cols-[10rem_10rem_1fr]">
            <span className="tnum text-dim">{new Date(Number(a.created_at)).toLocaleString()}</span><b>{a.event}</b><code className="tnum truncate text-sub">{JSON.stringify(a.data)}</code>
          </div>)}</div>
        </Card>}
      </div>
    </div>

    {dirty && <div className="fade-up fixed inset-x-4 bottom-5 z-30 mx-auto flex w-fit items-center gap-2 rounded-full bg-ink py-2 pl-6 pr-2 text-sm font-semibold text-card shadow-[var(--shadow-lift)]">
      Unsaved changes<button className="btn btn-sm bg-white/10 text-card" disabled={saving} onClick={() => setForm(data.settings)}>Discard</button><button className="btn btn-ember btn-sm" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
    </div>}
  </div>;
}

function Card({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return <section className="panel min-w-0 p-6 sm:p-8"><h2 className="font-display text-2xl font-bold">{title}</h2>{sub && <p className="mt-1 text-sub">{sub}</p>}<div className="mt-6">{children}</div></section>;
}
function Grid({ children, cols = 'sm:grid-cols-3' }: { children: ReactNode; cols?: string }) { return <div className={`grid gap-5 ${cols}`}>{children}</div>; }
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid content-start gap-1.5"><span className="font-display text-sm font-semibold">{label}</span>{children}{hint && <span className="text-xs text-sub">{hint}</span>}</label>;
}
function Mini({ label, value, warn, note }: { label: string; value: string; warn?: boolean; note?: string }) {
  return <div className={`rounded-2xl p-4 ${warn ? 'bg-ember-soft' : 'bg-softer'}`}><div className="eyebrow">{label}</div><div className="mt-1 font-display text-xl font-bold tnum">{value}</div>{note && <div className="text-xs font-semibold text-ember">{note}</div>}</div>;
}
function Rows({ children }: { children: ReactNode }) { return <div className="grid gap-2">{children}</div>; }
function Item({ tag, tone, id, error, extra, children }: { tag: string; tone: string; id: string; error?: string | null; extra?: string; children?: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-softer p-3 text-sm">
    <code className="tnum text-dim">{id}</code><span className={`chip ${tone}`}>{tag}</span>{extra && <span className="text-xs text-sub">{extra}</span>}
    <span className="min-w-0 flex-1 basis-56 break-words text-ember">{error}</span><div className="flex gap-2">{children}</div>
  </div>;
}
function Quiet({ children }: { children: ReactNode }) { return <p className="rounded-2xl bg-softer p-4 text-sm text-sub">{children}</p>; }
function Toggle({ checked, onChange, label, danger }: { checked: boolean; onChange: (v: boolean) => void; label: string; danger?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex items-center gap-3 font-display font-semibold">
    <span className={`relative h-8 w-14 rounded-full transition ${checked ? (danger ? 'bg-ember' : 'bg-mint') : 'bg-edge'}`}><span className="absolute top-1 size-6 rounded-full bg-white shadow transition-all" style={{ left: checked ? '1.75rem' : '0.25rem' }} /></span>{label}
  </button>;
}
