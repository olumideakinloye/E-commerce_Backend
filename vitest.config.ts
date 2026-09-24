import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@config': path.resolve(import.meta.dirname, './src/config'),
      '@common': path.resolve(import.meta.dirname, './src/common'),
      '@modules': path.resolve(import.meta.dirname, './src/modules'),
      '@infra': path.resolve(import.meta.dirname, './src/infra'),
    },
  },
});
