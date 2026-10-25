import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../server/app';
import { setup } from './helpers';

const challenge = (app: Awaited<ReturnType<typeof createApp>>['app']) =>
  app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { wallet: Keypair.generate().publicKey.toBase58() } });

test('live mode limits sign-in attempts per IP with a readable message', async () => {
  const s = await setup();
  const { app } = await createApp({ services: { ...s, practice: false }, timers: false, logger: false });
  const codes: number[] = [];
  for (let i = 0; i < 13; i++) codes.push((await challenge(app)).statusCode);
  assert.deepEqual(codes.slice(0, 12), Array(12).fill(200));
  const blocked = await challenge(app);
  assert.equal(blocked.statusCode, 429);
  assert.match(blocked.json().error, /Too many requests\. Please wait/);
  await app.close();
});

test('practice mode does not rate limit, since every local tab shares one IP', async () => {
  const s = await setup();
  const { app } = await createApp({ services: s, timers: false, logger: false });
  for (let i = 0; i < 20; i++) assert.equal((await challenge(app)).statusCode, 200);
  await app.close();
});
