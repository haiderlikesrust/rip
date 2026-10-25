import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const env = z.object({
  MAINNET_ENABLED: z.enum(['true', 'false']).default('false'),
  API_PORT: z.coerce.number().default(4100),
  HOST: z.string().default('127.0.0.1'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(2).default(0),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().optional(),
  // The production image sets this: embedded Postgres would lose its data on every update.
  DATABASE_REQUIRED: z.enum(['true', 'false']).default('false'),
  // Embedded Postgres folder, used only when DATABASE_URL is unset (local development).
  PGLITE_DIR: z.string().default('.data/postgres'),
  MEMECOIN_MINT: z.string().default(''),
  /** pump.fun coins have 6 decimals. */
  MEMECOIN_DECIMALS: z.coerce.number().int().min(0).max(12).default(6),
  COIN_SYMBOL: z.string().trim().min(1).max(12).default('RIP'),
  OWNER_WALLET: z.string().default(''),
  OPS_PRIVATE_KEY: z.string().trim().default(''),
  TREASURY_PRIVATE_KEY: z.string().trim().default(''),
  SOLANA_RPC_URL: z.string().default(''),
  DAS_RPC_URL: z.string().default(''),
  JUPITER_API_KEY: z.string().default(''),
  COLLECTOR_CRYPT_API_KEY: z.string().default(''),
  COLLECTOR_CRYPT_PAYMENT_WALLET: z.string().default('GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3'),
  CARDS_MINT: z.string().default('CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp'),
  USDC_MINT: z.string().default('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  GAS_RESERVE_SOL: z.coerce.number().min(0.01).default(0.05),
  SLIPPAGE_BPS: z.coerce.number().min(1).max(500).default(100),
}).parse(process.env);

/** This build's id, written by the Docker build. Browsers on an older build reload on their next navigation. */
const buildId = (() => { try { return readFileSync(new URL('../build-id', import.meta.url), 'utf8').trim() || 'dev'; } catch { return 'dev'; } })();

export const config = { ...env, live: env.MAINNET_ENABLED === 'true', dasRpcUrl: env.DAS_RPC_URL || env.SOLANA_RPC_URL, DATABASE_REQUIRED: env.DATABASE_REQUIRED === 'true', BUILD_ID: buildId, production: process.env.NODE_ENV === 'production' };
export type Config = typeof config;

export function configBlockers() {
  const required = ['MEMECOIN_MINT', 'OWNER_WALLET', 'OPS_PRIVATE_KEY', 'TREASURY_PRIVATE_KEY', 'SOLANA_RPC_URL', 'JUPITER_API_KEY', 'COLLECTOR_CRYPT_PAYMENT_WALLET'] as const;
  const missing: string[] = required.filter(key => !config[key]).map(key => `Configure ${key}`);
  if (config.OPS_PRIVATE_KEY && config.OPS_PRIVATE_KEY === config.TREASURY_PRIVATE_KEY) missing.push('OPS and TREASURY must be different wallets');
  if (!config.DATABASE_URL) missing.push('Configure PostgreSQL DATABASE_URL for mainnet');
  if (!config.live) missing.push('Mainnet spending is disabled (practice mode)');
  return missing;
}
