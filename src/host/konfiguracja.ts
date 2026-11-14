import { constants as C, promises as fsp } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { BladHosta } from './bledy';

/**
 * Konfiguracja pisana przez `install.sh` obok kopii hosta.
 *
 * Dlaczego plik, a nie PATH: Chrome uruchomiony z Docka daje hostowi
 * `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — nie ma tam herdr ani node, a `git`
 * po nazwie trafia w Apple Git zamiast Homebrew (host.md §1.3). Host nigdy nie
 * szuka binarek sam; zna tylko ścieżki zweryfikowane przy instalacji.
 */

export type Binarki = { git: string; lsof: string; /** Stare TUI Herdr: obecny tylko, gdy był przy instalacji. */ herdr?: string; /** herdr-core (`hc`): obecny tylko, gdy był przy instalacji; brak nie wyłącza starym TUI. */ hc?: string; /** Okno wyboru folderu. Brak = systemowe `/usr/bin/osascript` (tylko macOS); pole służy głównie testom. */ osascript?: string };

export type Konfiguracja = {
  wersja: 1;
  /** ID wtyczki z `src/wspolne/id-wtyczki.txt`; host porównuje je z argv od Chrome. */
  idWtyczki: string;
  binarki: Binarki;
};

export const PLIK_KONFIGURACJI = 'config.json';
const WZOR_ID_WTYCZKI = /^[a-p]{32}$/;

async function sprawdzBinarke(nazwa: string, sciezka: unknown): Promise<string> {
  if (typeof sciezka !== 'string' || !isAbsolute(sciezka) || sciezka.includes('\0')) {
    throw new BladHosta('konfiguracja', `binarka ${nazwa}: wymagana ścieżka absolutna`);
  }
  try {
    await fsp.access(sciezka, C.X_OK);
  } catch {
    throw new BladHosta('konfiguracja', `binarka ${nazwa}: ${sciezka} nie istnieje albo nie jest wykonywalna — uruchom ponownie install.sh`);
  }
  return sciezka;
}

/**
 * Czyta `config.json` z katalogu instalacji. Plik musi być zwykłym plikiem
 * właściciela bez praw dla grupy i innych — inaczej ktoś mógłby podmienić
 * ścieżkę binarki i host wykonałby cudzy program.
 */
export async function wczytajKonfiguracje(katalog: string): Promise<Konfiguracja> {
  const plik = join(katalog, PLIK_KONFIGURACJI);
  let st;
  try {
    st = await fsp.lstat(plik);
  } catch {
    throw new BladHosta('konfiguracja', `brak ${PLIK_KONFIGURACJI} — uruchom install.sh`);
  }
  if (!st.isFile()) throw new BladHosta('konfiguracja', `${PLIK_KONFIGURACJI} nie jest zwykłym plikiem`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new BladHosta('konfiguracja', `${PLIK_KONFIGURACJI} należy do innego użytkownika`);
  }
  if ((st.mode & 0o077) !== 0) throw new BladHosta('konfiguracja', `${PLIK_KONFIGURACJI} ma za szerokie prawa (wymagane 0600)`);

  let surowa: unknown;
  try {
    surowa = JSON.parse(await fsp.readFile(plik, 'utf8'));
  } catch {
    throw new BladHosta('konfiguracja', `${PLIK_KONFIGURACJI} nie jest poprawnym JSON`);
  }
  const k = surowa as Partial<Record<string, unknown>> | null;
  if (typeof k !== 'object' || k === null || k.wersja !== 1) throw new BladHosta('konfiguracja', 'nieobsługiwana wersja konfiguracji');
  if (typeof k.idWtyczki !== 'string' || !WZOR_ID_WTYCZKI.test(k.idWtyczki)) throw new BladHosta('konfiguracja', 'niepoprawne idWtyczki');
  const b = k.binarki as Partial<Record<string, unknown>> | null | undefined;
  if (typeof b !== 'object' || b === null) throw new BladHosta('konfiguracja', 'brak sekcji binarki');

  // Oba opcjonalne: bez nich nie ma tylko wysyłki do agenta w terminalu. Zapisana, a zepsuta ścieżka to nadal błąd.
  const herdr = b.herdr === undefined || b.herdr === null ? undefined : await sprawdzBinarke('herdr', b.herdr);
  const hc = b.hc === undefined || b.hc === null ? undefined : await sprawdzBinarke('hc', b.hc);
  const osascript = b.osascript === undefined || b.osascript === null ? undefined : await sprawdzBinarke('osascript', b.osascript);

  return {
    wersja: 1,
    idWtyczki: k.idWtyczki,
    binarki: {
      git: await sprawdzBinarke('git', b.git),
      lsof: await sprawdzBinarke('lsof', b.lsof),
      ...(herdr !== undefined ? { herdr } : {}),
      ...(hc !== undefined ? { hc } : {}),
      ...(osascript !== undefined ? { osascript } : {}),
    },
  };
}
