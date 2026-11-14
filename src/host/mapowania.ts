import { constants as C, promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BladHosta } from './bledy';

/**
 * Mapowanie origin → projekt trzyma host (recenzja W9): wtyczka nie może
 * wskazać dowolnego repo do zapisu, bo `deliver` podaje tylko origin.
 * Zmiana mapowania to osobne, jawne zadanie `mapuj`.
 *
 * Uszkodzony plik to błąd, nie pusta lista — cichy reset (jak w in-app
 * `wczytajSesje`) ukryłby utratę mapowań (recenzja D5).
 */

export const PLIK_MAPOWAN = 'mapowania.json';

/**
 * Przejęcie locka starszego niż 10 s (zostawionego przez SIGKNILOWANY proces).
 * Kasujemy go tylko wtedy, gdy dwa kolejne staty zobaczą dokładnie ten sam
 * (ino + mtime) zastarzały katalog — między statami ktoś mógł wstawić świeży
 * lock i bezwarunkowy rmdir zrobiłoby z nas dwóch posiadaczy naraz
 * (przegląd runda 3, Z2). Zwraca true, gdy lock został przejęty.
 */
export async function przejmijZastarzalyLock(blokada: string): Promise<boolean> {
  try {
    const zastarzaly = await fsp.stat(blokada);
    if (Date.now() - zastarzaly.mtimeMs <= 10_000) return false;
    const nadal = await fsp.stat(blokada);
    if (nadal.ino !== zastarzaly.ino || nadal.mtimeMs !== zastarzaly.mtimeMs) return false;
    await fsp.rmdir(blokada);
    return true;
  } catch {
    return false; // lock zniknął sam albo w trakcie — próbuj dalej
  }
}

type PlikMapowan = { wersja: 1; mapowania: Record<string, string> };

export async function wczytajMapowania(katalog: string): Promise<Map<string, string>> {
  let surowe: string;
  try {
    const st = await fsp.lstat(join(katalog, PLIK_MAPOWAN));
    if (!st.isFile()) throw new BladHosta('konfiguracja', `${PLIK_MAPOWAN} nie jest zwykłym plikiem`);
    surowe = await fsp.readFile(join(katalog, PLIK_MAPOWAN), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw e;
  }
  let plik: unknown;
  try {
    plik = JSON.parse(surowe);
  } catch {
    throw new BladHosta('konfiguracja', `${PLIK_MAPOWAN} jest uszkodzony — popraw albo usuń ręcznie`);
  }
  const p = plik as Partial<PlikMapowan> | null;
  if (typeof p !== 'object' || p === null || p.wersja !== 1 || typeof p.mapowania !== 'object' || p.mapowania === null) {
    throw new BladHosta('konfiguracja', `${PLIK_MAPOWAN}: nieobsługiwany format`);
  }
  const wynik = new Map<string, string>();
  for (const [origin, projekt] of Object.entries(p.mapowania)) {
    if (typeof projekt === 'string') wynik.set(origin, projekt);
  }
  return wynik;
}

/** Blokada między procesami obejmuje odczyt, zmianę i publikację całego pliku. */
export async function zapiszMapowanie(katalog: string, origin: string, projekt: string): Promise<void> {
  const blokada = join(katalog, `${PLIK_MAPOWAN}.lock`);
  const termin = Date.now() + 2000;
  for (;;) {
    try { await fsp.mkdir(blokada, { mode: 0o700 }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Lock po ubitym procesie przejmujemy po 10 s — inaczej każdy kolejny
      // zapis kończyłby się tym samym błędem.
      if (await przejmijZastarzalyLock(blokada)) continue;
      if (Date.now() >= termin) {
        throw new BladHosta('konfiguracja', `mapowania.json jest zablokowany przez inny zapis — jeśli żaden nie trwa, usuń ${blokada}`);
      }
      await new Promise(r => setTimeout(r, 25));
    }
  }
  const tmp = join(katalog, `.${PLIK_MAPOWAN}.${randomBytes(4).toString('hex')}`);
  try {
    const mapowania = await wczytajMapowania(katalog);
    mapowania.set(origin, projekt);
    const tresc: PlikMapowan = { wersja: 1, mapowania: Object.fromEntries([...mapowania].sort(([a], [b]) => a.localeCompare(b))) };
    const fh = await fsp.open(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    try { await fh.writeFile(`${JSON.stringify(tresc, null, 2)}\n`); }
    finally { await fh.close(); }
    await fsp.rename(tmp, join(katalog, PLIK_MAPOWAN));
  } finally {
    try { await fsp.rm(tmp, { force: true }); }
    finally { await fsp.rmdir(blokada); }
  }
}
