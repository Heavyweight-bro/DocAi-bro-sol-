import assert from 'node:assert/strict';

const { validateAgainstSchema, schemaForSlug, normalizeTemplateSchema, isValidEdrpou, isValidRnokpp, isValidIban } = await import('../server/schemas.ts');

assert.ok(schemaForSlug('invoice'));
assert.ok(schemaForSlug('act'));
assert.ok(schemaForSlug('act-of-works'));
assert.equal(schemaForSlug('translate'), null);
assert.equal(schemaForSlug('custom'), null);

const goodInvoice = {
  invoice_number: 'INV-1',
  date: '2026-03-01',
  supplier: { name: 'A', edrpou: '14360570' },
  customer: { name: 'B', edrpou: '40075815' },
  currency: 'UAH',
  total: 100,
  items: [{ description: 'x', quantity: 1, unit_price: 100, amount: 100 }],
};
assert.equal(validateAgainstSchema(goodInvoice, 'invoice').ok, true);

const badInvoice = { invoice_number: 'INV-1', total: '100', currency: 'грн' };
const bad = validateAgainstSchema(badInvoice, 'invoice');
assert.equal(bad.ok, false);
assert.ok(bad.errors.some((e) => e.path === 'date'));
assert.ok(bad.errors.some((e) => e.path === 'currency'));
assert.ok(bad.errors.some((e) => e.path === 'total'));

const textPayload = { format: 'text', content: 'hello' };
assert.equal(validateAgainstSchema(textPayload, 'invoice').ok, false);

const goodAct = {
  act_number: 'A-1',
  date: '2026-01-15',
  contractor: 'ТОВ А',
  customer: 'ТОВ Б',
  currency: 'EUR',
  total: 50.5,
  services: [{ description: 'work', quantity: 1, price: 50.5, amount: 50.5 }],
};
assert.equal(validateAgainstSchema(goodAct, 'act').ok, true);
assert.equal(validateAgainstSchema(goodAct, 'translate').ok, true);

// Identifiers: real public codes pass, one-digit typos fail.
for (const code of ['00032129', '14360570', '40075815']) assert.equal(isValidEdrpou(code), true, code);
for (const code of ['00032128', '14360571', '1234567']) assert.equal(isValidEdrpou(code), false, code);
assert.equal(isValidIban('UA213223130000026007233566001'), true);
assert.equal(isValidIban('UA21 3223 1300 0002 6007 2335 6600 1'), true, 'spaces tolerated');
assert.equal(isValidIban('UA213223130000026007233566002'), false);
assert.equal(isValidIban('UA2132231300000260072335660'), false, 'UA length');
assert.equal(isValidRnokpp('12345'), false);

// Cross-field checks
const withLines = (over) => ({ ...goodInvoice, items: [{ description: 'a', quantity: 2, unit_price: 50, amount: 100 }], total: 100, ...over });
assert.equal(validateAgainstSchema(withLines({}), 'invoice').ok, true);
let r = validateAgainstSchema(withLines({ total: 120 }), 'invoice');
assert.equal(r.ok, false);
assert.ok(r.errors.some(e => e.path === 'total' && e.severity === 'error'));
assert.equal(validateAgainstSchema(withLines({ subtotal: 100, vat: 20, total: 120 }), 'invoice').ok, true, 'lines + VAT = total');
r = validateAgainstSchema(withLines({ items: [{ quantity: 2, unit_price: 50, amount: 90 }], total: 90 }), 'invoice');
assert.equal(r.ok, true, 'line math mismatch is a warning, not a blocker');
assert.ok(r.errors.some(e => e.path === 'items[0].amount' && e.severity === 'warning'));
r = validateAgainstSchema(withLines({ subtotal: 100, vat: 15, total: 115 }), 'invoice');
assert.ok(r.errors.some(e => e.path === 'vat' && e.severity === 'warning'), 'unusual VAT rate warns');
r = validateAgainstSchema(withLines({ supplier: { name: 'A', edrpou: '14360571' } }), 'invoice');
assert.ok(r.errors.some(e => e.path === 'supplier.edrpou'), 'bad ЄДРПОУ blocks');
assert.equal(validateAgainstSchema({ ...withLines({}), date: '2026-02-30' }, 'invoice').ok, false, 'impossible date');

// Custom template schemas
assert.equal(normalizeTemplateSchema('invoice'), 'invoice', 'built-in stays a reference');
const custom = normalizeTemplateSchema({ fields: [{ path: 'payer.iban', type: 'string', format: 'iban', required: true }, { path: 'amount', type: 'number', format: 'money', required: true }] });
assert.equal(custom.fields.length, 2);
assert.equal(validateAgainstSchema({ payer: { iban: 'UA213223130000026007233566001' }, amount: 5 }, 'payment', custom).ok, true);
assert.equal(validateAgainstSchema({ payer: {}, amount: '5' }, 'payment', custom).errors.length, 2);
assert.equal(schemaForSlug('payment', 'invoice').title, 'Рахунок / Invoice', 'template may reference a built-in by name');
assert.equal(normalizeTemplateSchema(null), null);
assert.throws(() => normalizeTemplateSchema({ fields: [{ path: 'bad path!' }] }), /шлях/);
assert.throws(() => normalizeTemplateSchema({ fields: [{ path: 'a' }, { path: 'a' }] }), /повторюється/);
assert.throws(() => normalizeTemplateSchema('unknown'), /Невідома/);

console.log('PASS: schemas — required/format, ЄДРПОУ/РНОКПП/IBAN checksums, totals & VAT, warnings, custom template schemas.');
