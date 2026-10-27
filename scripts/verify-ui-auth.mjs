import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './lib/harness.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { hashPassword } = await import('../server/auth.ts');

const users = [
  { email: 'admin@test.ua', role: 'admin', name: 'Олена Адмін', passwordHash: hashPassword('admin-password-1') },
  { email: 'view@test.ua', role: 'viewer', passwordHash: hashPassword('viewer-password-1') },
];
const srv = await startServer({ DOCAI_USERS: JSON.stringify(users), DOCAI_SESSION_SECRET: 'z'.repeat(40) });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', (e) => { if (!/WebSocket/.test(e.message)) errors.push(e.message); });
  await page.goto(srv.base);
  await page.getByRole('heading', { name: 'Вхід у робочий простір' }).waitFor();
  await page.getByLabel('Email або логін').fill('admin@test.ua');
  await page.getByLabel('Пароль').fill('wrong-password');
  await page.getByRole('button', { name: 'Увійти' }).click();
  await page.getByText('Невірний email або пароль').waitFor();
  await page.getByLabel('Пароль').fill('admin-password-1');
  await page.getByRole('button', { name: 'Увійти' }).click();
  await page.getByRole('heading', { name: 'Обробка документів' }).waitFor();
  await page.getByText('Олена Адмін').waitFor();
  await page.getByRole('button', { name: 'Шаблони', exact: true }).click();
  await page.getByText('Створити новий шаблон').waitFor();
  await page.getByRole('button', { name: 'Налаштування', exact: true }).click();
  await page.getByText('Користувачі та ролі').waitFor();
  await page.getByRole('button', { name: 'Вийти' }).click();
  await page.getByRole('heading', { name: 'Вхід у робочий простір' }).waitFor();

  // viewer: templates read-only
  await page.getByLabel('Email або логін').fill('view@test.ua');
  await page.getByLabel('Пароль').fill('viewer-password-1');
  await page.getByRole('button', { name: 'Увійти' }).click();
  await page.getByRole('heading', { name: 'Обробка документів' }).waitFor();
  await page.getByRole('button', { name: 'Шаблони', exact: true }).click();
  await page.getByText('Шаблони змінює лише адміністратор').waitFor();
  assert.equal(await page.getByText('Створити новий шаблон').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: UI login/logout, wrong password message, admin vs viewer rights.');
} finally {
  await browser.close();
  await srv.stop();
}
