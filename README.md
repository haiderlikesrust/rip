# Ripburn

**Rip packs. Burn supply. Holders never take an L.**

Ripburn sells Collector Crypt Pokémon packs for our pump.fun coin. Every pack opened here does two things:

1. **Burn.** The treasury buys back the coin worth the pulled card's insured value and burns it: `burn = min(insured value, X% × free burn fund)`. X is `burnCapBps` in Admin, 50% by default. The cap means one pull can never empty the fund.
2. **Repay.** If the buyer is a holder and the card's insured value is below the pack price, the treasury sends back the whole loss in USDC: `repay = price − insured value`. Non-holders still trigger burns, but they aren't repaid.

The **treasury** is the dev wallet. It is the coin's creator-fee recipient, and those fees arrive in $CARDS. It keeps two buckets:

- **$CARDS, the burn fund.** Claimed creator fees stay here. Each pull's burn is fixed in $CARDS at settlement and runs within seconds: one Jupiter swap of $CARDS into the coin (never split into smaller buys), then one burn. If $CARDS doesn't route straight to the coin, the swap goes $CARDS → USDC → coin.
- **USDC, the repay reserve.** Repays come first. Whenever free USDC falls below its target, free $CARDS is sold to top it up. $CARDS already promised to a queued burn is never sold.

Each paid holder order holds back its worst-case repay (the full price). If free USDC can't cover that at some price, **holder packs at that price pause** until the reserve refills. Non-holders keep opening.

A **holder** is a wallet holding at least `holderMinTokens` when it starts an order. That check is instant by default (`holderWindowHours` = 0), so someone can buy, rip and sell. Set `holderWindowHours` above 0 to require the *lowest* on-chain balance over that many hours instead, so buying just before a pull doesn't count.

This was adapted from [haiderlikesrust/ppp](https://github.com/haiderlikesrust/ppp) ("Pullback"). The Collector Crypt purchase flow, the persist-then-broadcast transactions, the Jupiter swaps, the pump.fun fee claims and practice mode all come from there.

## Run it locally (practice mode)

```bash
npm install
npm run dev
```

Open http://localhost:5173.

With no `.env`, the app runs in **practice mode**: Solana is mocked in memory and Collector Crypt is mocked too, with a realistic, loss-heavy spread of pull values. Connect with a practice wallet, then use the **Practice lab** (the purple button, bottom-left) to:
- switch between holder and non-holder,
- add creator fees,
- empty the treasury's USDC to watch holder packs pause.

No keys or money are involved.

```bash
npm test          # economics, orders (repay, burn queue, pauses), burns, refills, payments, Collector Crypt flow
npm run typecheck
npm run build     # builds the frontend into dist/, which the API server then serves
```

## Deploy

Production runs at **ripburn.cards** on Dokploy as an Application (this repository's `Dockerfile`, port 4100) plus a Postgres database. Updates have no downtime: the new version starts first, waits as a standby, and takes over from the old one. Follow [docs/DOKPLOY.md](docs/DOKPLOY.md); the environment template is [deploy/dokploy.env.example](deploy/dokploy.env.example).

## Layout

| Path | What it does |
|---|---|
| `shared/economics.ts` | Pure math: repay, burn cap, $CARDS conversion, holder line, quotes |
| `shared/brand.ts` | Site name and tagline (rename here) |
| `server/orders.ts` | On-site state machine: quote → pay → buy → deliver → settle (repay + queue burn), plus refunds and review |
| `server/treasury.ts` | USDC reserve and reservations, $CARDS burn fund, refills, creator-fee claims, service-fee forwarding |
| `server/burns.ts` | Burn queue: each pull's $CARDS → coin buyback and burn right after it settles, pro-rata receipts |
| `server/holders.ts` | Holder check: lowest on-chain balance over the window |
| `server/fees.ts` | pump.fun creator-fee claim into TREASURY, kept as $CARDS |
| `server/chain.ts`, `swap.ts` | Persist-then-broadcast transactions, Jupiter (Metis) swaps, Token-2022-aware burn, NFT transfer |
| `server/payment.ts` | Builds and strictly validates the buyer's USDC payment (Solana Pay reference key) |
| `server/cc/*` | Collector Crypt client, purchase flow and payment validator |
| `server/mock.ts` | Practice-mode Solana and Collector Crypt |
| `web/src` | Vite + React frontend: Rip (home + full-screen rip), Burns, Treasury, Binder, How it works, Admin |

## Before mainnet

1. **Fill in `.env`** from `.env.example`. Use two different wallets:
   - **OPS** receives payments, buys packs and forwards cards. Keep only working funds in it.
   - **TREASURY** is the dev wallet. It must be the coin's pump.fun creator (or a fee-sharing shareholder). Seed it with some USDC for the first repays.
2. **Run `npm run check`.** It's read-only and checks that:
   - the coin's mint program can be burned,
   - creator fees go to TREASURY in $CARDS,
   - Jupiter returns a Metis route for $CARDS → USDC and for $CARDS → coin (or USDC → coin),
   - both wallets have USDC accounts and SOL.
3. **Set the rules** on `/admin` (owner = `OWNER_WALLET`): burn cap X, holder minimum and window, USDC reserve target, packs on sale.
4. **Smoke test.**
   1. Set `MAINNET_ENABLED=true` and open one $25 pack as a holder and one as a non-holder.
   2. Check the repay and each pull's buyback and burn on Solscan.
   3. Compare the treasury page with the on-chain balances.
5. **Add link-preview artwork.** Put a 1200×630 `og:image` in `index.html`; the old project's images were removed.

## The economics: read this

Big hits don't offset bad pulls. So per holder pack, the treasury pays roughly:

```
E[max(0, price − value)]                 the repay, every losing pull, in full
+ min(insured value, X% × free fund)     the burn, every pull
```

- **Repays.** If Collector Crypt packs lose about 25% of the price on average across losing pulls, every holder pack costs the treasury about 25% of its price in repays. That comes on top of the burn, and creator fees must cover both.
- **Burns** are self-limiting. Each one uses at most X% of what's free, so heavy volume makes burns smaller instead of draining the fund.
- **Repays** are protected by reservations and the pause. A paid holder order can always be repaid, and new holder packs wait when the reserve runs low.
- **Optional `serviceFeeBps`.** A service fee on top of the price can help fund the treasury. It's off by default.

The UI calls the repay a "loss repay", never "insurance" (a regulated term). Pack opening with value guarantees can be regulated in some places: **get legal advice before launch.**
