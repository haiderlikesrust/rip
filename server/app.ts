import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { z } from 'zod';
import { ShowcaseSource } from './showcase';
import { MAX_PER_OPEN } from './orders';
import { sitePulls } from './pulls';
import { config, configBlockers } from './config';
import { trustInternalProxies } from './proxy';
import { challenge, verify, sessionWallet, hashSession, createSession } from './auth';
import { audit } from './db';
import { createServices, practiceAllowed, startCoordinator, type Services } from './services';
import { MockPacks, MockSolana } from './mock';
import { settingsSchema, settingsVersion } from './settings';
import { publicError, redact } from './redact';
import { BRAND } from '../shared/brand';

const COOKIE = 'rb_session';
const SERVICE = BRAND.name.toLowerCase();
const wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export function originAllowed(method: string, origin: string | undefined, fetchSite: string | undefined, appOrigin: string) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  return fetchSite !== 'cross-site' && (!origin || origin === appOrigin);
}

const showcase = new ShowcaseSource();
/** Longest an API request waits for a standby to become active before it is told to retry. */
const HANDOVER_WAIT_MS = 30_000;
/** Longest a stopping server spends finishing requests and its current coordinator step. */
const DRAIN_MS = 8_000;

/**
 * Where this server is in its life:
 * - `starting`: connecting to the database.
 * - `standby`: another server holds the coordinator lock; during an update that is the old version, which
 *   is about to hand over. The health check counts this as healthy, so Swarm goes on to stop the old one.
 * - `active`: serving everything and running the coordinator.
 * - `stopping`: draining after SIGTERM. `failed`: startup failed, and the health check says so.
 */
export type ServerState = 'starting' | 'standby' | 'active' | 'stopping' | 'failed';

/**
 * The HTTP app. It is listening before the database is ready: `services` (or the ones it creates) resolve
 * once this server owns the database, and until then API requests wait (health checks don't).
 */
