import { createContext, useCallback, useContext, useEffect, useState, type Ref } from 'react';
import { FlaskConical, LogOut, Menu, Moon, Sun, Wallet as WalletIcon, X } from 'lucide-react';
import type { HolderView } from '../../shared/types';
import { BRAND } from '../../shared/brand';
import { api, newerBuild, short } from './api';
import { forget, onAccountSwitch, signIn, useWallets } from './wallet';
import { Logo, Modal, Toast, Wordmark } from './ui';
import { HomePage } from './pages/home';
import { BurnsPage } from './pages/burns';
import { TreasuryPage } from './pages/treasury';
import { PullsPage } from './pages/pulls';
import { AdminPage } from './pages/admin';
import { HowPage } from './pages/how';
import { PracticeDock } from './parts/practice';
import { ContractAddress } from './parts/contract';

export type Me = { wallet: string | null; owner?: boolean; holder?: HolderView | null };
export type PublicSettings = { paused: boolean; burnCapBps: number; holderMinTokens: number; holderWindowHours: number; serviceFeeBps: number; usdcReserveTargetUsd: number; burnBatchMinUsd: number; burnEveryMinutes: number; pausedPacks: string[] };
export type AppConfig = { mode: 'practice' | 'mainnet' | 'read-only'; mint: string | null; symbol: string; treasuryAddress: string | null; opsAddress: string | null; settings: PublicSettings };
type Ctx = { me: Me; config: AppConfig | null; refresh: () => Promise<void>; connect: () => void; notify: (message: string) => void; version: number; bump: () => void };
const AppContext = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppContext);
/** The coin's ticker with its dollar sign, e.g. "$RIP". */
export const useTicker = () => `$${useApp().config?.symbol ?? 'RIP'}`;

/** Client-side navigation. After an update, the next click loads the new build instead of mixing versions. */
export function navigate(path: string) {
  if (newerBuild()) { location.assign(path); return; }
  history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate')); scrollTo({ top: 0 });
}
export function Link({ href, className, children, ref, current, title, onClick }: { href: string; className?: string; children: React.ReactNode; ref?: Ref<HTMLAnchorElement>; current?: boolean; title?: string; onClick?: () => void }) {
  return <a ref={ref} href={href} title={title} className={className} aria-current={current ? 'page' : undefined} onClick={e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); onClick?.(); navigate(href); }}>{children}</a>;
}

const PAGES: [href: string, label: string][] = [['/', 'Rip'], ['/burns', 'Burns'], ['/treasury', 'Treasury'], ['/pulls', 'Binder'], ['/how', 'How it works']];
const TITLES: Record<string, string> = { '/burns': 'Burns', '/treasury': 'Treasury', '/pulls': 'Binder', '/how': 'How it works', '/admin': 'Admin' };

