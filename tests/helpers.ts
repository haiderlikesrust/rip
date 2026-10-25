import { Keypair } from '@solana/web3.js';
import { openDatabase } from '../server/db';
import { createServices } from '../server/services';
import { MockPacks, MockSolana } from '../server/mock';
import { createSession } from '../server/auth';
import { DEFAULT_SETTINGS } from '../shared/economics';
import type { Settings } from '../shared/types';

export async function setup(settings: Partial<Settings> = {}) {
  const db = await openDatabase(undefined, 'memory://');
  const solana = new MockSolana(), packs = new MockPacks(() => solana.opsAddress);
  packs.pendingCalls = 0;
  const s = await createServices({ db, solana, packs });
  await s.settings.save({ ...DEFAULT_SETTINGS, ...settings });
  return { ...s, solana, packs };
}

/** A signed-in wallet. Holders have held 1% of supply for a month; non-holders hold nothing. */
export async function user(s: Awaited<ReturnType<typeof setup>>, holder = true) {
  const wallet = Keypair.generate().publicKey.toBase58();
  s.solana.setHolderPpm(wallet, holder ? 10_000 : 0, Date.now() - 30 * 86_400_000);
  await createSession(s.db, wallet);
  return { wallet };
}

/** Steps the order machine until the order stops moving or reaches a final state. */
export async function settle(s: Awaited<ReturnType<typeof setup>>, id: string, max = 20) {
  for (let i = 0; i < max; i++) {
    await s.orders.step();
    const order = await s.orders.get(id);
    if (['complete', 'refunded', 'expired', 'review'].includes(order.status)) return order;
  }
  return s.orders.get(id);
}

/** Opens one pack whose card is worth exactly `valueUsd`, start to finish. */
export async function pull(s: Awaited<ReturnType<typeof setup>>, wallet: string, code: string, valueUsd: number) {
  const card = s.packs.card.bind(s.packs);
  s.packs.card = (seed: string, priceUsd: number, c?: string) => ({ ...card(seed, priceUsd, c), insuredValueUsd: valueUsd });
  try {
    const { order } = await s.orders.create(wallet, code);
    await s.orders.pay(wallet, order.id, 'practice');
    return await settle(s, order.id);
  } finally { s.packs.card = card; }
}
