import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Card } from '../../shared/types';
import { packDef } from '../../shared/packs';
import { useShowcase } from './showcase';

/** The mark: an ember tile with a card standing in it and a flame cut through the card. */
export function Logo({ size = 32 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
    <defs>
      <linearGradient id="rb-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ff4b3e" /><stop offset=".6" stopColor="#ff8a3d" /><stop offset="1" stopColor="#ffc23c" /></linearGradient>
    </defs>
    <rect width="40" height="40" rx="12" fill="url(#rb-tile)" />
    <rect x="11" y="7" width="18" height="26" rx="4" fill="#fff" transform="rotate(8 20 20)" />
    <path d="M20.6 12.5c.9 3 4.6 4.8 4.6 9.3a5.2 5.2 0 0 1-10.4 0c0-2.1 1-3.6 2-4.6.3 1.8 1.2 2.9 2.4 3.4-.6-3.1-.2-5.7 1.4-8.1Z" fill="url(#rb-tile)" transform="rotate(8 20 20)" />
  </svg>;
}
/** The name in rounded type, "burn" in the ember gradient. */
export function Wordmark({ className = 'text-xl' }: { className?: string }) {
  return <span className={`font-display font-bold tracking-tight ${className}`}>rip<span className="text-burn">burn</span></span>;
}

/** Each Collector Crypt machine gets a name and a color of ours. */
type PackStyle = { name: string; color: string; item: 'card' | 'watch' };
const PACK_STYLES: Record<string, PackStyle> = {
  pokemon_25: { name: 'Spark', color: '#12b886', item: 'card' },
  pokemon_50: { name: 'Surge', color: '#2e6bff', item: 'card' },
  pokemon_100: { name: 'Blaze', color: '#ff4b3e', item: 'card' },
  pokemon_151: { name: 'Classic', color: '#ff6fae', item: 'card' },
  pokemon_250: { name: 'Nova', color: '#7c5cff', item: 'card' },
  ewatch_250: { name: 'Vault', color: '#4a5a85', item: 'card' },
  pokemon_500: { name: 'Legend', color: '#e8a21a', item: 'card' },
  ewatch_500: { name: 'Gold Vault', color: '#c9861b', item: 'card' },
  ewatches_500: { name: 'Timepiece', color: '#1d2747', item: 'watch' },
};
export const packStyle = (code: string | null | undefined, priceUsd?: number): PackStyle => PACK_STYLES[code ?? ''] ?? PACK_STYLES[`pokemon_${priceUsd}`] ?? { name: 'Mystery', color: '#96a1bb', item: 'card' };
export const isWatch = (code: string | null | undefined) => packDef(code)?.kind === 'watch';

const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const HUES = ['#12b886', '#2e6bff', '#ff4b3e', '#7c5cff', '#e8a21a', '#ff6fae', '#0fb5c9', '#5b6787'];
export const hueFor = (name: string) => HUES[hash(name) % HUES.length];

/** A sealed pack: Collector Crypt's own artwork when it loads, otherwise our foil sleeve. */
export function PackArt({ code, priceUsd, className = '' }: { code: string; priceUsd: number; className?: string }) {
  const image = useShowcase()?.packs[code];
  const [broken, setBroken] = useState(false), [loaded, setLoaded] = useState(false);
  const p = packStyle(code, priceUsd);
  if (image && !broken) return <div className={`relative aspect-square ${className}`}>
    {!loaded && <div aria-hidden="true" className="absolute inset-[14%] animate-pulse rounded-3xl bg-soft" />}
    <img src={image} alt={`${p.name} pack, $${priceUsd}`} referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => setBroken(true)}
      className={`h-full w-full object-contain drop-shadow-[0_18px_24px_rgb(16_25_53/0.25)] transition-opacity duration-500 ${loaded ? 'opacity-100' : 'opacity-0'}`} />
  </div>;
  return <div className={`relative aspect-square ${className}`}><FoilSleeve p={p} priceUsd={priceUsd} /></div>;
}

