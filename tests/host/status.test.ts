import { mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { czytajObecnosc, czytajStatus, walidujStatus } from '../../src/host/status';
import { LIMITY_STATUSU } from '../../src/wspolne/protokol';
import { katalogTymczasowy, nowyRepo, binarkiPrawdziwe } from './pomocnicze';
import { obsluzZadanie } from '../../src/host/dyspozytor';

const baza = katalogTymczasowy();
const repo = nowyRepo(baza, 'repo');
const id = '2026-10-09-1600-status';
const katalog = join(repo, '.scratch/uwagi-ui', id);
const status = join(katalog, 'status.json');
const wpis = { numer: 1, stan: 'zrobione', komentarz: '<img src=x onerror=alert(1)>' };
const odczytany = { ...wpis, stan: 'done' };
beforeEach(() => {
  rmSync(join(repo, '.scratch'), { recursive: true, force: true });
  rmSync(join(repo, '.herestt'), { recursive: true, force: true });
  mkdirSync(katalog, { recursive: true });
  writeFileSync(join(katalog, 'uwagi.json'), JSON.stringify({ uwagi: [{ numer: 1 }, { numer: 2 }] }));
});
test('brakujący id przy złym .scratch to brak, nie niepoprawny', async () => {
  rmSync(join(repo, '.scratch'), { recursive: true, force: true });
  symlinkSync(baza, join(repo, '.scratch'));
  expect(await czytajStatus(repo, '2026-11-05-1500-nikogo')).toMatchObject({ plik: 'brak', statusy: [], historyjka: [] });
  rmSync(join(repo, '.scratch'));
  writeFileSync(join(repo, '.scratch'), 'plik');
  expect(await czytajStatus(repo, '2026-11-05-1500-nikogo')).toMatchObject({ plik: 'brak' });
});

test('null w status.json nie rzuca', () => {
  expect(() => walidujStatus({ uwagi: [null] }, { uwagi: [{ numer: 1 }] })).not.toThrow();
  expect(walidujStatus({ uwagi: [null] }, { uwagi: [{ numer: 1 }] })).toBeNull();
});

test('brak pliku i poprawna pełna odpowiedź', async () => {
  expect(await czytajStatus(repo, id)).toMatchObject({ plik: 'brak', statusy: [], historyjka: [] });
  writeFileSync(status, JSON.stringify({ uwagi: [wpis] }));
  expect(await czytajStatus(repo, id)).toMatchObject({ plik: 'jest', statusy: [odczytany], historyjka: [] });
});
test.each([
  '{', JSON.stringify({ uwagi: [{ ...wpis, numer: 3 }] }),
  JSON.stringify({ uwagi: [wpis, wpis] }), JSON.stringify({ uwagi: [{ ...wpis, komentarz: 'x'.repeat(501) }] }),
  JSON.stringify({ uwagi: [{ ...wpis, stan: 'inne' }] }), JSON.stringify({ uwagi: [{ ...wpis, stan: ['zrobione'] }] }), JSON.stringify({ uwagi: [wpis], inne: true }),
  JSON.stringify({ uwagi: [{ ...wpis, plik: '../inny' }] }), JSON.stringify({ uwagi: [{ ...wpis, numer: 1.5 }] }),
  JSON.stringify({ uwagi: Array(501).fill(wpis) }), ' '.repeat(LIMITY_STATUSU.plikBajty + 1),
])('niepoprawny plik nie zwraca częściowych statusów (%#)', async tresc => {
  writeFileSync(status, tresc);
  expect(await czytajStatus(repo, id)).toMatchObject({ plik: 'niepoprawny', statusy: [], historyjka: [] });
});
test.each(['status.json', 'uwagi.json'])('odrzuca symlink %s, nie czyta wskazanego pliku', async nazwa => {
  writeFileSync(status, JSON.stringify({ uwagi: [wpis] }));
  const obcy = join(baza, 'obcy.json'); writeFileSync(obcy, JSON.stringify({ uwagi: [wpis] }));
  rmSync(join(katalog, nazwa)); symlinkSync(obcy, join(katalog, nazwa));
  expect(await czytajStatus(repo, id)).toMatchObject({ plik: 'niepoprawny', statusy: [], historyjka: [] });
});
test('odrzuca symlink katalogu paczki i katalog zamiast pliku', async () => {
  mkdirSync(status);
  expect(await czytajStatus(repo, id)).toMatchObject({ plik: 'niepoprawny', statusy: [], historyjka: [] });
  rmSync(katalog, { recursive: true }); symlinkSync(baza, katalog);
  expect(await czytajStatus(repo, id)).toMatchObject({ plik: 'niepoprawny', statusy: [], historyjka: [] });
});
test('odrzuca .. przed odczytem dysku oraz brak potwierdzonego mapowania', async () => {
  await expect(czytajStatus(repo, '../../obcy')).rejects.toMatchObject({ kod: 'id_niepoprawne' });
  const k = { katalog: baza, konfiguracja: { wersja: 1 as const, idWtyczki: 'ext', binarki: binarkiPrawdziwe() } };
  const z = { wersja: 2, idZadania: 's', typ: 'status', origin: 'https://status.example', idPaczki: id };
  expect(await obsluzZadanie(k, z)).toMatchObject({ ok: false, kod: 'projekt_nieznany' });
  expect(await obsluzZadanie(k, { ...z, idPaczki: '../x' })).toMatchObject({ ok: false, kod: 'id_niepoprawne' });
  expect(await obsluzZadanie(k, { ...z, typ: 'mapuj', projekt: repo })).toMatchObject({ ok: true });
  writeFileSync(status, JSON.stringify({ uwagi: [wpis] }));
  expect(await obsluzZadanie(k, z)).toMatchObject({ ok: true, typ: 'status', plik: 'jest', statusy: [odczytany], historyjka: [] });
});
test('cały plik odrzucony przy jednym złym wpisie, granica 500 komentarza dopuszczona', () => {
  expect(walidujStatus({ uwagi: [wpis, { ...wpis, numer: 99 }] }, { uwagi: [{ numer: 1 }] })).toBeNull();
  expect(walidujStatus({ uwagi: [{ ...wpis, komentarz: 'x'.repeat(500) }] }, { uwagi: [{ numer: 1 }] })).toHaveLength(1);
});

test('R11: numer rysunku z planszy działa jak uwaga, obcy numer odrzucony, paczka bez rysunków bez zmian', () => {
  const rysunek = { id: 'r1', numer: 2, komentarz: 'x', kreski: [] };
  const paczkaZPlanem = { uwagi: [{ numer: 1 }], plansza: { rysunki: [rysunek, { id: 'r2', numer: null, komentarz: '', kreski: [] }] } };
  expect(walidujStatus({ uwagi: [{ ...wpis, numer: 2 }] }, paczkaZPlanem)).toHaveLength(1);
  expect(walidujStatus({ uwagi: [{ ...wpis, numer: 3 }] }, paczkaZPlanem)).toBeNull();
  // Rysunek bez numeru (null) nie otwiera statusu; brak pola rysunki to jak stara paczka.
  expect(walidujStatus({ uwagi: [{ ...wpis, numer: 2 }] }, { uwagi: [{ numer: 1 }], plansza: {} })).toBeNull();
  // Numer unikalny w sumie uwag i rysunków: duplikat w paczce odrzuca całą walidację.
  expect(walidujStatus({ uwagi: [{ ...wpis, numer: 1 }] }, { uwagi: [{ numer: 1 }], plansza: { rysunki: [{ ...rysunek, numer: 1 }] } })).toBeNull();
  expect(walidujStatus({ uwagi: [wpis] }, { uwagi: [{ numer: 1 }] })).toHaveLength(1);
});

test('status i deliver używają potwierdzonego mapowania localhost po zatrzymaniu serwera (W3)', async () => {
  const { zapiszMapowanie } = await import('../../src/host/mapowania');
  const origin = 'http://localhost:38765';
  await zapiszMapowanie(baza, origin, repo);
  const k = { katalog: baza, konfiguracja: { wersja: 1 as const, idWtyczki: 'ext', binarki: { ...binarkiPrawdziwe(), lsof: '/usr/bin/false' } } };
  writeFileSync(status, JSON.stringify({ uwagi: [wpis] }));
  writeFileSync(join(katalog, 'uwagi.md'), '# x');
  const z = { wersja: 2, idZadania: 'pozniej', origin, idPaczki: id };
  expect(await obsluzZadanie(k, { ...z, typ: 'status' })).toMatchObject({ ok: true, plik: 'jest', statusy: [odczytany], historyjka: [] });
  // Port pusty (lsof fałszywy): paczka już jest w nowym katalogu, więc deliver kończy się „istniejaca”
  // bez ponawiania promptu (idempotencja); właściciel domknie go jawnym „Dostarcz agentowi”.
  const nowy = join(repo, '.herestt', id);
  mkdirSync(nowy, { recursive: true });
  writeFileSync(join(nowy, 'uwagi.md'), '# x');
  expect(await obsluzZadanie(k, { ...z, typ: 'deliver', agent: { paneId: 'w1:p1', terminalId: 't', sesjaAgenta: null }, markdown: '# x', json: '{}', zrzuty: [] })).toMatchObject({ ok: true, paczka: 'istniejaca', prompt: 'pominiety' });
});

test('v2 rozdziela numery uwag i historyjki oraz odrzuca obce numery', async () => {
  writeFileSync(join(katalog, 'uwagi.json'), JSON.stringify({ uwagi: [{ numer: 1 }], historyjka: { zrzuty: [{ adnotacje: [{ numer: 1 }, { numer: 2 }] }] } }));
  writeFileSync(status, JSON.stringify({ uwagi: [wpis], historyjka: [{ ...wpis, stan: 'pytanie' }] }));
  expect(await czytajStatus(repo, id)).toMatchObject({ plik: 'jest', statusy: [odczytany], historyjka: [{ ...odczytany, stan: 'question' }] });
  writeFileSync(status, JSON.stringify({ uwagi: [], historyjka: [{ ...wpis, numer: 3 }] }));
  expect(await czytajStatus(repo, id)).toMatchObject({ plik: 'niepoprawny', statusy: [], historyjka: [] });
});

const czeka = join(repo, '.scratch/uwagi-ui', '.agent-czeka');
function znacznik(wiekMs: number) {
  writeFileSync(czeka, '');
  const t = new Date(Date.now() - wiekMs);
  utimesSync(czeka, t, t);
}

test('znacznik tylko w starym katalogu jest czytany, a plik w .herestt wygrywa nawet gdy jest nieświeży', async () => {
  znacznik(1_000);
  expect(await czytajObecnosc(repo)).toBe(true);
  const nowy = join(repo, '.herestt', '.agent-czeka');
  mkdirSync(join(repo, '.herestt'), { recursive: true });
  writeFileSync(nowy, '');
  const t = new Date(Date.now() - 11_000);
  utimesSync(nowy, t, t);
  expect(await czytajObecnosc(repo)).toBe(false);
});

test('R7: świeży znacznik czekania daje true, starszy niż 10 s, z przyszłości albo dowiązanie daje false', async () => {
  expect(await czytajObecnosc(repo)).toBe(false);
  znacznik(1_000);
  expect(await czytajObecnosc(repo)).toBe(true);
  znacznik(11_000);
  expect(await czytajObecnosc(repo)).toBe(false);
  znacznik(-60_000);
  expect(await czytajObecnosc(repo)).toBe(false);
  rmSync(czeka);
  const obcy = join(baza, 'obcy-czeka'); writeFileSync(obcy, '');
  symlinkSync(obcy, czeka);
  expect(await czytajObecnosc(repo)).toBe(false);
});

test('R8: status niesie agent.czeka i agent.odebrane, a obecnosc odpowiada dla projektu', async () => {
  const origin = 'https://obecnosc.example';
  const k = { katalog: baza, konfiguracja: { wersja: 1 as const, idWtyczki: 'ext', binarki: binarkiPrawdziwe() } };
  const z = { wersja: 2, idZadania: 'o', origin };
  expect(await obsluzZadanie(k, { ...z, typ: 'obecnosc' })).toMatchObject({ ok: false, kod: 'projekt_nieznany' });
  await obsluzZadanie(k, { ...z, typ: 'mapuj', projekt: repo });
  expect(await obsluzZadanie(k, { ...z, typ: 'obecnosc' })).toMatchObject({ ok: true, typ: 'obecnosc', czeka: false });
  znacznik(500);
  writeFileSync(join(katalog, 'odebrane.json'), '{}');
  expect(await obsluzZadanie(k, { ...z, typ: 'obecnosc' })).toMatchObject({ ok: true, typ: 'obecnosc', czeka: true });
  expect(await obsluzZadanie(k, { ...z, typ: 'status', idPaczki: id })).toMatchObject({ ok: true, typ: 'status', agent: { czeka: true, odebrane: true } });
  // błąd znacznika (katalog zamiast pliku) nie psuje odpowiedzi
  rmSync(czeka); mkdirSync(czeka);
  rmSync(join(katalog, 'odebrane.json')); mkdirSync(join(katalog, 'odebrane.json'));
  expect(await obsluzZadanie(k, { ...z, typ: 'status', idPaczki: id })).toMatchObject({ ok: true, plik: 'brak', agent: { czeka: false, odebrane: false } });
});
