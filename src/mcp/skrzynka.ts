import { constants as C, promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { czytajStatus, walidujStatusy } from '../host/status';
import { KATALOG_UWAG, KATALOG_UWAG_STARY, polozeniePaczki, stanKatalogu, upewnijSieZeIgnorowane, zweryfikujIdPaczki } from '../host/zapis';
import { LIMITY, LIMITY_STATUSU, PLIK_CZEKANIA, PLIK_OBRAZU_PLANSZY, PLIK_ODBIORU, WZOR_ID_PACZKI, WZOR_PLIKU_RYSUNKU, stanKanoniczny, type StanUwagi, type StatusUwagi } from '../wspolne/protokol';

/**
 * Skrzynka paczek jednego projektu: nowe w `.herestt/<id>/`, stare dalej
 * w `.scratch/uwagi-ui/<id>/`. Status idzie do `status.json`, więc wtyczka pokazuje go bez
 * zmian po swojej stronie. Serwer nie zna innych projektów: katalog ustala
 * proces, nie agent.
 */

const LIMIT_MD_BAJTY = 512 * 1024;
const LIMIT_LISTY = 20;
export const STANY: readonly StanUwagi[] = ['done', 'rejected', 'question'];

export class BladSkrzynki extends Error {}

export type OpisPaczki = {
  id: string;
  katalog: string;
  plikMd: string;
  /** Numery uwag i rysunków planszy (z numerem) bez żadnego statusu. */
  otwarte: number[];
  /** Numery z pytaniem do właściciela: czekają na niego, nie na agenta. */
  pytania: number[];
  historyjkaOtwarte: number[];
  /** Tylko paczka z planszą. `obraz`: stary `plansza.png`. `rysunki`: ścieżki `plansza-N.png`. `otwarta`: stara plansza (bez rysunków z numerem) bez statusu `plansza: true`. */
  plansza?: { otwarta: boolean; obraz: string | null; rysunki?: string[] };
  statusPliku: 'jest' | 'brak' | 'niepoprawny';
};

export type WynikListy = { projekt: string; paczki: OpisPaczki[]; pominieteStarsze: number; uszkodzone: string[] };

type Paczka = { uwagi?: unknown; historyjka?: { zrzuty?: { adnotacje?: unknown }[] }; plansza?: { obraz?: { plik?: unknown; rysunki?: unknown }; rysunki?: unknown } };

/** Ścieżki `plansza-N.png` z deklaracji paczki. Plik spoza wzorca nie idzie do agenta. */
function sciezkiRysunkow(katalog: string, surowe: unknown): string[] {
  if (!Array.isArray(surowe)) return [];
  const sciezki: string[] = [];
  for (const w of surowe) {
    if (typeof w !== 'object' || w === null || Array.isArray(w) || !('plik' in w) || typeof w.plik !== 'string') continue;
    if (!WZOR_PLIKU_RYSUNKU.test(w.plik)) continue;
    sciezki.push(join(katalog, w.plik));
  }
  return sciezki;
}

function numery(lista: unknown): number[] {
  if (!Array.isArray(lista)) return [];
  return lista.flatMap(w => (typeof w?.numer === 'number' ? [w.numer as number] : []));
}

/** Plik zwykły, bez symlinka na końcu i bez podmiany między lstat a odczytem. */
async function czytajPlik(sciezka: string, limit: number): Promise<Buffer> {
  const st = await fsp.lstat(sciezka);
  if (!st.isFile() || st.size > limit) throw new BladSkrzynki(`Niepoprawny plik: ${sciezka}`);
  const plik = await fsp.open(sciezka, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const otwarty = await plik.stat();
    if (otwarty.ino !== st.ino || otwarty.dev !== st.dev || otwarty.size > limit) throw new BladSkrzynki(`Plik zmienił się podczas odczytu: ${sciezka}`);
    return await plik.readFile();
  } finally {
    await plik.close();
  }
}

/** Status planszy czytany wprost: wtyczka pokazuje statusy uwag, a planszy jeszcze nie. */
async function czytajPlanszeStatusu(katalog: string): Promise<{ stan: string; komentarz: string } | null> {
  try {
    const surowe = JSON.parse((await czytajPlik(join(katalog, 'status.json'), LIMITY.jsonBajty)).toString('utf8')) as { plansza?: { stan?: unknown; komentarz?: unknown } };
    const p = surowe.plansza;
    const stan = stanKanoniczny(p?.stan);
    return p !== undefined && stan !== null && typeof p.komentarz === 'string' ? { stan, komentarz: p.komentarz } : null;
  } catch {
    return null;
  }
}

async function planszaZamknieta(katalog: string): Promise<boolean> {
  return (await czytajPlanszeStatusu(katalog)) !== null;
}

const ODSWIEZANIE_CZEKANIA_MS = 3000;

/** Atomowy zapis znacznika; dowiązanie symboliczne w miejscu docelowym zostaje zastąpione, nie śledzone. */
async function zapiszZnacznik(docelowy: string, tresc: string): Promise<void> {
  const tmp = join(dirname(docelowy), `.znacznik.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, tresc, { flag: 'wx', mode: 0o600 });
    await fsp.rename(tmp, docelowy);
  } catch (blad) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw blad;
  }
}

export class Skrzynka {
  private readonly widziane = new Set<string>();
  private czekanieOdswiezone = 0;
  private kolejkaZapisu: Promise<unknown> = Promise.resolve();

  constructor(readonly projekt: string) {}

  private get katalogUwag(): string {
    return join(this.projekt, KATALOG_UWAG);
  }

  /** Znacznik „agent czeka”: nie rzadziej niż co 3 s; błąd zapisu nie przerywa czekania. */
  private async odswiezCzekanie(): Promise<void> {
    const teraz = Date.now();
    if (teraz - this.czekanieOdswiezone < ODSWIEZANIE_CZEKANIA_MS) return;
    this.czekanieOdswiezone = teraz;
    try {
      const katalog = this.katalogUwag;
      // Agent zwykle czeka, zanim padnie pierwszy zapis: katalog zakładamy tak jak host, razem z `.gitignore`.
      // Tylko `.herestt`. Starego `.scratch/uwagi-ui` nikt tu nie tworzy.
      await fsp.mkdir(katalog, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      const st = await fsp.lstat(katalog);
      if (st.isSymbolicLink() || !st.isDirectory()) return;
      await upewnijSieZeIgnorowane(katalog);
      await zapiszZnacznik(join(katalog, PLIK_CZEKANIA), '');
    } catch {
      // Znacznik jest dodatkiem: bez niego wtyczka tylko nie pokaże obecności agenta.
    }
  }

  /** Zapisuje `odebrane.json`, jeśli go jeszcze nie ma. Błędy połykane. */
  private async oznaczOdebrane(id: string): Promise<void> {
    try {
      const gdzie = await polozeniePaczki(this.projekt, id);
      if (gdzie.rodzaj !== 'jest') return;
      const katalog = gdzie.katalog;
      const plik = join(katalog, PLIK_ODBIORU);
      try {
        await fsp.lstat(plik);
        return;
      } catch (blad) {
        if ((blad as NodeJS.ErrnoException).code !== 'ENOENT') return;
      }
      await zapiszZnacznik(plik, JSON.stringify({ czas: new Date().toISOString() }) + '\n');
    } catch {
      // Jak wyżej: znacznik odbioru nie może zepsuć odpowiedzi narzędzia.
    }
  }

  private async idZKatalogu(katalog: string): Promise<string[] | 'brak' | 'zly'> {
    const stan = await stanKatalogu(katalog);
    if (stan !== 'jest') return stan;
    const wpisy = await fsp.readdir(katalog, { withFileTypes: true });
    return wpisy.filter(w => !w.isSymbolicLink() && w.isDirectory() && WZOR_ID_PACZKI.test(w.name)).map(w => w.name);
  }

  /** Suma id z obu katalogów. Ten sam id wchodzi raz. Zły stary katalog (plik albo dowiązanie) pomijamy jak brak. */
  private async idPaczek(): Promise<string[]> {
    const zebrane = new Set<string>();
    const nowy = await this.idZKatalogu(this.katalogUwag);
    if (nowy === 'zly') throw new BladSkrzynki(`${this.katalogUwag} nie jest katalogiem`);
    if (nowy !== 'brak') for (const id of nowy) zebrane.add(id);

    const scratch = join(this.projekt, '.scratch');
    if ((await stanKatalogu(scratch)) === 'jest') {
      const stary = await this.idZKatalogu(join(this.projekt, KATALOG_UWAG_STARY));
      if (stary !== 'brak' && stary !== 'zly') for (const id of stary) zebrane.add(id);
    }
    return [...zebrane].sort();
  }

  private async katalogPaczki(id: string): Promise<string> {
    const gdzie = await polozeniePaczki(this.projekt, id);
    if (gdzie.rodzaj !== 'jest') throw new BladSkrzynki('Katalog paczki nie jest katalogiem.');
    return gdzie.katalog;
  }

  /** Paczki sprzed startu serwera nie są „nowe”: `czekaj` nie może wskrzesić starej rundy. */
  async zapamietajIstniejace(): Promise<void> {
    for (const id of await this.idPaczek()) this.widziane.add(id);
  }

  private async opis(id: string): Promise<OpisPaczki> {
    const katalog = await this.katalogPaczki(id);
    const paczka = JSON.parse((await czytajPlik(join(katalog, 'uwagi.json'), LIMITY.jsonBajty)).toString('utf8')) as Paczka;
    const status = await czytajStatus(this.projekt, id);
    const zamkniete = new Set(status.statusy.map(s => s.numer));
    const zamknieteH = new Set(status.historyjka.map(s => s.numer));
    const adnotacje = (paczka.historyjka?.zrzuty ?? []).flatMap(z => numery(z.adnotacje));
    const rysunki = sciezkiRysunkow(katalog, paczka.plansza?.obraz?.rysunki);
    return {
      id,
      katalog,
      plikMd: join(katalog, 'uwagi.md'),
      // Numery rysunków są w tej samej serii co uwagi, a ich statusy trafiają do tej samej listy `statusy`.
      otwarte: [...numery(paczka.uwagi), ...numery(paczka.plansza?.rysunki)].filter(n => !zamkniete.has(n)),
      // Statusy rysunków leżą w `status.statusy` obok uwag, więc `pytania` obejmuje je bez dodatkowej pracy.
      pytania: status.statusy.filter(s => s.stan === 'question').map(s => s.numer),
      historyjkaOtwarte: adnotacje.filter(n => !zamknieteH.has(n)),
      ...(paczka.plansza ? {
        plansza: {
          // Status całej planszy zostaje dla starych paczek; paczka z rysunkami zamyka się ich statusami.
          otwarta: rysunki.length === 0 && !(await planszaZamknieta(katalog)),
          obraz: paczka.plansza.obraz?.plik === PLIK_OBRAZU_PLANSZY ? join(katalog, PLIK_OBRAZU_PLANSZY) : null,
          ...(rysunki.length > 0 ? { rysunki } : {}),
        },
      } : {}),
      statusPliku: status.plik,
    };
  }

  private async opisy(idki: string[]): Promise<{ paczki: OpisPaczki[]; uszkodzone: string[] }> {
    const paczki: OpisPaczki[] = [];
    const uszkodzone: string[] = [];
    for (const id of idki) {
      try {
        paczki.push(await this.opis(id));
      } catch {
        uszkodzone.push(id);
      }
    }
    return { paczki, uszkodzone };
  }

  /** Najnowsze najpierw. Paczka zamknięta w całości nie jest już pracą do zrobienia. */
  async lista(): Promise<WynikListy> {
    const idki = await this.idPaczek();
    idki.forEach(id => this.widziane.add(id));
    const { paczki, uszkodzone } = await this.opisy(idki);
    const doZrobienia = paczki.filter(p => p.otwarte.length + p.historyjkaOtwarte.length > 0 || p.plansza?.otwarta === true || p.statusPliku === 'niepoprawny').reverse();
    const zwrocone = doZrobienia.slice(0, LIMIT_LISTY);
    for (const p of zwrocone) await this.oznaczOdebrane(p.id);
    return { projekt: this.projekt, paczki: zwrocone, pominieteStarsze: Math.max(0, doZrobienia.length - LIMIT_LISTY), uszkodzone };
  }

  /** Blokuje do pojawienia się paczki nowej dla tego serwera albo do końca czasu. */
  async czekaj(limitMs: number, sygnal?: AbortSignal, odstepMs = 1000): Promise<{ projekt: string; paczki: OpisPaczki[]; koniecCzasu: boolean }> {
    const koniec = Date.now() + limitMs;
    for (;;) {
      if (sygnal?.aborted) throw new BladSkrzynki('Oczekiwanie anulowane.');
      await this.odswiezCzekanie();
      const nowe = (await this.idPaczek()).filter(id => !this.widziane.has(id));
      if (nowe.length > 0) {
        const { paczki } = await this.opisy(nowe);
        nowe.forEach(id => this.widziane.add(id));
        for (const p of paczki) await this.oznaczOdebrane(p.id);
        return { projekt: this.projekt, paczki, koniecCzasu: false };
      }
      const zostalo = koniec - Date.now();
      if (zostalo <= 0) return { projekt: this.projekt, paczki: [], koniecCzasu: true };
      await new Promise<void>(gotowe => {
        // Anulowanie mogło przyjść podczas odczytu katalogu, czyli przed założeniem nasłuchu.
        if (sygnal?.aborted) { gotowe(); return; }
        const przerwij = () => { clearTimeout(zegar); gotowe(); };
        const zegar = setTimeout(() => { sygnal?.removeEventListener('abort', przerwij); gotowe(); }, Math.min(odstepMs, zostalo));
        sygnal?.addEventListener('abort', przerwij, { once: true });
      });
    }
  }

  /** Treść `uwagi.md`. Blok niezaufanego kontekstu i ostrzeżenie są już w pliku. */
  async czytaj(suroweId: unknown): Promise<string> {
    const id = zweryfikujIdPaczki(suroweId);
    const katalog = await this.katalogPaczki(id);
    const tresc = (await czytajPlik(join(katalog, 'uwagi.md'), LIMIT_MD_BAJTY)).toString('utf8');
    await this.oznaczOdebrane(id);
    return tresc;
  }

  /** Scala jeden wpis z `status.json`. Zapisy idą po kolei, a plik podmienia jeden `rename`. */
  ustawStatus(wpis: { paczka: unknown; numer: unknown; stan: unknown; komentarz: unknown; historyjka?: unknown; plansza?: unknown }): Promise<StatusUwagi> {
    const zadanie = this.kolejkaZapisu.then(() => this.zapiszStatus(wpis));
    this.kolejkaZapisu = zadanie.catch(() => undefined);
    return zadanie;
  }

  private async zapiszStatus(w: { paczka: unknown; numer: unknown; stan: unknown; komentarz: unknown; historyjka?: unknown; plansza?: unknown }): Promise<StatusUwagi> {
    const id = zweryfikujIdPaczki(w.paczka);
    if (w.plansza !== true && !Number.isSafeInteger(w.numer)) throw new BladSkrzynki('number must be an integer.');
    if (typeof w.stan !== 'string' || !STANY.includes(w.stan as StanUwagi)) throw new BladSkrzynki(`state must be one of: ${STANY.join(', ')}.`);
    if (typeof w.komentarz !== 'string' || w.komentarz.trim() === '') throw new BladSkrzynki('comment must not be empty.');
    if (w.komentarz.length > LIMITY_STATUSU.komentarzZnakow) throw new BladSkrzynki(`comment is limited to ${LIMITY_STATUSU.komentarzZnakow} characters.`);

    const obecny = await czytajStatus(this.projekt, id);
    // Nie nadpisujemy pliku, którego nie rozumiemy: to mógł być ręczny zapis agenta.
    if (obecny.plik === 'niepoprawny') throw new BladSkrzynki('status.json or uwagi.json for this bundle is invalid; fix the file by hand or delete status.json.');

    const nowy: StatusUwagi = { numer: w.numer as number, stan: w.stan as StanUwagi, komentarz: w.komentarz };
    const katalogPaczki = await this.katalogPaczki(id);
    const zapisanaPlansza = await czytajPlanszeStatusu(katalogPaczki);
    const wstaw = (lista: StatusUwagi[]) => [...lista.filter(s => s.numer !== nowy.numer), nowy].sort((a, b) => a.numer - b.numer);
    const naHistoryjke = w.historyjka === true;
    const naPlansze = w.plansza === true;
    const tresc = naPlansze ? {
      uwagi: obecny.statusy,
      ...(obecny.historyjka.length > 0 ? { historyjka: obecny.historyjka } : {}),
      plansza: { stan: nowy.stan, komentarz: nowy.komentarz },
    } : {
      uwagi: naHistoryjke ? obecny.statusy : wstaw(obecny.statusy),
      ...(naHistoryjke || obecny.historyjka.length > 0 ? { historyjka: naHistoryjke ? wstaw(obecny.historyjka) : obecny.historyjka } : {}),
      ...(zapisanaPlansza === null ? {} : { plansza: zapisanaPlansza }),
    };

    const katalog = katalogPaczki;
    const paczka: unknown = JSON.parse((await czytajPlik(join(katalog, 'uwagi.json'), LIMITY.jsonBajty)).toString('utf8'));
    if (naPlansze && (paczka as Paczka).plansza === undefined) throw new BladSkrzynki('This bundle has no board.');
    if (walidujStatusy(tresc, paczka) === null) throw new BladSkrzynki(`number ${nowy.numer} does not exist in this bundle.`);

    const tmp = join(katalog, `.status.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await fsp.writeFile(tmp, JSON.stringify(tresc, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fsp.rename(tmp, join(katalog, 'status.json'));
    } catch (blad) {
      await fsp.rm(tmp, { force: true });
      throw blad;
    }
    return nowy;
  }
}