/** Our drawn pack: a glossy sleeve in the pack's color, the mark, the price. */
function FoilSleeve({ p, priceUsd }: { p: PackStyle; priceUsd: number }) {
  return <div className="absolute inset-x-[18%] inset-y-[6%] overflow-hidden rounded-[22px] shadow-[0_20px_40px_-16px_rgb(16_25_53/0.45)]" style={{ background: `linear-gradient(150deg, color-mix(in srgb, ${p.color} 55%, white), ${p.color} 45%, color-mix(in srgb, ${p.color} 60%, #101935))` }}>
    <div className="absolute inset-0 bg-[repeating-linear-gradient(115deg,rgb(255_255_255/0.0)_0_14px,rgb(255_255_255/0.12)_14px_18px)]" />
    <div className="absolute inset-x-0 top-0 h-[16%] bg-white/20" />
    <div className="absolute inset-x-0 top-[22%] grid place-items-center"><div className="rounded-2xl bg-white/90 p-2 shadow"><Logo size={36} /></div></div>
    <div className="absolute inset-x-0 bottom-[12%] text-center text-white">
      <div className="font-display text-[0.7rem] font-semibold uppercase tracking-[0.3em] opacity-80">{p.name}</div>
      <div className="font-display text-3xl font-bold leading-none drop-shadow">${priceUsd}</div>
    </div>
  </div>;
}

/**
 * A trading card. With `tilt` it leans toward the pointer and its holo foil follows it. With `flipped`
 * it shows its back (the rip overlay flips it over on reveal).
 */
export function TradingCard({ card, priceUsd, tilt = false, flipped = false, watch = false, className = '', foil = 0.35 }: {
  card: Pick<Card, 'name' | 'image' | 'insuredValueUsd'>; priceUsd?: number; tilt?: boolean; flipped?: boolean; watch?: boolean; className?: string; foil?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [name, set, grade] = card.name.split(' · ');
  const hit = priceUsd !== undefined && (card.insuredValueUsd ?? 0) >= priceUsd;
  function move(e: React.PointerEvent) {
    const el = ref.current; if (!el || !tilt) return;
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    el.style.transform = `${flipped ? 'rotateY(180deg) ' : ''}rotateX(${(0.5 - y) * 16}deg) rotateY(${(x - 0.5) * 18}deg)`;
    el.style.setProperty('--mx', `${x * 100}%`); el.style.setProperty('--my', `${y * 100}%`); el.style.setProperty('--foil', String(Math.min(0.85, foil + 0.35)));
  }
  function leave() { const el = ref.current; if (!el) return; el.style.transform = flipped ? 'rotateY(180deg)' : ''; el.style.setProperty('--foil', String(foil)); }
  return <div className={`[perspective:900px] [transform-style:preserve-3d] ${className}`} onPointerMove={move} onPointerLeave={leave}>
    <div ref={ref} className="tcard" style={{ transform: flipped ? 'rotateY(180deg)' : undefined, '--foil': foil } as CSSProperties}>
      <div className="tcard-face bg-card">
        {card.image ? <img src={card.image} alt={card.name} referrerPolicy="no-referrer" className="h-full w-full object-cover" />
          : <CardFallback name={name ?? card.name} set={set} grade={grade} watch={watch} />}
        <div className="holo-foil" />
        {grade && <span className="absolute right-2 top-2 grid size-11 place-items-center rounded-full bg-white/95 text-center font-display text-[0.6rem] font-bold leading-tight text-ink shadow">{grade.replace(/^(PSA|BGS|CGC)\s*/, '$1\n').split('\n').map((l, i) => <span key={i} className={i ? 'text-sm leading-none' : ''}>{l}</span>)}</span>}
        {hit && <span className="chip absolute left-2 top-2 bg-gold text-ink shadow">Hit</span>}
      </div>
      <div className="tcard-face tcard-back"><Logo size={54} /></div>
    </div>
  </div>;
}

/** Cards without a photo (practice mode): a clean color field, the initial, name, set and grade. */
function CardFallback({ name, set, grade, watch }: { name: string; set?: string; grade?: string; watch: boolean }) {
  const color = hueFor(name);
  return <div className="relative grid h-full w-full grid-rows-[1fr_auto] p-3" style={{ background: `linear-gradient(160deg, color-mix(in srgb, ${color} 30%, white), color-mix(in srgb, ${color} 75%, white) 55%, ${color})` }}>
    <div className="grid place-items-center">
      <div className="grid aspect-square w-[62%] place-items-center rounded-full bg-white/75 font-display text-5xl font-bold text-ink/80 shadow-inner">{watch ? '◷' : name.slice(0, 1)}</div>
    </div>
    <div className="rounded-xl bg-white/85 px-2.5 py-2 text-ink backdrop-blur">
      <div className="truncate font-display text-sm font-bold leading-tight">{name}</div>
      <div className="truncate text-[0.65rem] font-semibold text-sub">{[set, grade].filter(Boolean).join(' · ') || 'Graded collectible'}</div>
    </div>
  </div>;
}

/** A progress ring. `value` 0..1; `spin` shows an indeterminate arc instead. */
export function Ring({ value = 0, size = 120, stroke = 10, color = 'var(--color-ember)', track = 'var(--color-soft)', spin = false, children, marker }: { value?: number; size?: number; stroke?: number; color?: string; track?: string; spin?: boolean; children?: ReactNode; marker?: number }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, value));
  const [shown, setShown] = useState(0);
  useEffect(() => { const id = requestAnimationFrame(() => setShown(v)); return () => cancelAnimationFrame(id); }, [v]);
  const angle = (marker ?? 0) * 360 - 90;
  return <div className="relative inline-grid place-items-center" style={{ width: size, height: size }}>
    <svg width={size} height={size} className={spin ? 'ring-spin' : '-rotate-90'} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={spin ? c * 0.72 : c * (1 - shown)} className={spin ? '' : 'ring-fill'} />
    </svg>
    {marker !== undefined && <i aria-hidden="true" className="absolute h-[calc(50%)] w-0 origin-bottom" style={{ top: 0, transform: `rotate(${angle + 90}deg)` }}><i className="absolute -left-[3px] -top-[3px] block size-[6px] rounded-full bg-ink" /></i>}
    <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
  </div>;
}

