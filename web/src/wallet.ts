import { useEffect, useState } from 'react';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import bs58 from 'bs58';
import { api } from './api';

const SIGN_IN = ['standard:connect', 'solana:signMessage'];
type Connected = { wallet: Wallet; account: WalletAccount };
let connected: Connected | null = null;
let stopWatching: (() => void) | null = null;
let onSwitch: (() => void) | null = null;
/** Called when the wallet switches away from the signed-in account (e.g. a different account picked in Phantom). */
export const onAccountSwitch = (handler: () => void) => { onSwitch = handler; };

function link(wallet: Wallet, account: WalletAccount) {
  connected = { wallet, account };
  stopWatching?.(); stopWatching = null;
  const events = wallet.features['standard:events'] as { on?: (event: 'change', listener: (props: { accounts?: readonly WalletAccount[] }) => void) => () => void } | undefined;
  stopWatching = events?.on?.('change', props => {
    if (props.accounts && !props.accounts.some(a => a.address === account.address)) { forget(); onSwitch?.(); }
  }) ?? null;
}

/** Solana wallets that can sign in and sign transactions (Phantom, Solflare, Backpack…). */
export function useWallets() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  useEffect(() => {
    const registry = getWallets();
    const update = () => setWallets(registry.get().filter(w => SIGN_IN.every(f => f in w.features) && w.chains.some(c => c.startsWith('solana:'))));
    update();
    return registry.on('register', update);
  }, []);
  return wallets;
}

/** Connects, then proves ownership by signing a one-time message. No transaction is approved. */
export async function signIn(wallet: Wallet) {
  const result = await (wallet.features['standard:connect'] as any).connect();
  const account: WalletAccount | undefined = result.accounts.find((a: WalletAccount) => a.chains.some(c => c.startsWith('solana:')));
  if (!account) throw new Error('Choose a Solana account in your wallet.');
  const challenge = await api<{ id: string; message: string }>('/auth/challenge', { wallet: account.address });
  const [signed] = await (wallet.features['solana:signMessage'] as any).signMessage({ account, message: new TextEncoder().encode(challenge.message) });
  await api('/auth/verify', { id: challenge.id, signature: bs58.encode(signed.signature) });
  link(wallet, account);
}

/**
 * After a page refresh the sign-in cookie survives but the in-memory wallet link does not.
 * Finds the wallet holding the signed-in address again: silently when the wallet has already
 * approved this site, otherwise with one prompt if a single wallet is installed.
 */
export async function ensureSigner(address: string) {
  if (connected?.account.address === address) return;
  const candidates = getWallets().get().filter(w => 'standard:connect' in w.features && 'solana:signTransaction' in w.features);
  for (const wallet of candidates) {
    let account = wallet.accounts.find(a => a.address === address);
    if (!account) {
      try { account = (await (wallet.features['standard:connect'] as any).connect({ silent: true })).accounts.find((a: WalletAccount) => a.address === address); }
      catch { /* this wallet needs a prompt, or is not the one */ }
    }
    if (account) { link(wallet, account); return; }
  }
  if (candidates.length === 1) {
    const result = await (candidates[0].features['standard:connect'] as any).connect();
    const account = result.accounts.find((a: WalletAccount) => a.address === address);
    if (!account) throw new Error(`Switch your wallet to ${address.slice(0, 4)}…${address.slice(-4)}, the account you signed in with.`);
    link(candidates[0], account);
    return;
  }
  throw Object.assign(new Error('Reconnect the wallet you signed in with to sign the payment.'), { reconnect: true });
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => { let binary = ''; for (const b of bytes) binary += String.fromCharCode(b); return btoa(binary); };

function signer() {
  if (!connected) throw new Error('Reconnect your wallet to sign the payment.');
  const feature = connected.wallet.features['solana:signTransaction'] as any;
  if (!feature) throw new Error('This wallet cannot sign transactions. Try Phantom or Solflare.');
  return { feature, account: connected.account };
}

/** Asks the connected wallet to sign (not send) the payment; the server checks and broadcasts it. */
export async function signPayment(transactionBase64: string) {
  const { feature, account } = signer();
  const [result] = await feature.signTransaction({ account, transaction: fromBase64(transactionBase64), chain: 'solana:mainnet' });
  return toBase64(result.signedTransaction);
}

/**
 * Signs several payments in one wallet approval (Wallet Standard takes them all in one call). A wallet
 * that can't sign several at once is asked for each in turn; a rejection is never asked again.
 */
export async function signPayments(transactionsBase64: string[]) {
  if (transactionsBase64.length === 1) return [await signPayment(transactionsBase64[0])];
  const { feature, account } = signer();
  let results: { signedTransaction: Uint8Array }[] | null = null;
  try { results = await feature.signTransaction(...transactionsBase64.map(t => ({ account, transaction: fromBase64(t), chain: 'solana:mainnet' }))); }
  catch (e) { if ((e as { code?: number }).code === 4001 || /reject|denied|cancel/i.test((e as Error).message)) throw e; }
  if (results?.length === transactionsBase64.length) return results.map(r => toBase64(r.signedTransaction));
  const signed: string[] = [];
  for (const t of transactionsBase64) signed.push(await signPayment(t));
  return signed;
}

export const hasSigner = () => !!connected;
export const forget = () => { connected = null; stopWatching?.(); stopWatching = null; };
