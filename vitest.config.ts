import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: { LOCAL_SETTINGS_DIR: '.data/test-settings-vitest' },
  },
});
