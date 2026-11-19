import { expect, it } from 'vitest';
import { confirmedLiveModel } from '../src/host/liveModel';

const gemini = 'google-gemini/gemini-3-5-flash-lite';
const other = 'custom/paid';

it('checks the effective model before accepting free-tier confirmation', () => {
  expect(confirmedLiveModel(['--free-tier-confirmed'])).toBe(gemini);
  expect(confirmedLiveModel(['--free-tier-confirmed', '--model', gemini], other)).toBe(gemini);
  expect(() => confirmedLiveModel(['--free-tier-confirmed'], other)).toThrow(other);
  expect(() => confirmedLiveModel(['--free-tier-confirmed', '--model', other], gemini)).toThrow(other);
});

it('requires explicit cost confirmation for another model', () => {
  expect(confirmedLiveModel(['--cost-confirmed'], other)).toBe(other);
  expect(confirmedLiveModel(['--free-tier-confirmed', '--cost-confirmed'], other)).toBe(other);
  expect(() => confirmedLiveModel([], gemini)).toThrow(/confirm/i);
  expect(() => confirmedLiveModel(['--model', '--cost-confirmed'])).toThrow(/provider\/model/);
});
