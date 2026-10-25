import type { Card } from './client';
import type { Jobs } from '../jobs';

export type Purchase = {
  id: string; wallet: string; recipient: string; priceUsdc: number; packType?: string; memo?: string; transaction?: string;
  signedTransaction?: string; signature?: string; paid?: boolean; card?: Card;
  /** When the payment was first seen as never landed; confirmed a minute later before giving up. */
  expiredSeenAt?: number;
  /** When the payment was first seen confirmed, and when Collector Crypt was last asked to open the pack while it hadn't registered it. */
  paidAt?: number; nudgedAt?: number;
};
export interface PurchaseStore {
  get(id: string): Promise<Purchase | null>;
  save(purchase: Purchase): Promise<void>;
  locked<T>(id: string, action: () => Promise<T>): Promise<T>;
}

/**
 * Keeps Collector Crypt purchases in the `jobs` table. One coordinator owns the database
 * (advisory lock), so an in-process lock is enough to stop two steps racing on one order.
 */
export class JobPurchaseStore implements PurchaseStore {
  private locks = new Set<string>();
  constructor(readonly jobs: Jobs) {}
  async get(id: string) { return ((await this.jobs.get(`cc:${id}`))?.data as Purchase) ?? null; }
  async save(purchase: Purchase) { await this.jobs.put(`cc:${purchase.id}`, 'cc-purchase', purchase.card ? 'complete' : purchase.paid ? 'paid' : purchase.signature ? 'signed' : 'ordered', purchase); }
  async locked<T>(id: string, action: () => Promise<T>) {
    if (this.locks.has(id)) throw new Error('This purchase is already being processed.');
    this.locks.add(id);
    try { return await action(); } finally { this.locks.delete(id); }
  }
}
