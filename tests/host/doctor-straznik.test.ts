import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * S-33 faza 5 (D19): strażnik statyczny. To zabezpieczenie przed cichym dopisaniem sieci albo zapisu,
 * nie dowód ruchu sieciowego (ten to test D9 z etapu 2).
 */

const KORZEN = join(import.meta.dirname, '../..');
const zrodlo = (sciezka: string): string =>
  readFileSync(join(KORZEN, sciezka), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// Publiczne repo części lokalnej (S-37) nie ma wtyczki. W repo z wtyczką raport musi istnieć: brak pliku przerywa test.
const Z_WTYCZKA = existsSync(join(KORZEN, 'src/ext'));
const RAPORT_WTYCZKI = Z_WTYCZKA ? ['src/ext/polaczenie/raport.ts'] : [];
const PLIKI = ['src/wspolne/diagnostyka.ts', 'src/host/doctor.ts', ...RAPORT_WTYCZKI];
const SIEC = /node:(net|http|https|http2|dns|tls|dgram)\b|\bundici\b|\bfetch\s*\(|XMLHttpRequest|\bWebSocket\b|sendBeacon|EventSource/;
const ZAPIS = /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|chmod|chmodSync|copyFile|copyFileSync|createWriteStream|symlink|symlinkSync|truncate|truncateSync)\b/;

describe('D19 strażnik diagnostyki', () => {
  test.each(PLIKI)('%s nie sięga do sieci', plik => {
    expect(zrodlo(plik).match(SIEC)?.[0]).toBeUndefined();
  });

  test('doctor.ts nie importuje ani nie woła funkcji zapisu', () => {
    expect(zrodlo('src/host/doctor.ts').match(ZAPIS)?.[0]).toBeUndefined();
  });

  test('doctor.ts nie woła mcp add ani mcp remove', () => {
    expect(zrodlo('src/host/doctor.ts')).not.toMatch(/['"]add['"]|['"]remove['"]/);
  });

  test('rdzeń wspólny i raport wtyczki nie importują niczego z node:* ani z hosta', () => {
    for (const plik of ['src/wspolne/diagnostyka.ts', ...RAPORT_WTYCZKI]) {
      const importy = [...zrodlo(plik).matchAll(/from\s+'([^']+)'/g)].map(m => m[1] ?? '');
      for (const i of importy) {
        expect(i, `${plik}: ${i}`).not.toMatch(/^node:|host\//);
      }
    }
  });

  test('strażnik widzi to, czego pilnuje (kontrola pozytywna)', () => {
    expect('import x from "node:http"').toMatch(SIEC);
    expect('fetch(url)').toMatch(SIEC);
    expect('writeFileSync(a, b)').toMatch(ZAPIS);
    expect('lstatSync(a)').not.toMatch(ZAPIS);
  });
});