/** Light by default; dark when chosen. Remembered per browser when storage allows. */
function useTheme() {
  const [dark, setDark] = useState(() => { try { return localStorage.getItem('rb-theme') === 'dark'; } catch { return false; } });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try { localStorage.setItem('rb-theme', dark ? 'dark' : 'light'); } catch { /* storage blocked: lasts this visit */ }
  }, [dark]);
  return { dark, toggle: () => setDark(d => !d) };
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [me, setMe] = useState<Me>({ wallet: null });
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [picker, setPicker] = useState(false), [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // Bumped whenever practice tools, sign-in or a finished order change state, so pages reload their data.
  const [version, setVersion] = useState(0);
  const wallets = useWallets(), theme = useTheme();

  const refresh = useCallback(async () => { setMe(await api<Me>('/me')); }, []);
  const notify = useCallback((message: string) => setNotice(message), []);
  useEffect(() => { const on = () => { setPath(location.pathname); setMenu(false); }; window.addEventListener('popstate', on); return () => window.removeEventListener('popstate', on); }, []);
  useEffect(() => {
    refresh().catch(() => {});
    // Retry the public config until it loads, so a brief server restart doesn't leave pages blank.
    let timer: ReturnType<typeof setTimeout>;
    const loadConfig = () => api<AppConfig>('/config').then(setConfig).catch(() => { timer = setTimeout(loadConfig, 2000); });
    loadConfig();
    return () => clearTimeout(timer);
  }, [refresh]);
  useEffect(() => { document.title = TITLES[path] ? `${TITLES[path]} · ${BRAND.name}` : `${BRAND.name} · Rip packs. Burn supply.`; }, [path]);

  const logout = useCallback(async (message?: string) => {
    forget();
    try { await api('/auth/logout', {}); } catch (e) { notify((e as Error).message); }
    await refresh().catch(() => {}); setVersion(v => v + 1);
    if (message) notify(message);
  }, [notify, refresh]);
  // Switching accounts in the wallet signs out the old one rather than failing later at payment.
  useEffect(() => onAccountSwitch(() => { void logout('Your wallet switched accounts. Connect again to use the new one.'); }), [logout]);

  async function connectWith(wallet?: any) {
    setBusy(true);
    try { if (wallet) await signIn(wallet); else await api('/practice/login', {}); setPicker(false); await refresh(); setVersion(v => v + 1); }
    catch (e) { notify((e as Error).message); } finally { setBusy(false); }
  }

  const pages: [string, string][] = [...PAGES, ...(me.owner ? [['/admin', 'Admin'] as [string, string]] : [])];
  const active = pages.some(([href]) => href === path) ? path : '/';
  const page = path === '/burns' ? <BurnsPage /> : path === '/treasury' ? <TreasuryPage /> : path === '/pulls' ? <PullsPage /> : path === '/how' ? <HowPage /> : path === '/admin' ? <AdminPage /> : <HomePage />;
  const practice = config?.mode === 'practice', holder = me.holder?.holder;
  const wallet = me.wallet
    ? <div className="flex items-center gap-1 rounded-full bg-card p-1 shadow-[var(--shadow-soft)]">
        <span className="flex h-9 items-center gap-2 rounded-full pl-3 pr-2 text-sm font-bold" title={me.wallet}>
          <span className={`grid size-5 place-items-center rounded-full text-[0.6rem] text-white ${holder ? 'bg-mint' : 'bg-dim'}`}>{holder ? '✓' : '·'}</span><span className="tnum">{short(me.wallet)}</span>
        </span>
        <button className="grid size-9 place-items-center rounded-full text-sub hover:bg-soft hover:text-ink" onClick={() => logout()} aria-label="Sign out" title="Sign out"><LogOut size={15} /></button>
      </div>
    : <button className="btn btn-ink btn-sm" onClick={() => setPicker(true)}><WalletIcon size={15} />Connect</button>;

  return <AppContext.Provider value={{ me, config, refresh, connect: () => setPicker(true), notify, version, bump: () => setVersion(v => v + 1) }}>
    <div className="aurora" aria-hidden="true"><i /><i /><i /></div>
    <header data-app-chrome className="sticky top-0 z-40 backdrop-blur-xl [background:color-mix(in_srgb,var(--color-bg)_72%,transparent)]">
      <div className="mx-auto flex h-[72px] max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label={`${BRAND.name} home`}><Wordmark className="h-9 sm:h-10" /></Link>
        {practice && <span className="chip hidden bg-violet-soft text-violet sm:inline-flex"><FlaskConical size={13} />Practice</span>}
        <nav aria-label="Main" className="mx-auto hidden items-center gap-1 md:flex">
          {pages.map(([href, label]) => <Link key={href} href={href} current={href === active} className={`group relative px-3.5 py-2 font-display text-[0.95rem] font-semibold transition-colors ${href === active ? 'text-ink' : 'text-sub hover:text-ink'}`}>
            {label}<span className={`absolute inset-x-3.5 -bottom-0.5 h-[3px] origin-left rounded-full bg-gradient-to-r from-ember to-ember-2 transition-transform duration-300 ${href === active ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-50'}`} />
          </Link>)}
        </nav>
        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <button onClick={theme.toggle} className="grid size-10 place-items-center rounded-full text-sub hover:bg-card hover:text-ink" aria-label={theme.dark ? 'Switch to light mode' : 'Switch to dark mode'}>{theme.dark ? <Sun size={18} /> : <Moon size={18} />}</button>
          <div className="hidden sm:block">{wallet}</div>
          <button onClick={() => setMenu(true)} className="grid size-10 place-items-center rounded-full bg-card shadow-[var(--shadow-soft)] md:hidden" aria-label="Open menu"><Menu size={18} /></button>
        </div>
      </div>
    </header>

    {/* Phones: a full-screen sheet of big links. */}
    {menu && <div className="fixed inset-0 z-50 flex flex-col bg-bg/95 px-6 pb-8 pt-5 backdrop-blur-xl md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
      <div className="flex items-center justify-between"><Wordmark className="h-9" /><button onClick={() => setMenu(false)} className="grid size-10 place-items-center rounded-full bg-card" aria-label="Close menu"><X size={18} /></button></div>
      <nav className="mt-10 grid gap-2">{pages.map(([href, label], i) => <Link key={href} href={href} onClick={() => setMenu(false)} className={`rounded-2xl px-4 py-3 font-display text-3xl font-bold ${href === active ? 'bg-card text-ink shadow-[var(--shadow-soft)]' : 'text-sub'}`}><span className="fade-up block" style={{ animationDelay: `${i * 40}ms` }}>{label}</span></Link>)}</nav>
      <div className="mt-auto">{wallet}</div>
    </div>}

    <main data-app-chrome className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">{page}</main>

    <footer data-app-chrome className="mx-auto max-w-6xl px-4 pb-10 sm:px-6">
      <div className="panel grid gap-8 p-8 sm:p-10 md:grid-cols-[1.3fr_1fr]">
        <div>
          <Wordmark className="h-12" />
          <p className="mt-3 max-w-sm text-sub">{BRAND.tagline}</p>
          <ContractAddress className="mt-5 max-w-md" />
        </div>
        <div className="grid content-start gap-5">
          <nav className="flex flex-wrap gap-x-5 gap-y-2 font-display font-semibold">{PAGES.map(([href, label]) => <Link key={href} href={href} className="text-sub hover:text-ink">{label}</Link>)}</nav>
          <p className="text-xs leading-relaxed text-dim">Loss repays are a discretionary perk for coin holders, paid from the treasury under the published rules: not insurance and not a guarantee. Card values are Collector Crypt's insured values at the time of the pull. Burns are funded by creator fees. Not affiliated with Nintendo, The Pokémon Company or Collector Crypt.</p>
          <p className="font-display text-xs font-semibold text-dim">{config?.mode === 'mainnet' ? 'Live on Solana mainnet' : practice ? 'Practice mode · no real money' : 'Pre-launch'}</p>
        </div>
      </div>
    </footer>

    <Modal open={picker} onClose={() => setPicker(false)} label="Connect your wallet">
      <Logo size={48} />
      <h2 className="mt-4 font-display text-2xl font-bold">Connect a wallet</h2>
      <p className="mt-1 text-sm text-sub">You'll sign a message to prove it's yours. Signing in never approves a transaction.</p>
      <div className="mt-6 grid gap-2.5">
        {wallets.map(w => <button key={w.name} disabled={busy} className="btn btn-ghost h-14 justify-start rounded-2xl px-4" onClick={() => connectWith(w)}><img src={w.icon} alt="" width={26} height={26} className="rounded-lg" />{w.name}</button>)}
        {!wallets.length && !practice && <p className="rounded-2xl bg-soft p-4 text-sm text-sub">No Solana wallet found. Install <a className="font-bold text-sky" href="https://phantom.com" target="_blank" rel="noreferrer">Phantom</a> or <a className="font-bold text-sky" href="https://solflare.com" target="_blank" rel="noreferrer">Solflare</a>, then reload.</p>}
        {practice && <button disabled={busy} className="btn btn-ember h-14" onClick={() => connectWith()}><FlaskConical size={17} />Use a practice wallet</button>}
      </div>
    </Modal>

    {practice && me.wallet && <PracticeDock />}
    <Toast message={notice} onClose={() => setNotice('')} />
  </AppContext.Provider>;
}
