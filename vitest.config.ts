import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Same build-time constants as scripts/build-lokalny.mjs injects into the bundles.
export default defineConfig({
  define: {
    HASH_BUILDY: '"test-hash"',
    WERSJA_PAKIETU: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
