import { createHash, randomBytes, randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import type { Database } from './db';

export const hashSession = (token: string) => createHash('sha256').update(token).digest('hex');

export async function challenge(db: Database, wallet: string) {
  new PublicKey(wallet);
  const id = randomUUID(), now = Date.now(), expiresAt = now + 300_000;
  const origin = new URL(config.APP_ORIGIN);
  const message = `${origin.host} wants you to sign in with your Solana account:\n${wallet}\n\nSign in to Ripburn. This does not authorize a transaction.\n\nURI: ${origin.origin}\nVersion: 1\nChain ID: solana:mainnet\nNonce: ${randomBytes(16).toString('hex')}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}`;
  await db.query('INSERT INTO challenges(id,wallet,message,expires_at) VALUES($1,$2,$3,$4)', [id, wallet, message, expiresAt]);
  return { id, message, expiresAt };
}

export async function verify(db: Database, id: string, signature: string) {
  const row = (await db.query('SELECT * FROM challenges WHERE id=$1 AND consumed=FALSE AND expires_at>$2', [id, Date.now()])).rows[0];
  if (!row) throw new Error('This login request expired or was already used.');
  if (!nacl.sign.detached.verify(new TextEncoder().encode(row.message), bs58.decode(signature), new PublicKey(row.wallet).toBytes())) throw new Error('Wallet signature is invalid.');
  const consumed = await db.query('UPDATE challenges SET consumed=TRUE WHERE id=$1 AND consumed=FALSE RETURNING id', [id]);
  if (!consumed.rows.length) throw new Error('Login request was already used.');
  return createSession(db, row.wallet);
}

/** The first sign-in activates a wallet; off-site coverage counts from that moment. */
export async function createSession(db: Database, wallet: string) {
  const now = Date.now();
  await db.query('INSERT INTO wallets(wallet,activated_at,last_seen_at) VALUES($1,$2,$2) ON CONFLICT(wallet) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at', [wallet, now]);
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO sessions(id,wallet,expires_at) VALUES($1,$2,$3)', [hashSession(token), wallet, now + 86_400_000]);
  return { token, wallet };
}

export async function sessionWallet(db: Database, token?: string) {
  if (!token) return null;
  const now = Date.now();
  const row = (await db.query('SELECT w.wallet,w.activated_at,w.last_seen_at FROM sessions s JOIN wallets w ON w.wallet=s.wallet WHERE s.id=$1 AND s.expires_at>$2', [hashSession(token), now])).rows[0];
  if (!row) return null;
  // Refreshed at most hourly to keep writes low.
  if (now - Number(row.last_seen_at ?? 0) > 3_600_000) await db.query('UPDATE wallets SET last_seen_at=$2 WHERE wallet=$1', [row.wallet, now]);
  return { wallet: row.wallet as string, activatedAt: Number(row.activated_at), owner: !!config.OWNER_WALLET && row.wallet === config.OWNER_WALLET };
}
