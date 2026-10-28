import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import { openDatabase, migrate, Serial, type Database } from './db';
import { Jobs, PendingOperation } from './jobs';
import { SettingsStore } from './settings';
import { Chain, connection } from './chain';
import { treasurySigner } from './treasury-signer';
import { LiveSolana } from './solana-live';
import { MockPacks, MockSolana } from './mock';
import { CollectorCrypt } from './cc/client';
import { CollectorCryptPacks } from './cc/packs';
import { JobPurchaseStore } from './cc/store';
import { Holders } from './holders';
import { Orders } from './orders';
import { Treasury } from './treasury';
import { Burns } from './burns';
import { Gas } from './gas';
import type { PackProvider, Solana } from './ports';

export type Services = Awaited<ReturnType<typeof createServices>>;

function signer(name: 'OPS_PRIVATE_KEY' | 'TREASURY_PRIVATE_KEY') {
  try { return treasurySigner(config[name]); }
  catch { throw new Error(`${name} is invalid. Use a base58-encoded 64-byte Solana private key or a JSON array of 64 byte values.`); }
}

/**
 * Practice mode: in-memory Solana and a mocked Collector Crypt, so nothing real moves. It runs whenever
 * mainnet is off and no RPC is set, so a first deploy is a public practice site with play money. Locally
 * anyone may open /admin; in production only OWNER_WALLET can. With an RPC set but mainnet off, the site
 * runs read-only against real chain data instead (for `npm run check` before launch).
 */
export const practiceAllowed = () => !config.live && !config.SOLANA_RPC_URL;

/** Wires the app: practice mode locally, live adapters otherwise (signing only when MAINNET_ENABLED=true). */
export async function createServices(options: { db?: Database; solana?: Solana; packs?: PackProvider; onStandby?: () => void; signal?: AbortSignal } = {}) {
  const db = options.db ?? await openDatabase(undefined, undefined, { onStandby: options.onStandby, signal: options.signal });
  await migrate(db);
  const jobs = new Jobs(db), settings = new SettingsStore(db);
  await settings.load();
  let solana: Solana, packs: PackProvider;
  if (options.solana && options.packs) { solana = options.solana; packs = options.packs; }
  else if (practiceAllowed()) {
    const mock = new MockSolana();
    solana = options.solana ?? mock;
    packs = options.packs ?? new MockPacks(() => mock.opsAddress);
  } else {
    const rpc = connection(), ops = new Chain(jobs, signer('OPS_PRIVATE_KEY'), rpc, 'OPS'), treasury = new Chain(jobs, signer('TREASURY_PRIVATE_KEY'), rpc, 'TREASURY');
    new PublicKey(config.COLLECTOR_CRYPT_PAYMENT_WALLET);
    solana = options.solana ?? new LiveSolana(ops, treasury, rpc);
    packs = options.packs ?? new CollectorCryptPacks(new CollectorCrypt(config.COLLECTOR_CRYPT_API_KEY), { connection: rpc, signer: ops.signer, paymentWallet: config.COLLECTOR_CRYPT_PAYMENT_WALLET, store: new JobPurchaseStore(jobs), enabled: config.live, dasRpcUrl: config.dasRpcUrl });
  }
  const holders = new Holders(solana, settings), treasury = new Treasury(db, jobs, solana, settings);
  const burns = new Burns(db, solana, treasury, settings);
  const gas = new Gas(db, jobs, solana, treasury, settings);
  const orders = new Orders(db, jobs, solana, packs, holders, treasury, burns, settings, gas);
  return { db, jobs, settings, solana, packs, holders, treasury, burns, gas, orders, serial: new Serial(), practice: solana instanceof MockSolana };
}

/** Background loops. Every financial step runs through the one Serial queue. */
export function startCoordinator(s: Services, log: (message: string, error?: unknown) => void) {
  const timers: ReturnType<typeof setInterval>[] = [];
  const every = (ms: number, name: string, task: () => Promise<unknown>, queued = true) => {
    let busy = false;
    timers.push(setInterval(() => {
      if (busy) return; busy = true;
      (queued ? s.serial.run(task) : task()).catch(error => { if (!(error instanceof PendingOperation)) log(`${name} failed`, error); }).finally(() => { busy = false; });
    }, ms));
  };
  every(2_000, 'orders', () => s.orders.step());
  // Repays come first: the reserve is topped up from $CARDS before queued burns run.
  every(30_000, 'refill', () => s.treasury.refill());
  // A settled pull's buyback starts within seconds.
  every(5_000, 'burns', () => s.burns.step());
  every(5 * 60_000, 'treasury', () => s.treasury.run());
  // Creator fees: a read-only vault check every second; claiming takes a turn in the queue only when due.
  every(1_000, 'creator-fees', async () => {
    if (!(await s.treasury.creatorFeesDue())) return;
    await s.serial.run(() => s.treasury.creatorFees(true)).catch(error => { if (!(error instanceof PendingOperation)) throw error; });
  }, false);
  // One balance check per wallet; a top-up only when OPS runs low.
  every(30_000, 'gas', () => s.gas.ensure());
  every(5 * 60_000, 'cleanup', async () => { await s.db.query('DELETE FROM sessions WHERE expires_at<$1', [Date.now()]); await s.db.query('DELETE FROM challenges WHERE expires_at<$1', [Date.now()]); });
  return () => timers.forEach(clearInterval);
}
