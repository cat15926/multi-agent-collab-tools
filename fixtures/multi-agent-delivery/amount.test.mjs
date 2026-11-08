import assert from 'node:assert/strict';
import test from 'node:test';
import { amountInCents } from './amount.ts';

test('preserves zero, credit and debit amounts', () => {
  assert.equal(amountInCents(0), 0);
  assert.equal(amountInCents(1.25), 125);
  assert.equal(amountInCents(-1.25), -125);
});
