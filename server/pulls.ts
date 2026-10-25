import type { Database } from './db';
import { usd } from '../shared/economics';
import { packCode } from '../shared/packs';
import type { BurnStatus, SitePull } from '../shared/types';

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

/** Recent packs opened here, newest first, with what each one repaid and burned. `wallet` limits it to one buyer. */
export async function sitePulls(db: Database, limit = 24, wallet?: string): Promise<SitePull[]> {
  const rows = (await db.query<{ id: string; wallet: string; price_micros: string; holder: boolean; payment_signature: string | null; data: any; updated_at: string; burn_usd: string | null; burn_status: BurnStatus | null; burn_signature: string | null }>(
    `SELECT o.id, o.wallet, o.price_micros::text, o.holder, o.payment_signature, o.data, o.updated_at::text,
       b.usd_micros::text AS burn_usd, b.status AS burn_status, x.burn_signature
     FROM orders o LEFT JOIN burns b ON b.order_id=o.id LEFT JOIN burn_batches x ON x.id=b.batch_id
     WHERE o.status='complete' ${wallet ? 'AND o.wallet=$2' : ''} ORDER BY o.updated_at DESC LIMIT $1`, wallet ? [limit, wallet] : [limit])).rows;
  return rows.map(r => {
    const price = Number(r.price_micros), d = r.data;
    return {
      id: r.id, code: packCode(d.packCode, usd(price)), priceUsd: usd(price), valueUsd: usd(Number(d.valueMicros ?? 0)), repayUsd: usd(Number(d.repayMicros ?? 0)),
      burnUsd: usd(Number(r.burn_usd ?? 0)), burnStatus: r.burn_status, holder: r.holder, at: Number(r.updated_at), wallet: short(r.wallet),
      card: d.card ? { name: d.card.name, image: d.card.image ?? null } : null,
      txs: { payment: r.payment_signature, pack: d.packSignature ?? null, card: d.nftSignature ?? null, repay: d.repaySignature ?? null, burn: r.burn_status === 'burned' ? r.burn_signature : null },
    };
  });
}