/** A number that rolls up to its value whenever the value changes. */
export function CountUp({ value, format = (n: number) => n.toLocaleString('en-US'), duration = 1100, className = '' }: { value: number; format?: (n: number) => string; duration?: number; className?: string }) {
  const [shown, setShown] = useState(0), from = useRef(0);
  useEffect(() => {
    const start = performance.now(), a = from.current, b = value;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(b); from.current = b; return; }
    let id = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration), eased = 1 - Math.pow(1 - k, 3);
      setShown(a + (b - a) * eased);
      if (k < 1) id = requestAnimationFrame(tick); else from.current = b;
    };
    id = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(id); from.current = b; };
  }, [value, duration]);
  return <span className={`tnum ${className}`}>{format(shown)}</span>;
}

/** Marks children to fade up as they scroll into view. */
export function Reveal({ children, className = '', delay = 0, as: Tag = 'div' }: { children: ReactNode; className?: string; delay?: number; as?: 'div' | 'section' | 'li' }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const io = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
    io.observe(el); return () => io.disconnect();
  }, []);
  return <Tag ref={ref as any} data-reveal="" className={className} style={{ '--d': `${delay}s` } as CSSProperties}>{children}</Tag>;
}

/** The pack price split into the card's value, what was repaid, and what wasn't. */
export function SplitBar({ priceUsd, valueUsd, repayUsd }: { priceUsd: number; valueUsd: number; repayUsd: number }) {
  const value = Math.min(valueUsd, priceUsd), pct = (n: number) => `${Math.max(0, n / priceUsd * 100)}%`, gap = Math.max(0, priceUsd - value - repayUsd);
  return <div>
    <div className="flex h-3 overflow-hidden rounded-full bg-soft">
      <i className="block h-full bg-sky transition-[width] duration-700" style={{ width: pct(value) }} />
      <i className="block h-full bg-mint transition-[width] duration-700" style={{ width: pct(repayUsd) }} />
      {gap > 0.004 && <i className="block h-full bg-ember/25" style={{ width: pct(gap) }} />}
    </div>
  </div>;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps keyboard focus inside `container` and makes the page behind it inert while `open`. */
export function useFocusTrap(open: boolean, container: React.RefObject<HTMLElement | null>, onEscape?: () => void) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape?.();
      if (e.key !== 'Tab' || !container.current) return;
      const items = [...container.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [open, container, onEscape]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    const chrome = [...document.querySelectorAll<HTMLElement>('[data-app-chrome]')];
    document.body.style.overflow = 'hidden';
    chrome.forEach(el => { el.inert = true; });
    container.current?.focus();
    return () => { document.body.style.overflow = overflow; chrome.forEach(el => { el.inert = false; }); previous?.focus?.(); };
  }, [open, container]);
}

