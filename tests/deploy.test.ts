import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createApp } from '../server/app';
import { config } from '../server/config';
import { openDatabase } from '../server/db';
import type { Services } from '../server/services';
import { setup } from './helpers';

test('while the database is being handed over, health says healthy and API requests wait instead of failing', async () => {
  let handOver!: (s: Services) => void;
  const pending = new Promise<Services>(resolve => { handOver = resolve; });
  const { app, ready } = await createApp({ services: pending, timers: false, logger: false });
  const early = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(early.statusCode, 200, 'a standby counts as healthy, so Swarm goes on to stop the old server');
  assert.equal(early.json().state, 'starting');
  let answered = false;
  const request = app.inject({ method: 'GET', url: '/api/config' }).then(r => { answered = true; return r; });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(answered, false, 'the request waits for the hand-over');
  handOver(await setup());
  const reply = await request;
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.json().mode, 'practice');
  assert.equal(reply.headers['x-build-id'], config.BUILD_ID, 'every API reply names the build');
  const health = (await app.inject({ method: 'GET', url: '/api/health' })).json();
  assert.equal(health.state, 'active');
  assert.equal(health.ok, true);
  await (await ready).db.query('SELECT 1');
  await app.close();
});

test('a server that cannot start reports unhealthy, so Swarm keeps or rolls back to the old version', async () => {
  const { app } = await createApp({ services: Promise.reject(new Error('DATABASE_URL is required')), timers: false, logger: false });
  await new Promise(r => setTimeout(r, 10));
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 503);
  assert.equal(health.json().state, 'failed');
  assert.equal((await app.inject({ method: 'GET', url: '/api/config' })).statusCode, 503);
  await app.close();
});

test('stopping drains and closes the database, and health then reports the server as stopping', async () => {
  const s = await setup();
  const { app, shutdown, state } = await createApp({ services: s, timers: false, logger: false });
  await app.inject({ method: 'GET', url: '/api/config' });
  await shutdown();
  assert.equal(state(), 'stopping');
  await assert.rejects(s.db.query('SELECT 1'), 'the connection, and with it the coordinator lock, is released');
});

test('the production image refuses embedded Postgres, whose data an update would wipe', async () => {
  const before = config.DATABASE_REQUIRED;
  config.DATABASE_REQUIRED = true;
  try { await assert.rejects(openDatabase('', 'memory://'), /DATABASE_URL is required/); }
  finally { config.DATABASE_REQUIRED = before; }
});

test('publishing static files keeps earlier builds\' files and removes ones unused for 30 days', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rb-static-')), from = join(root, 'build'), to = join(root, 'assets');
  await mkdir(from); await mkdir(to);
  await writeFile(join(from, 'index-new.js'), 'new');
  await writeFile(join(to, 'index-old.js'), 'old');
  await writeFile(join(to, 'index-ancient.js'), 'ancient');
  const ancient = new Date(Date.now() - 31 * 86_400_000);
  await utimes(join(to, 'index-ancient.js'), ancient, ancient);
  await promisify(execFile)(process.execPath, ['deploy/publish-static.mjs'], { env: { ...process.env, STATIC_FROM: from, STATIC_TO: to } });
  assert.deepEqual((await readdir(to)).sort(), ['index-new.js', 'index-old.js']);
  assert.equal(await readFile(join(to, 'index-new.js'), 'utf8'), 'new');
});
