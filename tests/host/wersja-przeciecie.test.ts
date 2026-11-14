import { expect, test } from 'vitest';
import { obsluzZadanie } from '../../src/host/dyspozytor';
import { binarkiPrawdziwe, katalogTymczasowy, nowyRepo } from './pomocnicze';

const baza = katalogTymczasowy('wersja-');
const repo = nowyRepo(baza, 'repo');
const k = { katalog: baza, konfiguracja: { wersja: 1 as const, idWtyczki: 'ext', binarki: binarkiPrawdziwe() } };
const szeroki = { od: 2, do: 3 };

test('restart SW: wersja od z przecięcia przechodzi, a błąd niesie tę wersję, nie sufit', async () => {
  const odp = await obsluzZadanie(k, {
    typ: 'obecnosc', origin: 'https://przyklad.test', wersja: 2, zakres: szeroki, idZadania: 'restart1',
  }, szeroki);
  expect(odp).toMatchObject({ ok: false, kod: 'projekt_nieznany', wersja: 2 });
});

test('udana odpowiedź inna niż ping niesie wersję zadania, nie maksimum', async () => {
  await obsluzZadanie(k, { typ: 'mapuj', origin: 'https://przyklad.test', projekt: repo, wersja: 2, zakres: szeroki, idZadania: 'mapuj1' }, szeroki);
  const odp = await obsluzZadanie(k, {
    typ: 'obecnosc', origin: 'https://przyklad.test', wersja: 2, zakres: szeroki, idZadania: 'obecna1',
  }, szeroki);
  expect(odp).toMatchObject({ ok: true, typ: 'obecnosc', wersja: 2 });
});

test('ping nadal wraca najwyższą wspólną wersją i wstrzykniętym zakresem hosta', async () => {
  const odp = await obsluzZadanie(k, { typ: 'ping', wersja: 2, zakres: szeroki, idZadania: 'ping1' }, szeroki);
  expect(odp).toMatchObject({ ok: true, typ: 'ping', wersja: 3, zakres: szeroki });
});

test('wersja spoza zakresu hosta {2,2} zostaje odrzucona', async () => {
  const odp = await obsluzZadanie(k, {
    typ: 'obecnosc', origin: 'https://przyklad.test', wersja: 3, zakres: szeroki, idZadania: 'poza1',
  }, { od: 2, do: 2 });
  expect(odp).toMatchObject({ ok: false, kod: 'wersja_nieobslugiwana' });
});
