import { constants as C, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { LIMITY, LIMITY_STATUSU, PLIK_CZEKANIA, PLIK_ODBIORU, PROG_CZEKANIA_MS, stanKanoniczny, type StatusUwagi } from '../wspolne/protokol';
import { KATALOG_UWAG, KATALOG_UWAG_STARY, polozeniePaczki, stanKatalogu, zweryfikujIdPaczki } from './zapis';

type WynikStatusu = { plik: 'jest' | 'brak' | 'niepoprawny'; statusy: StatusUwagi[]; historyjka: StatusUwagi[]; agent: { czeka: boolean; odebrane: boolean } };
type WynikPliku = Omit<WynikStatusu, 'agent'>;
function rekord(w: unknown): w is Record<string, unknown> { return typeof w === 'object' && w !== null && !Array.isArray(w); }

function listaStatusow(surowe: unknown, pozycje: unknown): StatusUwagi[] | null {
  if (!Array.isArray(pozycje) || !Array.isArray(surowe)) return null;
  const numery = new Set<number>();
  for (const u of pozycje) {
    if (!rekord(u) || !Number.isSafeInteger(u.numer) || (u.numer as number) < 1 || numery.has(u.numer as number)) return null;
    numery.add(u.numer as number);
  }
  const widziane = new Set<number>();
  const wynik: StatusUwagi[] = [];
  for (const u of surowe) {
    if (!rekord(u)) return null;
    const stan = stanKanoniczny(u.stan);
    if (Object.keys(u).length !== 3 || !Number.isSafeInteger(u.numer) || !numery.has(u.numer as number) || widziane.has(u.numer as number) ||
        stan === null || typeof u.komentarz !== 'string' || u.komentarz.length > LIMITY_STATUSU.komentarzZnakow) return null;
    widziane.add(u.numer as number);
    wynik.push({ numer: u.numer as number, stan, komentarz: u.komentarz });
  }
  return wynik;
}

export function walidujStatusy(surowe: unknown, paczka: unknown): Pick<WynikStatusu, 'statusy' | 'historyjka'> | null {
  if (!rekord(surowe) || Object.keys(surowe).some(k => k !== 'uwagi' && k !== 'historyjka' && k !== 'plansza') || !rekord(paczka)) return null;
  let adnotacje: unknown[] = [];
  if (paczka.historyjka !== undefined) {
    if (!rekord(paczka.historyjka) || !Array.isArray(paczka.historyjka.zrzuty)) return null;
    for (const z of paczka.historyjka.zrzuty) {
      if (!rekord(z) || !Array.isArray(z.adnotacje)) return null;
      adnotacje.push(...z.adnotacje);
    }
  }
  // Numery rysunków planszy są z tej samej serii co uwagi; paczka bez planszy albo bez rysunków zostaje bez zmian.
  const rysunki = rekord(paczka.plansza) && Array.isArray(paczka.plansza.rysunki)
    ? paczka.plansza.rysunki.filter(r => rekord(r) && Number.isSafeInteger(r.numer) && (r.numer as number) >= 1)
    : [];
  const statusy = listaStatusow(surowe.uwagi, Array.isArray(paczka.uwagi) ? [...paczka.uwagi, ...rysunki] : paczka.uwagi);
  const historyjka = listaStatusow(surowe.historyjka ?? [], adnotacje);
  if (!statusy || !historyjka || statusy.length + historyjka.length > LIMITY_STATUSU.wpisow) return null;
  return { statusy, historyjka };
}

export function walidujStatus(surowe: unknown, paczka: unknown): StatusUwagi[] | null {
  return walidujStatusy(surowe, paczka)?.statusy ?? null;
}

async function czytajJson(sciezka: string, limit: number): Promise<unknown> {
  const st = await fsp.lstat(sciezka);
  if (!st.isFile() || st.size > limit) throw new Error('Niepoprawny plik statusu.');
  const plik = await fsp.open(sciezka, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const otwarty = await plik.stat();
    if (!otwarty.isFile() || otwarty.size > limit || otwarty.ino !== st.ino || otwarty.dev !== st.dev) throw new Error('Plik zmienił się podczas otwierania.');
    const bufor = Buffer.alloc(limit + 1);
    let ile = 0;
    while (ile < bufor.length) {
      const { bytesRead } = await plik.read(bufor, ile, bufor.length - ile, ile);
      if (!bytesRead) break;
      ile += bytesRead;
    }
    if (ile > limit) throw new Error('Za duży plik.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bufor.subarray(0, ile)));
  } finally { await plik.close(); }
}

/** Zwykły plik (nie dowiązanie); każdy błąd odczytu to „nie ma”. */
async function zwyklyPlik(sciezka: string): Promise<import('node:fs').Stats | null> {
  try {
    const st = await fsp.lstat(sciezka);
    return st.isFile() ? st : null;
  } catch { return null; }
}

/** Świeży znacznik czekania; mtime z przyszłości ponad próg to też `false`. Najpierw `.herestt`, a gdy pliku nie ma — stary katalog. */
export async function czytajObecnosc(projekt: string): Promise<boolean> {
  const korzen = await stanKatalogu(join(projekt, KATALOG_UWAG));
  if (korzen === 'zly') return false;
  if (korzen === 'jest') {
    const teraz = await swiezoscZnacznika(join(projekt, KATALOG_UWAG, PLIK_CZEKANIA));
    if (teraz !== 'brak') return teraz === 'swiezy';
  }
  if ((await stanKatalogu(join(projekt, '.scratch'))) !== 'jest') return false;
  if ((await stanKatalogu(join(projekt, KATALOG_UWAG_STARY))) !== 'jest') return false;
  return (await swiezoscZnacznika(join(projekt, KATALOG_UWAG_STARY, PLIK_CZEKANIA))) === 'swiezy';
}

async function swiezoscZnacznika(sciezka: string): Promise<'brak' | 'swiezy' | 'nie'> {
  const st = await zwyklyPlik(sciezka);
  if (st === null) {
    try {
      await fsp.lstat(sciezka);
      return 'nie';
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'brak' : 'nie';
    }
  }
  const wiek = Date.now() - st.mtimeMs;
  return wiek <= PROG_CZEKANIA_MS && wiek >= -PROG_CZEKANIA_MS ? 'swiezy' : 'nie';
}

export async function czytajStatus(projekt: string, suroweId: unknown): Promise<WynikStatusu> {
  const idPaczki = zweryfikujIdPaczki(suroweId);
  const gdzie = await polozeniePaczki(projekt, idPaczki);
  const wynik = await czytajPlikStatusu(gdzie);
  const odebrane = gdzie.rodzaj === 'jest' && (await zwyklyPlik(join(gdzie.katalog, PLIK_ODBIORU))) !== null;
  return { ...wynik, agent: { czeka: await czytajObecnosc(projekt), odebrane } };
}

async function czytajPlikStatusu(gdzie: Awaited<ReturnType<typeof polozeniePaczki>>): Promise<WynikPliku> {
  const niepoprawny: WynikPliku = { plik: 'niepoprawny', statusy: [], historyjka: [] };
  if (gdzie.rodzaj === 'brak') return { plik: 'brak', statusy: [], historyjka: [] };
  if (gdzie.rodzaj === 'zly') return niepoprawny;
  const katalog = gdzie.katalog;
  let surowe: unknown;
  try {
    surowe = await czytajJson(join(katalog, 'status.json'), LIMITY_STATUSU.plikBajty);
  } catch (blad) {
    return (blad as NodeJS.ErrnoException).code === 'ENOENT' ? { plik: 'brak', statusy: [], historyjka: [] } : niepoprawny;
  }
  try {
    const paczka = await czytajJson(join(katalog, 'uwagi.json'), LIMITY.jsonBajty);
    const wynik = walidujStatusy(surowe, paczka);
    return wynik === null ? niepoprawny : { plik: 'jest', ...wynik };
  } catch { return niepoprawny; }
}
