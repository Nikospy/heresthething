import { fork } from 'node:child_process';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, test } from 'vitest';
import { wczytajMapowania } from '../../src/host/mapowania';
import { katalogTymczasowy } from './pomocnicze';
const katalog = katalogTymczasowy();

test('dwa procesy z barierą po pierwszym odczycie zachowują oba originy', async () => {
  writeFileSync(join(katalog, 'mapowania.json'), JSON.stringify({ wersja: 1, mapowania: {} }));
  const modul = join(katalog, 'mapowania.mjs');
  await build({ entryPoints: [join(import.meta.dirname, '../../src/host/mapowania.ts')], outfile: modul, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const dzieci: ReturnType<typeof fork>[] = [];
  function start(rola: string, origin: string) {
    const proces = fork(join(import.meta.dirname, 'fixtures/mapowania-worker.mjs'), [pathToFileURL(modul).href, katalog, rola, origin], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    dzieci.push(proces);
    const gotowy = new Promise<void>((r, e) => proces.on('message', m => {
      if (m === 'odczytano' || m === 'blokada') r();
      if (typeof m === 'object' && m && 'blad' in m) e(new Error(String(m.blad)));
    }));
    const koniec = new Promise<void>((r, e) => { proces.once('error', e); proces.once('exit', kod => kod === 0 ? r() : e(new Error(`Proces ${rola}: ${kod}`))); });
    return { proces, gotowy, koniec };
  }
  try {
    const a = start('pierwszy', 'https://a.test'); await a.gotowy;
    const b = start('drugi', 'https://b.test'); await b.gotowy;
    a.proces.send('zwolnij');
    await Promise.all([a.koniec, b.koniec]);
    expect(await wczytajMapowania(katalog)).toEqual(new Map([['https://a.test', '/repo/pierwszy'], ['https://b.test', '/repo/drugi']]));
  } finally { dzieci.forEach(p => p.kill()); }
}, 15_000);

test('błąd odczytu zwalnia własną blokadę i pozwala poprawić plik', async () => {
  const { zapiszMapowanie } = await import('../../src/host/mapowania');
  writeFileSync(join(katalog, 'mapowania.json'), '{');
  await expect(zapiszMapowanie(katalog, 'https://a.test', '/repo')).rejects.toThrow('uszkodzony');
  writeFileSync(join(katalog, 'mapowania.json'), JSON.stringify({ wersja: 1, mapowania: {} }));
  await zapiszMapowanie(katalog, 'https://a.test', '/repo');
  expect((await wczytajMapowania(katalog)).get('https://a.test')).toBe('/repo');
});

test('lock po ubitym procesie (stary mtime) jest przejmowany (H1)', async () => {
  const { zapiszMapowanie } = await import('../../src/host/mapowania');
  const kat = join(katalog, 'zastaly-lock');
  mkdirSync(kat, { recursive: true });
  writeFileSync(join(kat, 'mapowania.json'), JSON.stringify({ wersja: 1, mapowania: {} }));
  const lock = join(kat, 'mapowania.json.lock');
  mkdirSync(lock);
  const dawno = new Date(Date.now() - 20_000);
  utimesSync(lock, dawno, dawno);
  await zapiszMapowanie(kat, 'https://a.test', '/repo');
  expect((await wczytajMapowania(kat)).get('https://a.test')).toBe('/repo');
}, 15_000);

test('świeży lock blokuje zapis, a komunikat wskazuje ścieżkę locka (H1)', async () => {
  const { zapiszMapowanie } = await import('../../src/host/mapowania');
  const kat = join(katalog, 'swiezy-lock');
  mkdirSync(kat, { recursive: true });
  writeFileSync(join(kat, 'mapowania.json'), JSON.stringify({ wersja: 1, mapowania: {} }));
  mkdirSync(join(kat, 'mapowania.json.lock'));
  await expect(zapiszMapowanie(kat, 'https://a.test', '/repo')).rejects.toThrow('mapowania.json.lock');
}, 15_000);

test('przejmowanie locka: zastarzały schodzi ze ścieżki, świeży zostaje nietknięty (przegląd Z2)', async () => {
  const { przejmijZastarzalyLock } = await import('../../src/host/mapowania');
  const stary = join(katalog, 'lock-stary');
  mkdirSync(stary);
  const dawno = new Date(Date.now() - 20_000);
  utimesSync(stary, dawno, dawno);
  expect(await przejmijZastarzalyLock(stary)).toBe(true);
  expect(existsSync(stary)).toBe(false);

  const swiezy = join(katalog, 'lock-swiezy');
  mkdirSync(swiezy);
  expect(await przejmijZastarzalyLock(swiezy)).toBe(false);
  expect(existsSync(swiezy)).toBe(true);
});
