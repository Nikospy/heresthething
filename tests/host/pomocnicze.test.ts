import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { zbudujDistDlaTestow } from './pomocnicze';

const DIST = join(import.meta.dirname, '../../dist');

it('T217: kolejne wywołania nie przebudowują dist, gdy inny plik testów już go używa', async () => {
  await zbudujDistDlaTestow();
  // Build robi rm -rf dist/, więc przebudowa skasowałaby ten plik.
  const swiadek = join(DIST, '.swiadek-testu');
  writeFileSync(swiadek, 'x');
  try {
    await Promise.all([zbudujDistDlaTestow(), zbudujDistDlaTestow()]);
    expect(existsSync(swiadek)).toBe(true);
    expect(existsSync(join(DIST, 'host/host.mjs'))).toBe(true);
  } finally {
    rmSync(swiadek, { force: true });
  }
}, 120_000);
