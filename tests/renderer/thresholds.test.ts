import { describe, it, expect } from 'vitest';
import { classifyUsed, classifyFree, classifyTemp } from '../../src/renderer/lib/thresholds.js';

describe('classifyUsed', () => {
  it('returns good below warn threshold', () => {
    expect(classifyUsed(50, 80, 90)).toBe('good');
  });
  it('returns warn at or above warn threshold but below crit', () => {
    expect(classifyUsed(80, 80, 90)).toBe('warn');
    expect(classifyUsed(85, 80, 90)).toBe('warn');
  });
  it('returns crit at or above crit threshold', () => {
    expect(classifyUsed(90, 80, 90)).toBe('crit');
    expect(classifyUsed(99, 80, 90)).toBe('crit');
  });
});

describe('classifyFree', () => {
  it('returns crit at or below crit threshold', () => {
    expect(classifyFree(5, 20, 10)).toBe('crit');
    expect(classifyFree(10, 20, 10)).toBe('crit');
  });
  it('returns warn at or below warn threshold but above crit', () => {
    expect(classifyFree(15, 20, 10)).toBe('warn');
    expect(classifyFree(20, 20, 10)).toBe('warn');
  });
  it('returns good above warn threshold', () => {
    expect(classifyFree(50, 20, 10)).toBe('good');
  });
});

describe('classifyTemp', () => {
  it('returns good below warn', () => {
    expect(classifyTemp(65, 75, 90)).toBe('good');
  });
  it('returns warn at or above warn, below crit', () => {
    expect(classifyTemp(82, 75, 90)).toBe('warn');
  });
  it('returns crit at or above crit', () => {
    expect(classifyTemp(95, 75, 90)).toBe('crit');
  });
});
