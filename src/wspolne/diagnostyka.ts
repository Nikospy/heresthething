/**
 * Rdzeń lokalnej diagnostyki (S-33): wspólny dla `doctor` w terminalu i przycisku „Kopiuj diagnostykę”.
 *
 * Zasady, których pilnuje ten moduł:
 * - bez telemetrii: czysty tekst, żadnego I/O i żadnej sieci (pilnuje tego `tests/host/doctor-straznik.test.ts`),
 * - każdy wiersz ma kod, zdanie i (gdy coś trzeba zrobić) jedno działanie, brane ze słownika `OBJAWY`,
 * - ścieżka domowa skrócona do `~`, tokeny i znaki sterujące nie przechodzą (`maskuj`),
 * - wyjątek w jednej kontroli nie przerywa raportu (`bezpiecznie`).
 *
 * Moduł nie importuje `node:*` ani `chrome`, bo działa w hoście i we wtyczce.
 */

export type Poziom = 'ok' | 'uwaga' | 'blad' | 'info';
export type Jezyk = 'pl' | 'en';

export interface Wiersz {
  poziom: Poziom;
  /** Kod objawu, np. `plik_brak:mcp.mjs`. Część przed `:` wskazuje wpis w `OBJAWY`. */
  kod: string;
  tekst: string;
  dzialanie?: string;
}

export interface Sekcja {
  tytul: string;
  wiersze: Wiersz[];
}

export interface Maska {
  prefiks: string;
  jako: string;
}

interface Objaw {
  pl: string;
  en: string;
  dzialaniePl?: string;
  dzialanieEn?: string;
}

const PONOW_PL = 'Uruchom ponownie polecenie połączenia: {polecenie}';
const PONOW_EN = 'Run the connect command again: {polecenie}';
const AGENT_PL = 'Uruchom polecenie połączenia ponownie i zaznacz agenta: {polecenie}';
const AGENT_EN = 'Run the connect command again and select the agent: {polecenie}';

