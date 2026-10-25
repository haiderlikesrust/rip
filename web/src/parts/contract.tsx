import { useState } from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { short, solscan } from '../api';
import { useApp, useTicker } from '../app';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Our coin's contract address with copy and Solscan. Renders nothing until a real mint is configured. */
export function ContractAddress({ className = '' }: { className?: string }) {
  const { config, notify } = useApp();
  const ticker = useTicker();
  const [copied, setCopied] = useState(false);
  const mint = config?.mint;
  if (!mint || !BASE58.test(mint)) return null;
  async function copy() {
    try { await navigator.clipboard.writeText(mint!); setCopied(true); notify('Contract address copied.'); setTimeout(() => setCopied(false), 1800); }
    catch { notify(`Contract address: ${mint}`); }
  }
  return <div className={`flex items-center gap-1 rounded-full bg-soft p-1 pl-4 ${className}`} title={mint}>
    <span className="font-display text-sm font-bold">{ticker}</span>
    <button onClick={copy} className="tnum min-w-0 flex-1 truncate px-2 text-left text-sm font-semibold text-sub hover:text-ink" aria-label={`Copy contract address ${mint}`}><span className="sm:hidden">{short(mint)}</span><span className="hidden sm:inline">{mint}</span></button>
    <button onClick={copy} aria-label="Copy contract address" className={`grid size-9 shrink-0 place-items-center rounded-full ${copied ? 'bg-mint text-white' : 'bg-card text-sub hover:text-ink'}`}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
    <a href={solscan('token', mint)} target="_blank" rel="noreferrer" aria-label="View the coin on Solscan" className="grid size-9 shrink-0 place-items-center rounded-full bg-card text-sub hover:text-ink"><ArrowUpRight size={15} /></a>
  </div>;
}
