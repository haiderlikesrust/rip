import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, settle, user } from './helpers';
import { ApiError, CollectorCrypt, machineUnavailable } from '../server/cc/client';
import { fromWinner, pickExample, toCard } from '../server/showcase';
import { packDef } from '../shared/packs';

test('packs are sold and settled by machine code, so two machines can share a price', async () => {
  const s = await setup(), { wallet } = await user(s);
  const quotes = await s.orders.quotes(wallet);
  assert.equal(quotes.filter(q => q.priceUsd === 500).length, 3, '$500 is Psychic, Gold and the watch pack');
  const { order } = await s.orders.create(wallet, 'ewatch_500');
  assert.equal(order.packCode, 'ewatch_500');
  await s.orders.pay(wallet, order.id, 'practice');
  const done = await settle(s, order.id);
  assert.equal(done.status, 'complete');
  assert.match(done.card!.name, /PSA/, 'the WATCH machines pay out graded cards');
  await assert.rejects(s.orders.create(wallet, 'sealed_80'), /not available here/);
  await s.db.close();
});

test('Legendary $250, the WATCH card packs and Watch $500 are on sale; 151 & Friends is off sale but still known', async () => {
  const s = await setup(), { wallet } = await user(s);
  const codes = (await s.orders.quotes(wallet)).map(q => q.code);
  assert.ok(['pokemon_250', 'ewatch_250', 'ewatch_500', 'ewatches_500'].every(c => codes.includes(c)));
  assert.ok(!codes.includes('pokemon_151'), 'no machine image on Collector Crypt');
  await assert.rejects(s.orders.create(wallet, 'pokemon_151'), /not available right now/);
  assert.equal(packDef('pokemon_151')?.priceUsd, 151, 'past orders and claims still read');
  assert.equal(packDef('ewatch_500')?.kind, 'pokemon', 'they pay out Pokémon cards, not watches');
  const { order } = await s.orders.create(wallet, 'ewatches_500');
  await s.orders.pay(wallet, order.id, 'practice');
  assert.match((await settle(s, order.id)).card!.name, /Box & papers/, 'the watch pack pays out a watch');
  await s.db.close();
});

test('hidden Collector Crypt machines are sold only when our catalog marks them unlisted', async () => {
  const machines = [
    { code: 'pokemon_25', price: 25, public: true, contains: 1 },
    { code: 'ewatches_500', price: 500, public: false, contains: 1 },
    { code: 'pokemon_151', price: 151, public: false, contains: 1 },
    { code: 'eprimate_100', price: 100, public: false, contains: 1 },
  ];
  const cc = new CollectorCrypt('', (async () => new Response(JSON.stringify({ machines }))) as typeof fetch);
  assert.deepEqual((await cc.machines()).map(m => m.code), ['pokemon_25', 'ewatches_500', 'pokemon_151'], 'other hidden machines stay out');
});

test('when Collector Crypt says a machine is low, the order refunds at once and nothing retries', async () => {
  assert.ok(machineUnavailable(new ApiError(500, 'Machine is low')));
  assert.ok(machineUnavailable(new ApiError(500, 'Machine is off balance')));
  assert.ok(!machineUnavailable(new ApiError(500, 'Internal error')));
  const s = await setup(), { wallet } = await user(s);
  s.packs.machineLow.add('pokemon_50');
  const { order } = await s.orders.create(wallet, 'pokemon_50');
  await s.orders.pay(wallet, order.id, 'practice');
  const done = await settle(s, order.id);
  assert.equal(done.status, 'refunded');
  assert.ok(done.refundSignature);
  await s.db.close();
});

test('pausing one $500 pack leaves the other $500 pack on sale', async () => {
  const s = await setup({ pausedPacks: ['pokemon_500'] }), { wallet } = await user(s);
  const quotes = await s.orders.quotes(wallet);
  assert.equal(quotes.find(q => q.code === 'pokemon_500')!.quote.open, false);
  assert.equal(quotes.find(q => q.code === 'ewatch_500')!.quote.open, true);
  await s.db.close();
});

test('quick sell: the buyer sells the card back once, for the live offer', async () => {
  const s = await setup(), { wallet } = await user(s), other = await user(s);
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  await s.orders.pay(wallet, order.id, 'practice');
  const done = await settle(s, order.id);
  const quote = await s.orders.sellQuote(wallet, order.id);
  assert.equal(quote.available, true);
  assert.equal(quote.amountUsd, Math.round(done.valueUsd! * 0.85 * 1e6) / 1e6, '85% of the insured value in this practice machine');
  await assert.rejects(s.orders.sellStart(other.wallet, order.id), /not found/);
  const offer = await s.orders.sellStart(wallet, order.id);
  const sold = await s.orders.sellSubmit(wallet, order.id, offer.transaction);
  assert.equal(sold.sale?.amountUsd, offer.amountUsd);
  await assert.rejects(s.orders.sellStart(wallet, order.id), /already sold/);
  await s.db.close();
});

test('the showcase turns a Collector Crypt NFT into a slab card and picks a real losing $25 pull', () => {
  const nft = (value: number, i: number) => ({ name: `2021 #00${i} Birthday Pikachu-Holo`, image: `https://d1xpxki1g4htqu.cloudfront.net/img${i}`, insured_value: value, rarity: 'common', attributes: [{ trait_type: 'Year', value: '2021' }, { trait_type: 'Grading Company', value: 'PSA' }, { trait_type: 'The Grade', value: 'GEM-MT 10' }] });
  assert.deepEqual(toCard(nft(12, 1)), { name: 'Birthday Pikachu-Holo · 2021 · PSA 10', image: 'https://d1xpxki1g4htqu.cloudfront.net/img1', insuredValueUsd: 12, rarity: 'common' });
  assert.equal(toCard({ ...nft(12, 1), image: 'http://insecure.example/x' }), null, 'only https images');
  const picked = pickExample([nft(450, 1), nft(8, 2), nft(14, 3), nft(19, 4), nft(30, 5)]);
  assert.ok(picked && picked.insuredValueUsd < 25 && picked.insuredValueUsd >= 5, 'a card that lost money on a $25 pack');
  assert.equal(pickExample([nft(450, 1)]), null);
});

test('a recent Collector Crypt pull becomes a slab card without its grade repeated in the title', () => {
  const winner = { insuredValue: 13, nft: { content: { metadata: { name: '2006 #65 Exeggcute δ CGC 9 EX H', attributes: [{ trait_type: 'Year', value: '2006' }, { trait_type: 'Grading Company', value: 'CGC' }, { trait_type: 'The Grade', value: '9' }] }, files: [{ cc_cdn: 'https://d1xpxki1g4htqu.cloudfront.net/abc' }] } } };
  assert.deepEqual(toCard(fromWinner(winner)), { name: 'Exeggcute δ · 2006 · CGC 9', image: 'https://d1xpxki1g4htqu.cloudfront.net/abc', insuredValueUsd: 13, rarity: null });
});

test('a full Collector Crypt card name splits into card, set and grade', () => {
  const nft = { name: '2025 Pokemon Prismatic Evolutions #136 Eri CGC 10', image: 'https://d1xpxki1g4htqu.cloudfront.net/eri', insured_value: 17, attributes: [{ trait_type: 'Year', value: '2025' }, { trait_type: 'Grading Company', value: 'CGC' }, { trait_type: 'The Grade', value: 'GEM MINT 10' }] };
  assert.equal(toCard(nft)?.name, 'Eri · Prismatic Evolutions · CGC 10');
});
