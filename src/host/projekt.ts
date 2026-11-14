import { promises as fsp } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import { LIMIT_PROMPTU_FOLDERU, LIMIT_WYBORU_FOLDERU_MS, LIMITY } from '../wspolne/protokol';
import { BladHosta } from './bledy';
import type { Binarki } from './konfiguracja';
import { wczytajMapowania, zapiszMapowanie } from './mapowania';
import { gitToplevel, lsofCwd, lsofNasluchujace, OSASCRIPT_SYSTEMOWY, osascriptWybierzFolder } from './uruchom';

const LIMIT_SCIEZKI = 1024;

/** Czy `sciezka` leży w `projekt` — po granicy komponentu, więc `/a/proj-2` NIE jest w `/a/proj`. */
export function wewnatrz(projekt: string, sciezka: string): boolean {
  return sciezka === projekt || sciezka.startsWith(projekt + sep);
}

/** Projekt od wtyczki: absolutny, istniejący, a jego realpath to dokładnie git toplevel (też po realpath). */
export async function zweryfikujProjekt(b: Binarki, surowy: unknown): Promise<string> {
  if (typeof surowy !== 'string' || surowy.length === 0 || surowy.length > LIMIT_SCIEZKI) {
    throw new BladHosta('zadanie_niepoprawne', 'projekt: zła długość');
  }
  if (!isAbsolute(surowy) || surowy.includes('\0')) throw new BladHosta('zadanie_niepoprawne', 'projekt: wymagana ścieżka absolutna');
  let real: string;
  try {
    real = await fsp.realpath(surowy);
  } catch {
    throw new BladHosta('projekt_nie_istnieje', 'projekt: katalog nie istnieje');
  }
  const top = await gitToplevel(b, real);
  if (top === null) throw new BladHosta('projekt_nie_git', 'projekt: to nie jest repozytorium git');
  const topReal = await fsp.realpath(top);
  if (topReal !== real) throw new BladHosta('projekt_nie_toplevel', 'projekt: to podkatalog repozytorium, nie jego korzeń', topReal);
  return real;
}

/**
 * Okno wyboru folderu na Macu. Zwraca ścieżkę albo `null` (anulowano); NIE
 * sprawdza, czy to projekt — robi to dalej `mapuj` tą samą drogą co ręczna
 * ścieżka. Poza macOS bez jawnej binarki w konfiguracji: `zadanie_niepoprawne`,
 * czyli ten sam błąd co u starszego hosta (wtyczka chowa wtedy przycisk).
 */
export async function wybierzFolder(b: Binarki, surowyPrompt: unknown, limitMs: number = LIMIT_WYBORU_FOLDERU_MS): Promise<string | null> {
  if (typeof surowyPrompt !== 'string' || surowyPrompt.length === 0 || surowyPrompt.length > LIMIT_PROMPTU_FOLDERU || surowyPrompt.includes('\0')) {
    throw new BladHosta('zadanie_niepoprawne', 'prompt: zła długość');
  }
  if (b.osascript === undefined && process.platform !== 'darwin') {
    throw new BladHosta('zadanie_niepoprawne', 'wybór folderu: tylko macOS');
  }
  return osascriptWybierzFolder(b.osascript ?? OSASCRIPT_SYSTEMOWY, surowyPrompt, limitMs);
}

export type Origin = { origin: string; lokalny: boolean; port: number };

