import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, burnUsdMicros, cardsForUsd, isHolder, maxRepayReservation, micros, quote, repayMicros, tokenUnits, wholeTokens } from '../shared/economics';
import { settingsSchema } from '../server/settings';

test('holders get the whole loss back; hits and non-holders get nothing', () => {
  assert.equal(repayMicros(micros(25), micros(9.5), true), micros(15.5));
  assert.equal(repayMicros(micros(25), micros(40), true), 0, 'a hit has no loss');
  assert.equal(repayMicros(micros(25), micros(25), true), 0, 'break-even has no loss');
  assert.equal(repayMicros(micros(25), 0, true), micros(25), 'a worthless card repays the full price');
  assert.equal(repayMicros(micros(25), -5, true), micros(25), 'a negative value is treated as zero');
  assert.equal(repayMicros(micros(25), micros(9.5), false), 0, 'non-holders are not repaid');
  assert.equal(maxRepayReservation(micros(50), true), micros(50));
  assert.equal(maxRepayReservation(micros(50), false), 0);
});

test('the burn is the insured value, capped at X% of the free fund', () => {
  assert.equal(burnUsdMicros(micros(80), micros(1_000), 5_000), micros(80), 'a big fund burns the full value');
  assert.equal(burnUsdMicros(micros(80), micros(100), 5_000), micros(50), 'a small fund burns X% of itself');
  assert.equal(burnUsdMicros(micros(80), 0, 5_000), 0, 'an empty fund burns nothing');
  assert.equal(burnUsdMicros(micros(80), micros(100), 0), 0, 'a 0% cap burns nothing');
  assert.equal(burnUsdMicros(micros(80), micros(100), 10_000), micros(80), 'a 100% cap still burns at most the value');
  assert.equal(burnUsdMicros(micros(150), micros(100), 10_000), micros(100), 'a 100% cap can use the whole fund');
  assert.equal(burnUsdMicros(-1, micros(100), 5_000), 0);
});

test('burns are fixed in $CARDS and never promise more than is free', () => {
  // $0.25 per $CARDS = 0.25 USDC micros per unit.
  assert.equal(cardsForUsd(micros(10), 0.25, 1_000_000_000n), 40_000_000n, '$10 is 40 $CARDS');
  assert.equal(cardsForUsd(micros(10), 0.25, 5_000_000n), 5_000_000n, 'capped at what is free');
  assert.equal(cardsForUsd(micros(10), 0, 5_000_000n), 0n, 'an unknown price burns nothing');
  assert.equal(cardsForUsd(0, 0.25, 5_000_000n), 0n);
});

test('holder line and token units', () => {
  assert.equal(tokenUnits(1_000_000, 6), 1_000_000_000_000n);
  assert.equal(wholeTokens(1_234_500_000n, 6), '1234.5');
  assert.equal(wholeTokens(0n, 6), '0');
  assert.equal(isHolder(tokenUnits(1_000_000, 6), tokenUnits(1_000_000, 6)), true);
  assert.equal(isHolder(tokenUnits(999_999, 6), tokenUnits(1_000_000, 6)), false);
  assert.equal(isHolder(10n ** 20n, 0n), false, 'a 0 minimum switches repays off instead of covering everyone');
});

test('holder packs pause when free USDC cannot cover a full repay; non-holders never wait', () => {
  const s = DEFAULT_SETTINGS;
  assert.equal(quote(25, true, s, micros(25), 'pokemon_25').open, true);
  const paused = quote(25, true, s, micros(24.99), 'pokemon_25');
  assert.equal(paused.open, false);
  assert.match(paused.reason!, /refilling/);
  assert.equal(quote(25, false, s, 0, 'pokemon_25').open, true, 'non-holders open even with an empty reserve');
  assert.equal(quote(25, false, { ...s, pausedPacks: ['pokemon_25'] }, micros(1_000), 'pokemon_25').open, false);
  assert.equal(quote(25, true, { ...s, paused: true }, micros(1_000), 'pokemon_25').open, false);
  const fee = quote(100, false, { ...s, serviceFeeBps: 500 }, 0, 'pokemon_100');
  assert.deepEqual([fee.priceMicros, fee.feeMicros, fee.totalMicros], [micros(100), micros(5), micros(105)]);
});

test('defaults are valid settings and gas levels stay consistent', () => {
  assert.doesNotThrow(() => settingsSchema.parse(DEFAULT_SETTINGS));
  assert.throws(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, burnCapBps: 10_001 }));
  assert.throws(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, gas: { ...DEFAULT_SETTINGS.gas, treasuryMinSol: 0.02 } }), /gas reserve/);
});
