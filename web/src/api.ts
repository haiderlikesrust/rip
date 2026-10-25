/** The build this page came from (set by the Docker build), and whether the server now runs a newer one. */
const BUILD = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_BUILD_ID ?? 'dev';
let newer = false;
/** True once an API reply came from a different build: the next navigation loads the page fresh. */
export const newerBuild = () => newer;

export async function api<T = any>(path: string, body?: unknown, method?: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const build = response.headers.get('x-build-id');
  if (build && build !== 'dev' && BUILD !== 'dev' && build !== BUILD) newer = true;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error ?? `Request failed (${response.status}).`), { status: response.status });
  return data as T;
}

export const money = (n: number | null | undefined) => n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
export const pct = (bps: number) => `${+(bps / 100).toFixed(2)}%`;
export const short = (address?: string | null) => address ? `${address.slice(0, 4)}…${address.slice(-4)}` : '';
export const solscan = (kind: 'tx' | 'account' | 'token', id: string) => `https://solscan.io/${kind}/${id}`;
export const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};

/** Wallet errors in plain words: a rejected prompt means nothing happened. */
export function friendly(error: Error & { code?: number }) {
  const message = error?.message ?? 'Something went wrong.';
  if (error?.code === 4001 || /reject|declin|denied|cancel+ed|user abort/i.test(message)) return 'You cancelled in your wallet. Nothing was charged.';
  return message;
}