const HOSTY_LOKALNE = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Przyjmujemy tylko czysty origin http(s) — dokładnie w postaci, w jakiej zwraca go `URL#origin`. */
export function parsujOrigin(surowy: unknown): Origin {
  if (typeof surowy !== 'string' || surowy.length === 0 || surowy.length > LIMITY.originZnakow) {
    throw new BladHosta('origin_niepoprawny', 'origin: zła długość');
  }
  let url: URL;
  try {
    url = new URL(surowy);
  } catch {
    throw new BladHosta('origin_niepoprawny', 'origin: nie jest URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== surowy) {
    throw new BladHosta('origin_niepoprawny', 'origin: wymagany sam origin http(s), np. http://localhost:3000');
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  // `*.localhost` Chrome rozwiązuje na pętlę zwrotną, więc to też serwer lokalny.
  const lokalny = HOSTY_LOKALNE.has(url.hostname) || url.hostname.endsWith('.localhost');
  return { origin: url.origin, lokalny, port };
}

/**
 * lsof → PID-y → cwd → git toplevel (realpath), bez duplikatów. Kilka wyników
 * jest realne: Vite potrafi słuchać na ::1, a inny proces na 127.0.0.1 tego
 * samego portu (host.md §1.4). Nie zgadujemy — oddajemy wszystkie.
 *
 * `pelne` mówi, czy obraz portu jest kompletny: nikt nie nasłuchuje albo
 * każdy nasłuchujący proces został rozpoznany do konkretnego toplevel. PID bez
 * czytelnego cwd (proces innego użytkownika) czy repozytorium poza gitem
 * zostawiają obraz niepełny — wtedy „brak kandydatów” NIE znaczy „pusty port”
 * (przegląd W3).
 */
export type KandydaciLsof = { kandydaci: string[]; pelne: boolean };

export async function kandydaciLsof(b: Binarki, port: number): Promise<KandydaciLsof> {
  const pidy = await lsofNasluchujace(b, port);
  if (pidy.length === 0) return { kandydaci: [], pelne: true };
  const toplevele = new Set<string>();
  let pelne = true;
  for (const pid of pidy) {
    const cwd = await lsofCwd(b, pid);
    const top = cwd === null ? null : await gitToplevel(b, cwd);
    if (top === null) {
      pelne = false;
      continue;
    }
    try {
      toplevele.add(await fsp.realpath(top));
    } catch {
      pelne = false; // repo zniknęło między wywołaniami
    }
  }
  return { kandydaci: [...toplevele].sort(), pelne };
}

export type Rozpoznanie = { projekt: string | null; zrodlo: 'mapowanie' | 'lsof' | 'brak'; kandydaci: string[] };

/**
 * Reguła H3 (debata host, runda 1; etap naprawy dopisał przypadek pustego portu;
 * przegląd runda 3 dopisał niepełny obraz portu):
 * - zdalny origin: mapowanie albo nic;
 * - localhost: mapowanie liczy się, gdy obraz portu jest PEŁNY i lsof daje
 *   dokładnie jeden toplevel równy mapowaniu albo NIKT nie nasłuchuje
 *   (zatrzymany dev server nie blokuje wysyłki); gdy nasłuchuje coś innego
 *   albo nie wiemy czego (ślepy lsof, PID bez czytelnego cwd) — propozycja
 *   do potwierdzenia.
 */
export async function rozpoznaj(b: Binarki, katalogKonfiguracji: string, surowyOrigin: unknown): Promise<Rozpoznanie> {
  const o = parsujOrigin(surowyOrigin);
  const zapisany = (await wczytajMapowania(katalogKonfiguracji)).get(o.origin) ?? null;
  if (!o.lokalny) {
    return zapisany === null ? { projekt: null, zrodlo: 'brak', kandydaci: [] } : { projekt: zapisany, zrodlo: 'mapowanie', kandydaci: [zapisany] };
  }
  const { kandydaci, pelne } = await kandydaciLsof(b, o.port);
  if (zapisany !== null && pelne && (kandydaci.length === 0 || (kandydaci.length === 1 && kandydaci[0] === zapisany))) {
    return { projekt: zapisany, zrodlo: 'mapowanie', kandydaci };
  }
  return { projekt: null, zrodlo: pelne && kandydaci.length === 0 && zapisany === null ? 'brak' : 'lsof', kandydaci };
}

/** Odczyt statusu nie zależy od nadal działającego dev servera; nie służy do zapisu ani promptu. */
export async function projektDlaStatusu(b: Binarki, katalogKonfiguracji: string, surowyOrigin: unknown): Promise<string> {
  const origin = parsujOrigin(surowyOrigin).origin;
  const projekt = (await wczytajMapowania(katalogKonfiguracji)).get(origin);
  if (projekt === undefined) throw new BladHosta('projekt_nieznany', 'brak potwierdzonego projektu dla tego originu');
  return zweryfikujProjekt(b, projekt);
}

/** Dla `agents`/`deliver`/`prompt`: wyłącznie potwierdzone mapowanie, sprawdzone ponownie i zweryfikowane jako toplevel. */
export async function projektDlaOriginu(b: Binarki, katalogKonfiguracji: string, surowyOrigin: unknown): Promise<string> {
  const o = parsujOrigin(surowyOrigin);
  const r = await rozpoznaj(b, katalogKonfiguracji, o.origin);
  if (r.zrodlo !== 'mapowanie' || r.projekt === null) {
    // Komunikat mówi, CZEGO brakuje — właściciel nie widziałby wtedy tylko
    // ogólnego „brak potwierdzonego projektu”, choć projekt jest potwierdzony.
    if (r.zrodlo === 'brak') {
      throw new BladHosta('projekt_nieznany', 'brak potwierdzonego projektu dla tego originu — wybierz projekt (mapuj)');
    }
    if (r.kandydaci.length === 0) {
      throw new BladHosta('projekt_nieznany', `na porcie ${o.port} nasłuchuje proces, którego repozytorium nie można odczytać — potwierdź projekt dla tej strony`);
    }
    throw new BladHosta('projekt_nieznany', `na porcie ${o.port} działa serwer z innego repozytorium — potwierdź projekt dla tej strony`);
  }
  return zweryfikujProjekt(b, r.projekt);
}

/** `mapuj`: projekt musi być git toplevelem, a dla localhost — jednym z aktualnych kandydatów lsof. */
export async function mapuj(b: Binarki, katalogKonfiguracji: string, surowyOrigin: unknown, surowyProjekt: unknown): Promise<string> {
  const o = parsujOrigin(surowyOrigin);
  const projekt = await zweryfikujProjekt(b, surowyProjekt);
  if (o.lokalny) {
    const { kandydaci, pelne } = await kandydaciLsof(b, o.port);
    if (!kandydaci.includes(projekt)) {
      throw new BladHosta(
        'projekt_nieznany',
        pelne
          ? `na porcie ${o.port} nie działa serwer z tego repozytorium`
          : `nie mogę potwierdzić, że serwer z tego repozytorium działa na porcie ${o.port} (brak dostępu do procesu serwera)`,
      );
    }
  }
  await zapiszMapowanie(katalogKonfiguracji, o.origin, projekt);
  return projekt;
}