/** A centered sheet; on phones it rises from the bottom. */
export function Modal({ open, onClose, children, width = 'max-w-md', label }: { open: boolean; onClose: () => void; children: ReactNode; width?: string; label?: string }) {
  const dialog = useRef<HTMLDivElement>(null);
  useFocusTrap(open, dialog, onClose);
  if (!open) return null;
  return createPortal(<div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 backdrop-blur-md sm:items-center sm:p-4" onClick={onClose}>
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label} className={`panel fade-up relative max-h-[92vh] w-full overflow-auto rounded-b-none p-6 outline-none sm:rounded-b-[28px] sm:p-7 ${width}`} onClick={e => e.stopPropagation()}>
      <button aria-label="Close" className="absolute right-4 top-4 grid size-9 place-items-center rounded-full bg-soft text-sub hover:text-ink" onClick={onClose}><X size={17} /></button>
      {children}
    </div>
  </div>, document.body);
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => { if (!message) return; const t = setTimeout(onClose, 6000); return () => clearTimeout(t); }, [message, onClose]);
  if (!message) return null;
  return <div role="status" className="fade-up fixed inset-x-4 bottom-5 z-[60] mx-auto flex max-w-lg items-center gap-3 rounded-full bg-ink py-2.5 pl-5 pr-2 text-sm font-semibold text-card shadow-[var(--shadow-lift)]">
    <span className="min-w-0 flex-1">{message}</span><button aria-label="Dismiss" className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-white/10" onClick={onClose}><X size={15} /></button>
  </div>;
}

/** A page's opening: eyebrow chip, big rounded title, one line under it. */
export function PageHead({ eyebrow, title, sub, tone = 'bg-soft text-ink', children }: { eyebrow: ReactNode; title: ReactNode; sub?: ReactNode; tone?: string; children?: ReactNode }) {
  return <header className="pt-10 sm:pt-16">
    <span className={`chip ${tone}`}>{eyebrow}</span>
    <h1 className="mt-4 max-w-3xl font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">{title}</h1>
    {sub && <p className="mt-4 max-w-2xl text-base text-sub sm:text-lg">{sub}</p>}
    {children}
  </header>;
}

export function SectionHead({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div><h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>{sub && <p className="mt-1 text-sub">{sub}</p>}</div>{action}
  </div>;
}

export function Stat({ label, value, tone = '', hint }: { label: string; value: ReactNode; tone?: string; hint?: ReactNode }) {
  return <div className="min-w-0">
    <div className="eyebrow">{label}</div>
    <div className={`mt-1 truncate font-display text-2xl font-bold tnum ${tone}`}>{value}</div>
    {hint && <div className="mt-0.5 text-xs text-sub">{hint}</div>}
  </div>;
}

/** An empty state: a floating card back and a line of text. */
export function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="panel grid place-items-center gap-3 px-6 py-14 text-center">
    <div className="relative h-24 w-[4.3rem] animate-[var(--animate-float)]" style={{ '--r': '-6deg' } as CSSProperties}><div className="tcard-face grid place-items-center" style={{ background: 'radial-gradient(circle at 50% 40%, #3a57d6, #101935 70%)', transform: 'none' }}><Logo size={30} /></div></div>
    <h3 className="mt-2 font-display text-xl font-bold">{title}</h3><p className="max-w-sm text-sm text-sub">{text}</p>{action && <div className="mt-2">{action}</div>}
  </div>;
}
