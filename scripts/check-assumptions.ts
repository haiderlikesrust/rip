/**
 * Read-only launch checks. Nothing is signed or sent.
 *  1. Is our coin an SPL Token or Token-2022 mint? (burn instruction)
 *  2. Do our pump.fun creator fees go to TREASURY, and in $CARDS? (burn fund)
 *  3. Does Jupiter route $CARDS → coin on Metis (direct burns), or $CARDS → USDC → coin (fallback)?
 *     And $CARDS → USDC (refilling the repay reserve)?
 *  4. Do the OPS and TREASURY wallets have USDC accounts and SOL for fees, and how much $CARDS does TREASURY hold?
 *
 *   npm run check
 */
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../server/config';
import { connection } from '../server/chain';
import { treasurySigner } from '../server/treasury-signer';
import { quote } from '../server/swap';

const rpc = connection();
if (!rpc) { console.error('Set SOLANA_RPC_URL first.'); process.exit(1); }
const ok = (m: string) => console.log(`  ✓ ${m}`), warn = (m: string) => console.log(`  ✗ ${m}`);
const treasury = config.TREASURY_PRIVATE_KEY ? treasurySigner(config.TREASURY_PRIVATE_KEY)?.publicKey ?? null : null;

console.log('1. Coin mint program');
if (!config.MEMECOIN_MINT) warn('MEMECOIN_MINT is not set.');
else {
  const info = await rpc.getAccountInfo(new PublicKey(config.MEMECOIN_MINT));
  if (!info) warn('Mint account not found.');
  else if (info.owner.equals(TOKEN_PROGRAM_ID)) ok('SPL Token mint: burns use the classic token program.');
  else if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) ok('Token-2022 mint: burns use Token-2022 (handled automatically).');
  else warn(`Unknown mint program ${info.owner.toBase58()}.`);
}

console.log('2. Creator fees');
if (config.MEMECOIN_MINT) {
  try {
    const { OnlinePumpSdk, feeSharingConfigPda, normalizeQuoteMint } = createRequire(import.meta.url)('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
    const mint = new PublicKey(config.MEMECOIN_MINT), curve = await new OnlinePumpSdk(rpc).fetchBondingCurve(mint);
    const quoteMint = normalizeQuoteMint(curve.quoteMint).toBase58(), sharing = curve.creator.equals(feeSharingConfigPda(mint));
    (quoteMint === config.CARDS_MINT ? ok : warn)(`Quote token: ${quoteMint === config.CARDS_MINT ? '$CARDS' : `${quoteMint} (not $CARDS: claimed fees will be swapped into $CARDS)`}.`);
    ok(`Creator: ${curve.creator.toBase58()}${sharing ? ' (fee-sharing config)' : ''}. Graduated: ${curve.complete}.`);
    if (treasury && !sharing && !curve.creator.equals(treasury)) warn(`The TREASURY wallet ${treasury.toBase58()} is not the creator. Point creator fees at it before launch.`);
    if (curve.isHolderReward) warn('This coin routes fees to holder rewards, not the creator.');
  } catch (error) { warn(`Could not read the pump.fun curve: ${(error as Error).message}`); }
}

console.log('3. Jupiter routes');
if (!config.JUPITER_API_KEY) warn('JUPITER_API_KEY is not set.');
else {
  // 100 $CARDS: big enough to be a real route, small enough to quote anywhere.
  const probe = 100_000_000n;
  const check = async (label: string, input: string, output: string, required: boolean) => {
    try {
      const order = await quote(input, output, probe, treasury?.toBase58());
      if (order.errorCode || !order.outAmount) throw new Error(order.errorMessage ?? 'no route');
      const metis = order.router === 'metis', impact = Math.abs(Number(order.priceImpactPct ?? 0)) * 100;
      (metis ? ok : warn)(`${label}: ${metis ? 'Metis route' : `router ${order.router} (only Metis is accepted)`}, impact ${impact.toFixed(2)}% on 100 $CARDS.`);
      return metis;
    } catch (error) { (required ? warn : console.log)(`  ${required ? '✗' : '·'} ${label}: ${(error as Error).message}`); return false; }
  };
  const refill = await check('$CARDS → USDC (repay refills)', config.CARDS_MINT, config.USDC_MINT, true);
  if (config.MEMECOIN_MINT) {
    const direct = await check('$CARDS → coin (direct burns)', config.CARDS_MINT, config.MEMECOIN_MINT, false);
    if (!direct) {
      const hop = await check('USDC → coin (two-hop burns)', config.USDC_MINT, config.MEMECOIN_MINT, true);
      if (refill && hop) ok('Burns will route $CARDS → USDC → coin.');
    }
  }
}

console.log('4. Wallets');
for (const [name, key] of [['OPS', config.OPS_PRIVATE_KEY], ['TREASURY', config.TREASURY_PRIVATE_KEY]] as const) {
  const signer = key ? treasurySigner(key) : null;
  if (!signer) { warn(`${name}_PRIVATE_KEY is not set.`); continue; }
  const ata = getAssociatedTokenAddressSync(new PublicKey(config.USDC_MINT), signer.publicKey);
  const [sol, account] = await Promise.all([rpc.getBalance(signer.publicKey), rpc.getAccountInfo(ata)]);
  (account ? ok : warn)(`${name} ${signer.publicKey.toBase58()}: ${(sol / 1e9).toFixed(3)} SOL, USDC account ${account ? 'exists' : 'MISSING (create it before launch)'}`);
  if (name === 'TREASURY') {
    const cards = await rpc.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(config.CARDS_MINT) }).catch(() => null);
    const units = cards?.value.reduce((t, a) => t + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n) ?? 0n;
    ok(`TREASURY holds ${(Number(units) / 1e6).toLocaleString('en-US')} $CARDS (the burn fund).`);
  }
}
if (config.OPS_PRIVATE_KEY && config.OPS_PRIVATE_KEY === config.TREASURY_PRIVATE_KEY) warn('OPS and TREASURY must be different wallets.');
