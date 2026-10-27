// Manage Doc.AI users.
//   npm run user -- add <email> <viewer|operator|admin> [name]   → local users file (development)
//   npm run user -- hash                                          → password hash for DOCAI_USERS (production)
//   npm run user -- list | remove <email>
// The password is read from DOCAI_NEW_PASSWORD or asked interactively (input hidden).
import readline from 'node:readline';

const { upsertLocalUser, deleteLocalUser, listUsers, hashPassword, publicUser } = await import('../server/auth.ts');
const [command, email, role, ...nameParts] = process.argv.slice(2);

async function askPassword(prompt = 'Пароль (мін. 10 символів): ') {
  if (process.env.DOCAI_NEW_PASSWORD) return process.env.DOCAI_NEW_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(s); };
  const answer = await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
  process.stdout.write('\n');
  return String(answer);
}

try {
  if (command === 'add') {
    if (!email || !role) throw new Error('Використання: npm run user -- add <email> <viewer|operator|admin> [ім’я]');
    const user = upsertLocalUser({ email, role, password: await askPassword(), name: nameParts.join(' ') || undefined });
    console.log(`Збережено: ${user.email} (${user.role}). Файл: ${process.env.LOCAL_SETTINGS_DIR || '.data/settings'}/users.json`);
  } else if (command === 'hash') {
    const hash = hashPassword(await askPassword());
    console.log(JSON.stringify({ email: email || 'admin@company.example', role: role || 'admin', passwordHash: hash }));
    console.log('Додайте цей об’єкт у масив DOCAI_USERS=[…] у середовищі сервера.');
  } else if (command === 'list') {
    console.table(listUsers().map(publicUser));
  } else if (command === 'remove') {
    deleteLocalUser(email);
    console.log(`Видалено: ${email}`);
  } else {
    console.log('Команди: add <email> <role> [ім’я] | hash [email] [role] | list | remove <email>');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
