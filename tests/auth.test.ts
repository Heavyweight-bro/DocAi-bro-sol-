import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../server/auth';

describe('password hashing', () => {
  it('verifies the right password only', () => {
    const hash = hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery', hash)).toBe(true);
    expect(verifyPassword('wrong password!!', hash)).toBe(false);
  });
  it('rejects short passwords and malformed hashes', () => {
    expect(() => hashPassword('short')).toThrow();
    expect(verifyPassword('anything', 'md5$abc')).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
  });
});

describe('admin/admin test login', async () => {
  const { listUsers, authStatus } = await import('../server/auth');
  const env = { ...process.env };
  it('exists only with DOCAI_DEMO_ADMIN=true outside production', () => {
    process.env.DOCAI_DEMO_ADMIN = 'true';
    process.env.NODE_ENV = 'development';
    const demo = listUsers().find((u) => u.email === 'admin');
    expect(demo?.role).toBe('admin');
    expect(verifyPassword('admin', demo!.passwordHash)).toBe(true);
    expect(verifyPassword('Admin', demo!.passwordHash)).toBe(false);
  });
  it('is never enabled in production or on Vercel', () => {
    process.env.DOCAI_DEMO_ADMIN = 'true';
    process.env.NODE_ENV = 'production';
    expect(listUsers().some((u) => u.email === 'admin')).toBe(false);
    process.env.NODE_ENV = 'development';
    process.env.VERCEL = '1';
    expect(listUsers().some((u) => u.email === 'admin')).toBe(false);
    Object.assign(process.env, env);
    delete process.env.VERCEL;
    delete process.env.DOCAI_DEMO_ADMIN;
    void authStatus;
  });
});