/** Jedno źródło zdań i działań. Ten sam kod daje to samo zdanie w terminalu i na stronie wtyczki. */
export const OBJAWY: Record<string, Objaw> = {
  // --- wspólne ---
  kontrola_nieudana: {
    pl: 'Ta kontrola nie udała się.',
    en: 'This check failed.',
    dzialaniePl: 'Dołącz ten raport do zgłoszenia.',
    dzialanieEn: 'Attach this report to your bug report.',
  },
  // --- terminal: system i narzędzia ---
  system: { pl: 'System', en: 'System' },
  node: { pl: 'Node (to polecenie)', en: 'Node (this command)' },
  node_wybrany: { pl: 'Node używany przez połączenie', en: 'Node used by the connection' },
  node_brak: {
    pl: 'Nie znaleziono Node w wersji 22 albo nowszej.',
    en: 'Node 22 or newer was not found.',
    dzialaniePl: 'Zainstaluj Node.js 22 lub nowszy z nodejs.org i powtórz polecenie połączenia.',
    dzialanieEn: 'Install Node.js 22 or newer from nodejs.org and run the connect command again.',
  },
  node_wersjonowany: {
    pl: 'Node na PATH leży w katalogu z numerem wersji (nvm, fnm). Po zmianie wersji może zniknąć.',
    en: 'Node on PATH lives in a version-numbered folder (nvm, fnm). It can vanish after a version change.',
    dzialaniePl: PONOW_PL,
    dzialanieEn: PONOW_EN,
  },
  xcode: { pl: 'Narzędzia wiersza poleceń Apple', en: 'Apple command line tools' },
  xcode_brak: {
    pl: 'Brak narzędzi wiersza poleceń Apple.',
    en: 'Apple command line tools are missing.',
    dzialaniePl: 'Zainstaluj je poleceniem: xcode-select --install',
    dzialanieEn: 'Install them with: xcode-select --install',
  },
  // --- terminal: program lokalny ---
  nie_polaczono: {
    pl: 'Połączenie nie jest skonfigurowane. Czat działa bez niego.',
    en: 'The connection is not set up. Chat works without it.',
  },
  katalog: { pl: 'Katalog programu lokalnego', en: 'Local program folder' },
  plik_brak: { pl: 'Brakuje pliku programu.', en: 'A program file is missing.', dzialaniePl: PONOW_PL, dzialanieEn: PONOW_EN },
  config_zly: { pl: 'Plik ustawień jest uszkodzony.', en: 'The settings file is damaged.', dzialaniePl: PONOW_PL, dzialanieEn: PONOW_EN },
  config_prawa: {
    pl: 'Plik ustawień ma za szerokie prawa dostępu (wymagane 0600).',
    en: 'The settings file permissions are too wide (0600 required).',
    dzialaniePl: PONOW_PL,
    dzialanieEn: PONOW_EN,
  },
  binarka_brak: {
    pl: 'Program zapisany w ustawieniach nie istnieje albo nie da się go uruchomić.',
    en: 'A program recorded in the settings does not exist or cannot run.',
    dzialaniePl: PONOW_PL,
    dzialanieEn: PONOW_EN,
  },
  dziennik_zly: {
    pl: 'Dziennik instalacji jest uszkodzony.',
    en: 'The install journal is damaged.',
    dzialaniePl: PONOW_PL,
    dzialanieEn: PONOW_EN,
  },
  dziennik_czesciowy: {
    pl: 'Poprzedni zapis nie został dokończony.',
    en: 'The previous install did not finish.',
    dzialaniePl: 'Uruchom ponownie polecenie połączenia albo cofnij zapis: {polecenie} undo',
    dzialanieEn: 'Run the connect command again or revert it: {polecenie} undo',
  },
  id_rozne: {
    pl: 'Dziennik i ustawienia wskazują różne wtyczki.',
    en: 'The journal and the settings point to different extensions.',
    dzialaniePl: PONOW_PL,
    dzialanieEn: PONOW_EN,
  },
  mapowania: { pl: 'Zapamiętane projekty', en: 'Remembered projects' },
  log_bledy: { pl: 'Błędy w dzienniku programu', en: 'Errors in the program log' },
  log_uszkodzony: { pl: 'Uszkodzone linie w dzienniku programu', en: 'Damaged lines in the program log' },
  host_ping_ok: { pl: 'Program lokalny odpowiada przy ubogim PATH, jak z Docka.', en: 'The local program answers with a minimal PATH, as when started from the Dock.' },
  host_ping_blad: {
    pl: 'Program lokalny nie odpowiedział poprawnie przy ubogim PATH.',
    en: 'The local program did not answer correctly with a minimal PATH.',
    dzialaniePl: PONOW_PL,
    dzialanieEn: PONOW_EN,
  },
  // --- terminal: przeglądarki, agenci, ślady ---
  przegladarka: { pl: 'Przeglądarka', en: 'Browser' },
  manifest_origin_inny: {
    pl: 'Połączenie jest z innej instalacji wtyczki.',
    en: 'The connection belongs to a different extension install.',
    dzialaniePl: PONOW_PL,
    dzialanieEn: PONOW_EN,
  },
  manifest_sciezka_inna: {
    pl: 'Plik opisu połączenia wskazuje inny program niż ta instalacja.',
    en: 'The connection description points to a different program than this install.',
    dzialaniePl: PONOW_PL,
    dzialanieEn: PONOW_EN,
  },
  manifest_zly: { pl: 'Plik opisu połączenia jest nieczytelny.', en: 'The connection description is unreadable.', dzialaniePl: PONOW_PL, dzialanieEn: PONOW_EN },
  manifest_brak: {
    pl: 'Ta przeglądarka nie ma pliku opisu połączenia.',
    en: 'This browser has no connection description file.',
    dzialaniePl: PONOW_PL,
    dzialanieEn: PONOW_EN,
  },
  wtyczki_brak_w_profilu: {
    pl: 'W tej przeglądarce nie widać wtyczki. Może jest w innej.',
    en: 'The extension is not visible in this browser. It may be in another one.',
    dzialaniePl: 'Uruchom polecenie połączenia ponownie i zaznacz przeglądarkę, w której jest wtyczka: {polecenie}',
    dzialanieEn: 'Run the connect command again and select the browser that has the extension: {polecenie}',
  },
  przegladarka_zarzadzana: {
    pl: 'Przeglądarką zarządza organizacja.',
    en: 'The browser is managed by an organization.',
    dzialaniePl: 'Czat działa. Połączenie z agentem może wymagać zgody administratora.',
    dzialanieEn: 'Chat works. Connecting an agent may need an administrator’s approval.',
  },
  agent_brak: { pl: 'Nie znaleziono agenta na PATH.', en: 'The agent was not found on PATH.' },
  agent_wpis_ok: { pl: 'Agent zna wpis herestt.', en: 'The agent knows the herestt entry.' },
  agent_wpis_inna_sciezka: {
    pl: 'Wpis herestt u agenta wskazuje inną instalację.',
    en: 'The agent’s herestt entry points to a different install.',
    dzialaniePl: AGENT_PL,
    dzialanieEn: AGENT_EN,
  },
  agent_bez_wpisu: {
    pl: 'Agent nie ma wpisu herestt.',
    en: 'The agent has no herestt entry.',
    dzialaniePl: AGENT_PL,
    dzialanieEn: AGENT_EN,
  },
  agent_nowa_sesja: {
    pl: 'Działająca sesja agenta nie widzi nowego narzędzia. Uruchom agenta od nowa.',
    en: 'A running agent session does not see the new tool. Restart the agent.',
  },
  stare_slady: {
    pl: 'Zostały ślady starej nazwy tryb-uwag.',
    en: 'Traces of the old tryb-uwag name remain.',
    dzialaniePl: 'Uruchom polecenie połączenia: zdejmie je. {polecenie}',
    dzialanieEn: 'Run the connect command: it removes them. {polecenie}',
  },
  // --- wtyczka ---
  wtyczka_wersja: { pl: 'Wersja wtyczki', en: 'Extension version' },
  wtyczka_id: { pl: 'Identyfikator wtyczki', en: 'Extension ID' },
  wtyczka_zakres: { pl: 'Zakres protokołu wtyczki', en: 'Extension protocol range' },
  komputer_system: { pl: 'System', en: 'System' },
  komputer_przegladarka: { pl: 'Przeglądarka', en: 'Browser' },
  komputer_jezyk: { pl: 'Język', en: 'Language' },
  polaczenie_ok: { pl: 'Program lokalny odpowiada.', en: 'The local program answers.' },
  kompilacja_inna: {
    pl: 'Program lokalny pochodzi z innej kompilacji niż wtyczka. To tylko informacja.',
    en: 'The local program comes from a different build than the extension. Information only.',
  },
  brak_hosta: {
    pl: 'Połączenie nie jest skonfigurowane. Czat działa bez niego.',
    en: 'The connection is not set up. Chat works without it.',
  },
  host_zabroniony: {
    pl: 'Przeglądarka nie pozwala tej wtyczce uruchomić programu lokalnego.',
    en: 'The browser does not allow this extension to start the local program.',
    dzialaniePl: PONOW_PL,
    dzialanieEn: PONOW_EN,
  },
  host_padl: {
    pl: 'Program lokalny nie wystartował albo przestał odpowiadać.',
    en: 'The local program did not start or stopped answering.',
    dzialaniePl: 'Uruchom polecenie połączenia ponownie. Jeśli to nie pomoże, sprawdź komputer: {polecenie} doctor',
    dzialanieEn: 'Run the connect command again. If that does not help, check the computer: {polecenie} doctor',
  },
  wersja_nieobslugiwana: {
    pl: 'Wtyczka i program lokalny nie mają wspólnej wersji protokołu.',
    en: 'The extension and the local program share no protocol version.',
    dzialaniePl: PONOW_PL,
    dzialanieEn: PONOW_EN,
  },
  odpowiedz_niepoprawna: {
    pl: 'Program lokalny odpowiedział w nieznanym kształcie.',
    en: 'The local program answered in an unknown shape.',
    dzialaniePl: PONOW_PL,
    dzialanieEn: PONOW_EN,
  },
  polaczenie_blad: {
    pl: 'Połączenie z programem lokalnym nie działa.',
    en: 'The connection to the local program does not work.',
    dzialaniePl: 'Uruchom polecenie połączenia ponownie. Jeśli to nie pomoże, sprawdź komputer: {polecenie} doctor',
    dzialanieEn: 'Run the connect command again. If that does not help, check the computer: {polecenie} doctor',
  },
};

