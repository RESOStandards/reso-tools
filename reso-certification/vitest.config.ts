import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**', 'src/**/index.ts'],
      reporter: ['text', 'json-summary'],
    },
    benchmark: {
      include: ['benchmarks/**/*.bench.ts'],
      outputJson: 'benchmarks/results.json',
    },
  },
});
