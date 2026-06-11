import { describe, it, expect } from 'vitest';
import { isFresh } from '../../src/lib/state.js';

describe('isFresh', () => {
  const now = Date.parse('2026-06-11T12:00:00.000Z');

  it('is true for a timestamp in the future', () => {
    expect(isFresh('2026-06-11T15:00:00.000Z', now)).toBe(true);
  });

  it('is false for a timestamp in the past', () => {
    expect(isFresh('2026-06-11T09:00:00.000Z', now)).toBe(false);
  });

  it('is false at exactly the expiry instant', () => {
    expect(isFresh('2026-06-11T12:00:00.000Z', now)).toBe(false);
  });

  it('is false for an unparseable timestamp', () => {
    expect(isFresh('not-a-date', now)).toBe(false);
  });
});