const LIMIT_WARTOSCI = 300;
/** Górna granica wejścia do wzorców: koszt maskowania nie zależy od rozmiaru cudzego wyjścia. */
const LIMIT_WEJSCIA = 5000;
const UKRYTE = '[ukryte]';

function ucieczka(tekst: string): string {
  return tekst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Skraca prefiksy (dom, profil) i wycina sekretne wzorce oraz znaki sterujące.
 * Zawsze zwraca jedną linię o długości ≤ 300 znaków i nigdy nie rzuca.
 */
export function maskuj(wejscie: unknown, maski: readonly Maska[] = []): string {
  let tekst = typeof wejscie === 'string' ? wejscie : (() => { try { return String(wejscie); } catch { return ''; } })();
  tekst = tekst.slice(0, LIMIT_WEJSCIA);
  const posortowane = [...maski].filter(m => m.prefiks.length > 1).sort((a, b) => b.prefiks.length - a.prefiks.length);
  for (const { prefiks, jako } of posortowane) {
    const bezSlasha = prefiks.endsWith('/') ? prefiks.slice(0, -1) : prefiks;
    tekst = tekst.replace(new RegExp(`${ucieczka(bezSlasha)}(?![A-Za-z0-9._-])`, 'g'), jako);
  }
  tekst = tekst
    .replace(/\b(?:sk|pk|ghp|gho|ghs|ghu|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, UKRYTE)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, UKRYTE)
    .replace(/\bBearer\s+\S+/gi, `Bearer ${UKRYTE}`)
    .replace(
      /\b(token|key|secret|password|passwd|authorization|api[_-]?key|klucz|has[łl]o)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
      `$1$2${UKRYTE}`,
    )
    .replace(/[A-Za-z0-9_-]{40,}/g, UKRYTE)
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return tekst.length > LIMIT_WARTOSCI ? `${tekst.slice(0, LIMIT_WARTOSCI - 1)}…` : tekst;
}

export interface OpcjeWiersza {
  /** Szczegół dopisywany w nawiasie do zdania, np. nazwa pliku albo liczba. Już policzony przez nas, nie cudzy tekst. */
  szczegol?: string;
  /** Wersjonowane polecenie połączenia, np. `npx heresthething@0.1.0`. Podstawia `{polecenie}` w działaniu. */
  polecenie?: string;
}

/** Buduje wiersz z słownika. Nieznany kod to błąd programisty (testy D4), nie danych. */
export function wiersz(poziom: Poziom, kod: string, jezyk: Jezyk, opcje: OpcjeWiersza = {}): Wiersz {
  const baza = kod.split(':')[0] ?? kod;
  const objaw = OBJAWY[baza];
  if (objaw === undefined) throw new Error(`diagnostyka: nieznany kod ${kod}`);
  const zdanie = jezyk === 'pl' ? objaw.pl : objaw.en;
  const dzialanieSzablon = jezyk === 'pl' ? objaw.dzialaniePl : objaw.dzialanieEn;
  const polecenie = opcje.polecenie ?? 'npx heresthething';
  const wynik: Wiersz = {
    poziom,
    kod,
    tekst: opcje.szczegol === undefined || opcje.szczegol === '' ? zdanie : `${zdanie} (${opcje.szczegol})`,
  };
  if (dzialanieSzablon !== undefined && (poziom === 'blad' || poziom === 'uwaga')) {
    wynik.dzialanie = dzialanieSzablon.replace('{polecenie}', polecenie);
  }
  return wynik;
}

const POZIOMY: readonly Poziom[] = ['ok', 'uwaga', 'blad', 'info'];

function poprawnyWiersz(w: unknown): w is Wiersz {
  if (typeof w !== 'object' || w === null) return false;
  const r = w as Record<string, unknown>;
  return (
    typeof r.poziom === 'string' &&
    POZIOMY.includes(r.poziom as Poziom) &&
    typeof r.kod === 'string' &&
    typeof r.tekst === 'string' &&
    (r.dzialanie === undefined || typeof r.dzialanie === 'string')
  );
}

/**
 * Jedna kontrola: wyjątek, `undefined` albo zły kształt wyniku dają jeden wiersz `blad`
 * z kodem `kontrola_nieudana`, a reszta raportu idzie dalej.
 */
export function bezpiecznie(nazwa: string, fn: () => Wiersz | Wiersz[] | undefined, jezyk: Jezyk): Wiersz[] {
  try {
    const wynik = fn();
    const lista = Array.isArray(wynik) ? wynik : wynik === undefined ? [] : [wynik];
    if (!lista.every(poprawnyWiersz)) throw new Error('zły kształt wyniku');
    return lista;
  } catch {
    return [wiersz('blad', `kontrola_nieudana:${nazwa}`, jezyk)];
  }
}

export function maBlad(sekcje: readonly Sekcja[]): boolean {
  return sekcje.some(s => s.wiersze.some(w => w.poziom === 'blad'));
}

/** Pierwsze działanie z wiersza `blad`, a gdy ich nie ma, z `uwaga`. */
export function pierwszeDzialanie(sekcje: readonly Sekcja[]): string | undefined {
  for (const poziom of ['blad', 'uwaga'] as const) {
    for (const s of sekcje) {
      for (const w of s.wiersze) if (w.poziom === poziom && w.dzialanie !== undefined) return w.dzialanie;
    }
  }
  return undefined;
}

const ETYKIETY: Record<Jezyk, Record<Poziom, string>> = {
  pl: { ok: '[ok]', uwaga: '[uwaga]', blad: '[błąd]', info: '[info]' },
  en: { ok: '[ok]', uwaga: '[warn]', blad: '[error]', info: '[info]' },
};
const SZEROKOSC_ETYKIETY = 8;

/** Tekst raportu. Każde pole tekstowe przechodzi przez `maskuj`, bez wyjątku. */
export function renderuj(naglowek: readonly string[], sekcje: readonly Sekcja[], jezyk: Jezyk, maski: readonly Maska[] = []): string {
  const m = (t: unknown): string => maskuj(t, maski);
  const linie: string[] = naglowek.map(m);
  const etykietaDzialania = jezyk === 'pl' ? 'Działanie:' : 'Action:';
  for (const sekcja of sekcje) {
    linie.push('', `== ${m(sekcja.tytul)} ==`);
    for (const w of sekcja.wiersze) {
      linie.push(`${ETYKIETY[jezyk][w.poziom].padEnd(SZEROKOSC_ETYKIETY)}${m(w.kod)}: ${m(w.tekst)}`);
      if (w.dzialanie !== undefined) linie.push(`${' '.repeat(SZEROKOSC_ETYKIETY)}${etykietaDzialania} ${m(w.dzialanie)}`);
    }
  }
  return `${linie.join('\n')}\n`;
}
