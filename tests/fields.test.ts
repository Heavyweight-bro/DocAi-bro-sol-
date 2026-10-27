import { describe, expect, it } from 'vitest';
import { coerceInput, flattenForExport, formatPath, getIn, parsePath, setIn } from '../src/lib/fields';

describe('field paths', () => {
  it('round-trips dotted and indexed paths', () => {
    expect(parsePath('items[2].amount')).toEqual(['items', 2, 'amount']);
    expect(formatPath(['items', 2, 'amount'])).toBe('items[2].amount');
    expect(formatPath(['supplier', 'edrpou'])).toBe('supplier.edrpou');
  });

  it('sets values immutably and creates missing parents', () => {
    const root = { a: { b: 1 } };
    const next = setIn(root, ['a', 'c', 0, 'd'], 5);
    expect(root).toEqual({ a: { b: 1 } });
    expect(getIn(next, ['a', 'c', 0, 'd'])).toBe(5);
    expect(Array.isArray(next.a.c)).toBe(true);
  });
});

describe('coerceInput', () => {
  it('keeps numbers numeric and accepts a decimal comma', () => {
    expect(coerceInput('1 234,50', 10)).toBe(1234.5);
    expect(coerceInput('300', null, { type: 'number' })).toBe(300);
    expect(coerceInput('12', null, { format: 'money' })).toBe(12);
  });
  it('turns empty input into null and keeps non-numbers as typed text', () => {
    expect(coerceInput('  ', 'x')).toBeNull();
    expect(coerceInput('abc', 5)).toBe('abc');
    expect(coerceInput('0012', 'x')).toBe('0012'); // ЄДРПОУ with leading zeros stays text
  });
});

describe('flattenForExport', () => {
  it('flattens objects, splits object lists into tables and skips internal keys', () => {
    const { row, tables } = flattenForExport({ n: 'INV', supplier: { name: 'A' }, items: [{ q: 1 }, { q: 2 }], tags: ['a', 'b'], _status: 'x' });
    expect(row).toEqual({ n: 'INV', 'supplier.name': 'A', tags: 'a; b' });
    expect(tables.items).toEqual([{ q: 1 }, { q: 2 }]);
  });
});