export async function createApp(options: { services?: Services | Promise<Services>; timers?: boolean; logger?: boolean } = {}) {
  // A stopping server keeps answering requests on open connections until they finish, instead of 503s.
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 16_384, requestTimeout: 30_000, trustProxy: trustInternalProxies(config.TRUST_PROXY_HOPS), return503OnClosing: false });
  await app.register(cookie);
  let state: ServerState = 'starting', s!: Services;
  let stopCoordinator = () => {};
  const abort = new AbortController();
  const given = options.services;
  const ready: Promise<Services> = Promise.resolve(given ?? createServices({
    signal: abort.signal,
    onStandby: () => { state = 'standby'; app.log.info('[coordinator] standby: waiting for the running server to hand over the database'); },
  })).then(services => {
    s = services; state = 'active';
    if (s.packs instanceof MockPacks) {
      // Practice pulls wear real recent Collector Crypt cards (their values stay simulated).
      s.packs.realCards = () => showcase.cards;
      void showcase.get();
    }
    if (options.timers !== false) stopCoordinator = startCoordinator(s, (message, error) => app.log.error({ message: (error as Error)?.message }, message));
    if (!given) app.log.info('[coordinator] active');
    return s;
  }, error => { if (state !== 'stopping') { state = 'failed'; app.log.error({ message: redact((error as Error).message) }, '[coordinator] startup failed'); } throw error; });
  ready.catch(() => {});
  // Practice helpers exist when this server will run on mocks. Locally they also open /admin to anyone
  // and skip rate limits (every tab shares 127.0.0.1); on a public practice site they don't.
  const practiceRoutes = given && !(given instanceof Promise) ? given.practice : practiceAllowed();
  const localPractice = () => !!s?.practice && !config.production;
  await app.register(rateLimit, {
    max: 120, timeWindow: '1 minute', allowList: () => localPractice(),
    errorResponseBuilder: (_req, context) => ({ statusCode: 429, message: `Too many requests. Please wait ${context.after} and try again.` }),
  });

  // During a hand-over, API requests wait for this server to become active rather than failing.
  app.addHook('onRequest', async (req, reply) => {
    if (s || !req.url.startsWith('/api') || req.url.startsWith('/api/health')) return;
    if (state === 'failed' || state === 'stopping') return reply.code(503).send({ error: 'The site is restarting. Try again in a moment.' });
    const timeout = new Promise<null>(done => setTimeout(() => done(null), HANDOVER_WAIT_MS).unref());
    if (!(await Promise.race([ready.catch(() => null), timeout]))) return reply.code(503).send({ error: 'The site is updating. Try again in a moment.' });
  });
  app.addHook('onRequest', async (req, reply) => { if (!originAllowed(req.method, req.headers.origin, req.headers['sec-fetch-site'] as string | undefined, config.APP_ORIGIN)) return reply.code(403).send({ error: 'Request origin is not allowed.' }); });
  // Every API reply names the build, so a page from an older build knows to reload on its next navigation.
  app.addHook('onSend', async (req, reply, payload) => { if (req.url.startsWith('/api')) reply.header('Cache-Control', 'no-store').header('X-Build-Id', config.BUILD_ID); reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer'); return payload; });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number };
    if (e instanceof z.ZodError) return reply.code(400).send({ error: 'Check the submitted fields.', fields: e.issues.map(i => i.path.join('.')) });
    const { status, message } = publicError(e);
    if (status >= 500) app.log.error({ message: redact(e.message), path: req.url }, 'Request failed');
    else if (e.cause) app.log.warn({ message: e.message, cause: redact(String(e.cause)), path: req.url }, 'Request refused');
    return reply.code(status).send({ error: message });
  });

  const auth = async (req: any, owner = false) => {
    const session = await sessionWallet(s.db, req.cookies[COOKIE]);
    if (!session) throw Object.assign(new Error('Connect and sign in with your wallet.'), { statusCode: 401 });
    if (owner && !session.owner && !localPractice()) throw Object.assign(new Error('Owner access required.'), { statusCode: 403 });
    return session;
  };
  const setSession = (reply: any, token: string) => reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.APP_ORIGIN.startsWith('https:'), maxAge: 86_400 });
  const mode = () => s.practice ? 'practice' : config.live ? 'mainnet' : 'read-only';

  // Healthy while starting or in standby: during an update the new server is up and only waiting for the
  // old one to hand over the database. Unhealthy once startup failed (Swarm then rolls back) or the
  // database stops answering.
  app.get('/api/health', { config: { rateLimit: false } }, async (_req, reply) => {
    const base = { service: SERVICE, build: config.BUILD_ID, state };
    if (state === 'failed' || state === 'stopping') return reply.code(503).send({ ok: false, ...base });
    if (state !== 'active') return { ok: true, ...base };
    try { await s.db.query('SELECT 1'); } catch { return reply.code(503).send({ ok: false, ...base }); }
    return { ok: true, ...base, mode: mode(), database: config.DATABASE_URL ? 'postgres' : 'embedded-postgres', spendingEnabled: config.live && !s.settings.current.paused };
  });
  app.get('/api/config', async () => ({ mode: mode(), mint: s.solana.holderMint, symbol: config.COIN_SYMBOL, treasuryAddress: s.solana.treasuryAddress, opsAddress: s.solana.opsAddress, settings: publicSettings(s) }));

  app.post('/api/auth/challenge', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async req => { const body = z.object({ wallet }).parse(req.body); return challenge(s.db, body.wallet); });
  app.post('/api/auth/verify', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ id: z.string().uuid(), signature: z.string().max(100) }).parse(req.body);
    // Sign-in is a couple of single-statement DB writes; it doesn't wait behind the coordinator queue.
    const result = await verify(s.db, body.id, body.signature);
    setSession(reply, result.token);
    return { wallet: result.wallet };
  });
  app.post('/api/auth/logout', async (req, reply) => { const token = req.cookies[COOKIE]; if (token) await s.db.query('DELETE FROM sessions WHERE id=$1', [hashSession(token)]); reply.clearCookie(COOKIE, { path: '/' }); return { ok: true }; });

  app.get('/api/me', async req => {
    const session = await sessionWallet(s.db, req.cookies[COOKIE]);
    if (!session) return { wallet: null };
    let holder = null;
    try { holder = await s.holders.view(session.wallet); } catch { /* RPC trouble should not sign anyone out */ }
    return { wallet: session.wallet, owner: session.owner || localPractice(), holder };
  });

  app.get('/api/packs', async req => {
    const session = await sessionWallet(s.db, req.cookies[COOKIE]);
    return { packs: await s.orders.quotes(session?.wallet ?? null), nextPackAt: session ? await s.orders.nextPackAt(session.wallet) : null, maxPerOpen: session ? s.orders.maxPerOpen(session.wallet) : MAX_PER_OPEN };
  });
  app.post('/api/orders', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req);
    const body = z.object({ code: z.string().min(1).max(40), count: z.number().int().min(1).max(MAX_PER_OPEN).optional() }).parse(req.body);
    // Slow provider and RPC calls run outside the queue; only the DB check-and-insert waits in it.
    return s.orders.createMany(session.wallet, body.code, body.count ?? 1, fn => s.serial.run(fn));
  });
  app.post('/api/orders/:id/pay', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { signed } = z.object({ signed: z.string().min(1).max(2_000) }).parse(req.body);
    return s.orders.pay(session.wallet, id, signed, fn => s.serial.run(fn));
  });
  app.post('/api/orders/:id/cancel', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return s.serial.run(() => s.orders.cancel(session.wallet, id));
  });
  app.get('/api/orders/:id', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async req => { const session = await auth(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return s.orders.get(id, session.wallet); });
  app.get('/api/orders', async req => { const session = await auth(req); return { orders: await s.orders.list(session.wallet) }; });
  // Sell back: Collector Crypt's buyback for a card from a finished order.
  app.get('/api/orders/:id/sell', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return s.orders.sellQuote(session.wallet, id);
  });
  app.post('/api/orders/:id/sell', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return s.orders.sellStart(session.wallet, id);
  });
  app.post('/api/orders/:id/sell/submit', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { signed } = z.object({ signed: z.string().min(1).max(4_000) }).parse(req.body);
    return s.orders.sellSubmit(session.wallet, id, signed);
  });

  // Public transparency: the treasury's two buckets, every burn, and every pull opened here.
  app.get('/api/treasury', async () => s.treasury.view());
  app.get('/api/burns', async req => {
    const { before } = z.object({ before: z.coerce.number().int().positive().optional() }).parse(req.query);
    return s.burns.view(30, before);
  });
  app.get('/api/pulls/recent', async () => ({ items: await sitePulls(s.db, 24) }));
  app.get('/api/me/pulls', async req => { const session = await auth(req); return { items: await sitePulls(s.db, 100, session.wallet) }; });
  // Collector Crypt's pack images and one real card, for the site's artwork.
  app.get('/api/showcase', async () => showcase.get());

  app.get('/api/admin', async req => {
    await auth(req, true);
    return {
      settings: s.settings.current, version: settingsVersion(s.settings.current), gas: await s.gas.status().catch(() => null), blockers: s.practice ? ['Practice mode: in-memory Solana and a mocked Collector Crypt'] : configBlockers(),
      review: (await s.db.query("SELECT id,wallet,status,error,updated_at::text FROM orders WHERE status='review' ORDER BY updated_at DESC LIMIT 50")).rows,
      // Paid orders that keep failing a step and are waiting to retry, with the reason.
      delayed: (await s.db.query("SELECT id,status,error,COALESCE((data->>'failures')::int,0) AS failures,COALESCE((data->>'retryAt')::bigint,0)::text AS retry_at,updated_at::text FROM orders WHERE status IN ('paying','paid','buying','delivering','settling','refunding') AND (COALESCE((data->>'failures')::int,0) > 0 OR (data->'waiting'->>'status' = status AND (data->'waiting'->>'since')::bigint < $1)) ORDER BY updated_at DESC LIMIT 50", [Date.now() - 10 * 60_000])).rows.map(r => ({ ...r, error: r.error ? redact(r.error) : null })),
      burnReview: (await s.db.query("SELECT id,status,error,usd_micros::text,pulls,created_at::text FROM burn_batches WHERE status IN ('review','executing') ORDER BY created_at DESC LIMIT 20")).rows.map(r => ({ ...r, error: r.error ? redact(r.error) : null })),
      // Includes Collector Crypt purchases that were signed but never finished, so none can hide.
      jobs: (await s.db.query("SELECT id,kind,status,error,updated_at::text FROM jobs WHERE status IN ('failed','retryable','submitted','prepared') OR (kind='cc-purchase' AND status IN ('signed','ordered') AND updated_at < $1) ORDER BY updated_at DESC LIMIT 50", [Date.now() - 600_000])).rows,
      audit: (await s.db.query('SELECT id::text,event,data,created_at::text FROM audit ORDER BY id DESC LIMIT 50')).rows,
    };
  });
  app.patch('/api/admin/settings', async req => {
    const session = await auth(req, true);
    const next = settingsSchema.parse(req.body);
    await s.serial.run(async () => {
      // Refuse a save based on stale settings.
      const expected = req.headers['if-match'];
      if (expected && expected !== settingsVersion(s.settings.current)) throw Object.assign(new Error('Settings changed since you opened this page. Reload and try again.'), { statusCode: 409 });
      await s.settings.save(next); await audit(s.db, 'settings-updated', { wallet: session.wallet, settings: next });
    });
    return { settings: s.settings.current, version: settingsVersion(s.settings.current) };
  });
  app.post('/api/admin/orders/:id/retry-now', async req => {
    const session = await auth(req, true);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await s.serial.run(async () => { await s.orders.retryNow(id); await audit(s.db, 'order-retry-now', { wallet: session.wallet, id }); });
    return { ok: true };
  });
  app.post('/api/admin/orders/:id/resolve', async req => {
    const session = await auth(req, true);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { action } = z.object({ action: z.enum(['retry', 'refund']) }).parse(req.body);
    await s.serial.run(async () => { await s.orders.resolve(id, action); await audit(s.db, 'order-resolved', { wallet: session.wallet, id, action }); });
    return { ok: true };
  });
  app.post('/api/admin/treasury/run', async req => { await auth(req, true); return s.serial.run(() => s.treasury.run()); });
  app.post('/api/admin/burns/run', async req => { await auth(req, true); return s.serial.run(() => s.burns.step(true)); });
  app.post('/api/admin/burns/:id/retry', async req => {
    const session = await auth(req, true);
    const { id } = z.object({ id: z.string().regex(/^burn-batch:[a-f0-9-]{36}$/) }).parse(req.params);
    await s.serial.run(async () => { await s.burns.retry(id); await audit(s.db, 'burn-retry', { wallet: session.wallet, id }); });
    return { ok: true };
  });
  app.post('/api/admin/gas/run', async req => { await auth(req, true); return s.serial.run(() => s.gas.ensure()); });

  // Practice-only helpers. They do not exist when real Solana is wired in.
  if (practiceRoutes) {
    const mock = () => { if (!(s.solana instanceof MockSolana)) throw Object.assign(new Error('Not found.'), { statusCode: 404 }); return s.solana; };
    app.post('/api/practice/login', async (req, reply) => {
      const body = z.object({ wallet: wallet.optional() }).parse(req.body ?? {});
      const address = body.wallet ?? Keypair.generate().publicKey.toBase58();
      const session = await s.serial.run(() => createSession(s.db, address));
      setSession(reply, session.token);
      return { wallet: address };
    });
    // Holder: has held 1% of supply for a month. Not a holder: holds nothing.
    app.post('/api/practice/holder', async req => {
      const session = await auth(req);
      const { holder } = z.object({ holder: z.boolean() }).parse(req.body);
      mock().setHolderPpm(session.wallet, holder ? 10_000 : 0, Date.now() - 30 * 86_400_000);
      s.holders.forget(session.wallet);
      return s.holders.view(session.wallet);
    });
    // Creator fees worth `usd` arrive in $CARDS and are claimed right away.
    app.post('/api/practice/creator-fees', async req => {
      await auth(req);
      const { usd } = z.object({ usd: z.number().positive().max(1_000_000) }).parse(req.body);
      mock().queueCreatorFees(usd);
      await s.serial.run(() => s.treasury.creatorFees(true));
      return s.treasury.view();
    });
    // Sets the treasury's USDC directly, e.g. to $0 to see holder packs pause.
    app.post('/api/practice/treasury-usdc', async req => {
      await auth(req);
      const { usd } = z.object({ usd: z.number().min(0).max(1_000_000) }).parse(req.body);
      mock().setTreasuryUsdc(Math.round(usd * 1e6)); s.treasury.invalidate();
      await s.serial.run(() => audit(s.db, 'practice-treasury-usdc', { usd }));
      return s.treasury.view();
    });
  }

  const dist = resolve('dist');
  if (existsSync(dist)) {
    // Built files carry a content hash in their name and never change; the page itself is always revalidated.
    await app.register(fastifyStatic, { root: dist, wildcard: false, cacheControl: false, setHeaders: (res, path) => res.setHeader('Cache-Control', path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache') });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api') ? reply.code(404).send({ error: 'Not found.' }) : reply.sendFile('index.html'));
  }

  // Closing stops the coordinator, lets the current money step finish (it runs in the Serial queue), then
  // closes the database connection, which frees the coordinator lock for the server taking over.
  app.addHook('onClose', async () => { abort.abort(); stopCoordinator(); if (s) await s.serial.run(() => s.db.close()); });

  /** SIGTERM: finish open requests and the current step, at most DRAIN_MS, then hand over. */
  let closing: Promise<void> | null = null;
  const shutdown = () => closing ??= (async () => {
    state = 'stopping';
    await Promise.race([app.close(), new Promise(done => setTimeout(done, DRAIN_MS).unref())]);
  })();
  return { app, ready, shutdown, state: () => state };
}

function publicSettings(s: Services) {
  const c = s.settings.current;
  return { paused: c.paused, burnCapBps: c.burnCapBps, holderMinTokens: c.holderMinTokens, holderWindowHours: c.holderWindowHours, serviceFeeBps: c.serviceFeeBps, usdcReserveTargetUsd: c.usdcReserveTargetUsd, burnBatchMinUsd: c.burnBatchMinUsd, burnEveryMinutes: c.burnEveryMinutes, pausedPacks: c.pausedPacks };
}
