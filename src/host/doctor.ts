/**
 * `heresthething doctor` (S-33): lokalny raport tylko do odczytu. Nic nie wysyła i niczego nie zapisuje.
 * (Dym uruchamia program lokalny; udanego pingu ten nie loguje, ale `host.log` jest jedynym plikiem, który mógłby się zmienić.)
 *
 * Zasady:
 * - biała lista: w raporcie są tylko wartości, które sami wyliczamy (flagi, liczby, wersje, kody);
 *   treść plików, nazwy projektów i wyjście cudzych programów nie trafiają do raportu wcale,
 * - wyjście cudzych programów czyta program, więc każda kontrola jest w `bezpiecznie`, ma limity
 *   i opiera się na kodzie wyjścia oraz obecności ścieżki, nie na parsowaniu prozy,
 * - brak instalacji to stan normalny (kod 0).
 *
 * Funkcje instalatora przychodzą w `Narzedzia`: instalator ma na dole `await main()`, więc ten plik
 * nie może go importować.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { arch, release } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import {
  bezpiecznie,
  maBlad,
  pierwszeDzialanie,
  renderuj,
  wiersz,
  type Jezyk,
  type Maska,
  type Sekcja,
  type Wiersz,
} from '../wspolne/diagnostyka';
import { ZAKRES_PROTOKOLU } from '../wspolne/protokol';

export interface DziennikDoctor {
  idWtyczki: string;
  stan: string;
  wybor: { przegladarki: string[]; agenci: string[] };
  kroki: Array<{ ok: boolean }>;
}

export type OdczytDziennikaDoctor = { rodzaj: 'brak' } | { rodzaj: 'zly' } | { rodzaj: 'ok'; dziennik: DziennikDoctor };

/** Funkcje instalatora, których `doctor` używa. Typy węższe niż w instalatorze, więc przypisanie przechodzi. */
export interface PrzegladarkaDoctor {
  id: string;
  nazwa: string;
  sprawdzona: boolean;
}

export interface AgentDoctor {
  id: string;
  program: string;
  nazwa: string;
}

export interface Narzedzia {
  przegladarki: readonly PrzegladarkaDoctor[];
  agenci: readonly AgentDoctor[];
  aplikacjaJest(przegladarka: PrzegladarkaDoctor, home: string): boolean;
  maWtyczke(home: string, przegladarka: PrzegladarkaDoctor, id: string): boolean | undefined;
  sciezkaManifestu(home: string, profil: string | undefined, przegladarka: PrzegladarkaDoctor, nazwa?: string): string;
  katalogStaregoKonfigu(home: string, profil: string | undefined): string;
  naSciezce(nazwa: string, pathEnv: string): string | undefined;
  wybierzNode(pl: boolean): { sciezka: string; ostrzezenie?: string | undefined } | undefined;
  xcodeDziala(): boolean;
  odczytajDziennik(sciezka: string): OdczytDziennikaDoctor;
  katalogKonfigu(home: string, profil: string | undefined): string;
}

export interface KontekstDoctor {
  pl: boolean;
  home: string;
  profil: string | undefined;
  wersja: string;
  platforma: string;
  narzedzia: Narzedzia;
}

const WZOR_ID = /^[a-p]{32}$/;
const PLIKI = ['host.mjs', 'mcp.mjs', 'uruchom-host.sh', 'config.json'] as const;
const PATH_LAUNCHD = '/usr/bin:/bin:/usr/sbin:/sbin';
const LIMIT_PLIKU = 64 * 1024;
const LIMIT_MAPOWAN = 1024 * 1024;
const LIMIT_ODPOWIEDZI = 64 * 1024;
const OGON_LOGU = 256 * 1024;
const WPISOW_LOGU = 200;

/** Zwykły plik (bez dowiązań) do `limit` bajtów jako tekst; `null` gdy to nie plik, nie da się go czytać albo jest za duży. */
function czytajPlik(sciezka: string, limit: number): string | null {
  let fd: number | undefined;
  try {
    const opis = lstatSync(sciezka);
    if (!opis.isFile() || opis.size > limit) return null;
    fd = openSync(sciezka, 'r');
    const bufor = Buffer.alloc(opis.size);
    const przeczytano = readSync(fd, bufor, 0, opis.size, 0);
    return bufor.subarray(0, przeczytano).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nic do zrobienia
      }
    }
  }
}

/** Końcówka pliku (≤ `limit` bajtów) i informacja, czy zaczęliśmy w środku linii. */
function ogonPliku(sciezka: string, limit: number): { tekst: string; odcieto: boolean } | null {
  let fd: number | undefined;
  try {
    const opis = lstatSync(sciezka);
    if (!opis.isFile()) return null;
    const dlugosc = Math.min(opis.size, limit);
    fd = openSync(sciezka, 'r');
    const bufor = Buffer.alloc(dlugosc);
    const przeczytano = readSync(fd, bufor, 0, dlugosc, opis.size - dlugosc);
    return { tekst: bufor.subarray(0, przeczytano).toString('utf8'), odcieto: opis.size > limit };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nic do zrobienia
      }
    }
  }
}

function istnieje(sciezka: string): boolean {
  try {
    lstatSync(sciezka);
    return true;
  } catch {
    return false;
  }
}

function zwyklyPlik(sciezka: string): boolean {
  try {
    return lstatSync(sciezka).isFile();
  } catch {
    return false;
  }
}

function wykonywalny(sciezka: string): boolean {
  try {
    if (!lstatSync(sciezka).isFile() && !lstatSync(sciezka).isSymbolicLink()) return false;
    accessSync(sciezka, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function limitDymuMs(): number {
  const surowe = Number(process.env.HERESTT_DOCTOR_LIMIT_MS);
  return Number.isInteger(surowe) && surowe >= 100 && surowe <= 60_000 ? surowe : 10_000;
}

interface Konfig {
  id: string;
  binarki: Record<string, string>;
}

type OdczytKonfigu = { rodzaj: 'brak' } | { rodzaj: 'zly'; powod: string } | { rodzaj: 'ok'; konfig: Konfig };

function odczytajKonfig(katalog: string): OdczytKonfigu {
  const surowy = czytajPlik(join(katalog, 'config.json'), LIMIT_PLIKU);
  if (surowy === null) return istnieje(join(katalog, 'config.json')) ? { rodzaj: 'zly', powod: 'nie da się odczytać' } : { rodzaj: 'brak' };
  let dane: unknown;
  try {
    dane = JSON.parse(surowy);
  } catch {
    return { rodzaj: 'zly', powod: 'to nie jest poprawny JSON' };
  }
  const k = dane as Record<string, unknown> | null;
  if (typeof k !== 'object' || k === null || Array.isArray(k) || k.wersja !== 1) return { rodzaj: 'zly', powod: 'nieznana wersja ustawień' };
  if (typeof k.idWtyczki !== 'string' || !WZOR_ID.test(k.idWtyczki)) return { rodzaj: 'zly', powod: 'niepoprawny identyfikator wtyczki' };
  const b = k.binarki as Record<string, unknown> | null | undefined;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return { rodzaj: 'zly', powod: 'brak sekcji programów' };
  const binarki: Record<string, string> = {};
  for (const nazwa of ['git', 'lsof', 'herdr', 'hc', 'osascript']) {
    const wartosc = b[nazwa];
    if (wartosc === undefined || wartosc === null) {
      if (nazwa === 'git' || nazwa === 'lsof') return { rodzaj: 'zly', powod: `brak programu ${nazwa}` };
      continue;
    }
    if (typeof wartosc !== 'string') return { rodzaj: 'zly', powod: `zły zapis programu ${nazwa}` };
    binarki[nazwa] = wartosc;
  }
  return { rodzaj: 'ok', konfig: { id: k.idWtyczki, binarki } };
}

type WynikDymu = { ok: true; wersjaProgramu: string; wersjaProtokolu: number } | { ok: false; powod: string };

/** Ramka natywna z `ping` przez launcher z ubogim PATH, jak z Docka. Nie rzuca. */
function dym(launcher: string, id: string, home: string): WynikDymu {
  const zadanie = Buffer.from(JSON.stringify({ typ: 'ping', zakres: { od: ZAKRES_PROTOKOLU.od, do: ZAKRES_PROTOKOLU.do }, wersja: ZAKRES_PROTOKOLU.od, idZadania: 'doctor' }));
  const naglowek = Buffer.alloc(4);
  naglowek.writeUInt32LE(zadanie.length, 0);
  const wynik = spawnSync(launcher, [`chrome-extension://${id}/`], {
    input: Buffer.concat([naglowek, zadanie]),
    env: { PATH: PATH_LAUNCHD, HOME: home, USER: process.env.USER ?? '' },
    timeout: limitDymuMs(),
    maxBuffer: LIMIT_ODPOWIEDZI,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (wynik.error !== undefined) {
    const kod = (wynik.error as NodeJS.ErrnoException).code;
    if (kod === 'ETIMEDOUT') return { ok: false, powod: 'czas minął' };
    if (kod === 'ENOBUFS') return { ok: false, powod: 'odpowiedź nieczytelna' };
    return { ok: false, powod: 'nie udało się uruchomić' };
  }
  const bufor = Buffer.isBuffer(wynik.stdout) ? wynik.stdout : Buffer.alloc(0);
  let odpowiedz: unknown = null;
  try {
    const dlugosc = bufor.length >= 4 ? bufor.readUInt32LE(0) : -1;
    if (dlugosc >= 0 && dlugosc <= bufor.length - 4) odpowiedz = JSON.parse(bufor.subarray(4, 4 + dlugosc).toString('utf8'));
  } catch {
    // nieczytelne: niżej
  }
  const o = odpowiedz as Record<string, unknown> | null;
  if (wynik.status !== 0) return { ok: false, powod: `kod wyjścia ${typeof wynik.status === 'number' ? wynik.status : '?'}` };
  if (typeof o !== 'object' || o === null || o.ok !== true || o.typ !== 'ping') return { ok: false, powod: 'odpowiedź nieczytelna' };
  const wersjaProgramu = typeof o.wersjaHosta === 'string' && /^[\w.+-]{1,20}$/.test(o.wersjaHosta) ? o.wersjaHosta : '?';
  const wersjaProtokolu = typeof o.wersja === 'number' && Number.isInteger(o.wersja) && o.wersja > 0 && o.wersja < 1000 ? o.wersja : 0;
  return { ok: true, wersjaProgramu, wersjaProtokolu };
}

function sekcjaSystem(ctx: KontekstDoctor, jezyk: Jezyk): Sekcja {
  const w: Wiersz[] = [];
  w.push(...bezpiecznie('system', () => wiersz('info', 'system', jezyk, { szczegol: `${ctx.platforma} ${release()} ${arch()}` }), jezyk));
  w.push(...bezpiecznie('node', () => wiersz('info', 'node', jezyk, { szczegol: process.version }), jezyk));
  w.push(...bezpiecznie('node_wybrany', () => {
    const wybrany = ctx.narzedzia.wybierzNode(ctx.pl);
    if (wybrany === undefined) return wiersz('blad', 'node_brak', jezyk, { polecenie: polecenie(ctx) });
    const wiersze = [wiersz('info', 'node_wybrany', jezyk, { szczegol: wybrany.sciezka })];
    if (wybrany.ostrzezenie !== undefined) wiersze.push(wiersz('uwaga', 'node_wersjonowany', jezyk, { polecenie: polecenie(ctx) }));
    return wiersze;
  }, jezyk));
  w.push(...bezpiecznie('xcode', () => (ctx.narzedzia.xcodeDziala()
    ? wiersz('ok', 'xcode', jezyk)
    : wiersz('uwaga', 'xcode_brak', jezyk)), jezyk));
  return { tytul: jezyk === 'pl' ? 'System i narzędzia' : 'System and tools', wiersze: w };
}

function polecenie(ctx: KontekstDoctor): string {
  return ctx.wersja === '' ? 'npx heresthething' : `npx heresthething@${ctx.wersja}`;
}

function liczMapowania(katalog: string): number | null {
  const surowy = czytajPlik(join(katalog, 'mapowania.json'), LIMIT_MAPOWAN);
  if (surowy === null) return null;
  try {
    const dane = JSON.parse(surowy) as { mapowania?: unknown } | null;
    const m = dane?.mapowania;
    return typeof m === 'object' && m !== null && !Array.isArray(m) ? Object.keys(m).length : null;
  } catch {
    return null;
  }
}

/** Z końcówki `host.log`: liczba wpisów, błędy po kodach (tylko znane kształty kodu), uszkodzone linie. */
function podsumujLog(katalog: string): { wpisow: number; bledy: Map<string, number>; uszkodzone: number; ostatni?: string } | null {
  const ogon = ogonPliku(join(katalog, 'host.log'), OGON_LOGU);
  if (ogon === null) return null;
  let linie = ogon.tekst.split('\n').filter(l => l.length > 0);
  if (ogon.odcieto) linie = linie.slice(1);
  linie = linie.slice(-WPISOW_LOGU);
  const bledy = new Map<string, number>();
  let uszkodzone = 0;
  let ostatni: string | undefined;
  for (const linia of linie) {
    try {
      const wpis = JSON.parse(linia) as Record<string, unknown> | null;
      if (typeof wpis !== 'object' || wpis === null || Array.isArray(wpis) || typeof wpis.ok !== 'boolean') {
        uszkodzone++;
        continue;
      }
      if (wpis.ok === false) {
        const kod = typeof wpis.kod === 'string' && /^[a-z_]{1,40}$/.test(wpis.kod) ? wpis.kod : 'inny';
        bledy.set(kod, (bledy.get(kod) ?? 0) + 1);
        if (typeof wpis.t === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(wpis.t)) ostatni = wpis.t;
      }
    } catch {
      uszkodzone++;
    }
  }
  return { wpisow: linie.length, bledy, uszkodzone, ...(ostatni === undefined ? {} : { ostatni }) };
}

interface StanProgramu {
  sekcja: Sekcja;
  /** Jest cokolwiek po instalacji (po `undo` i przy czystym koncie: nie). */
  zainstalowano: boolean;
  konfig: Konfig | undefined;
  dziennik: DziennikDoctor | undefined;
}

function sekcjaProgram(ctx: KontekstDoctor, jezyk: Jezyk, manifestyIstnieja: boolean): StanProgramu {
  const tytul = jezyk === 'pl' ? 'Program lokalny' : 'Local program';
  const katalog = ctx.narzedzia.katalogKonfigu(ctx.home, ctx.profil);
  const w: Wiersz[] = [];
  const dziennik = ctx.narzedzia.odczytajDziennik(join(katalog, 'instalacja.json'));
  const jestPlik = PLIKI.some(nazwa => istnieje(join(katalog, nazwa)));
  const cofniete = dziennik.rodzaj === 'ok' && dziennik.dziennik.stan === 'cofniecie';
  // Po `undo` katalog zostaje (mapowania, log, dziennik), ale to nie jest awaria.
  if (!jestPlik && (dziennik.rodzaj !== 'ok' || cofniete)) {
    // Opis połączenia w przeglądarce bez programu lokalnego to awaria, nie „nie skonfigurowano”.
    if (manifestyIstnieja) w.push(wiersz('blad', 'plik_brak:program', jezyk, { polecenie: polecenie(ctx) }));
    else w.push(wiersz('info', 'nie_polaczono', jezyk));
    return { sekcja: { tytul, wiersze: w }, zainstalowano: false, konfig: undefined, dziennik: undefined };
  }

  w.push(wiersz('info', 'katalog', jezyk, { szczegol: katalog }));
  for (const nazwa of PLIKI) {
    w.push(...bezpiecznie(`plik_${nazwa}`, () => {
      const sciezka = join(katalog, nazwa);
      const jest = nazwa === 'uruchom-host.sh' ? wykonywalny(sciezka) : zwyklyPlik(sciezka);
      return jest ? undefined : wiersz('blad', `plik_brak:${nazwa}`, jezyk, { polecenie: polecenie(ctx) });
    }, jezyk));
  }

  const odczyt = odczytajKonfig(katalog);
  if (odczyt.rodzaj === 'zly') w.push(wiersz('blad', 'config_zly', jezyk, { szczegol: odczyt.powod, polecenie: polecenie(ctx) }));
  if (odczyt.rodzaj !== 'brak') {
    w.push(...bezpiecznie('config_prawa', () => {
      const tryb = lstatSync(join(katalog, 'config.json')).mode;
      return (tryb & 0o077) !== 0 ? wiersz('uwaga', 'config_prawa', jezyk, { polecenie: polecenie(ctx) }) : undefined;
    }, jezyk));
  }
  if (odczyt.rodzaj === 'ok') {
    for (const [nazwa, sciezka] of Object.entries(odczyt.konfig.binarki)) {
      w.push(...bezpiecznie(`binarka_${nazwa}`, () => (isAbsolute(sciezka) && wykonywalny(sciezka)
        ? undefined
        : wiersz('blad', `binarka_brak:${nazwa}`, jezyk, { polecenie: polecenie(ctx) })), jezyk));
    }
  }

  if (dziennik.rodzaj === 'zly') w.push(wiersz('uwaga', 'dziennik_zly', jezyk, { polecenie: polecenie(ctx) }));
  if (dziennik.rodzaj === 'ok') {
    const d = dziennik.dziennik;
    if (d.stan === 'czesciowy' || d.kroki.some(k => k.ok === false)) w.push(wiersz('uwaga', 'dziennik_czesciowy', jezyk, { polecenie: polecenie(ctx) }));
    if (odczyt.rodzaj === 'ok' && d.idWtyczki !== odczyt.konfig.id) w.push(wiersz('blad', 'id_rozne', jezyk, { polecenie: polecenie(ctx) }));
  }

  w.push(...bezpiecznie('mapowania', () => {
    const ile = liczMapowania(katalog);
    return ile === null ? undefined : wiersz('info', 'mapowania', jezyk, { szczegol: String(ile) });
  }, jezyk));

  w.push(...bezpiecznie('log', () => {
    const log = podsumujLog(katalog);
    if (log === null) return undefined;
    const wiersze: Wiersz[] = [];
    const lacznie = [...log.bledy.values()].reduce((a, b) => a + b, 0);
    const kody = [...log.bledy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}×${n}`).join(', ');
    const szczegol = lacznie === 0
      ? `0 / ${log.wpisow}`
      : `${lacznie} / ${log.wpisow}: ${kody}${log.ostatni === undefined ? '' : `; ${jezyk === 'pl' ? 'ostatni' : 'last'} ${log.ostatni}`}`;
    wiersze.push(wiersz('info', 'log_bledy', jezyk, { szczegol }));
    if (log.uszkodzone > 0) wiersze.push(wiersz('info', 'log_uszkodzony', jezyk, { szczegol: String(log.uszkodzone) }));
    return wiersze;
  }, jezyk));

  if (odczyt.rodzaj === 'ok') {
    const launcher = join(katalog, 'uruchom-host.sh');
    if (wykonywalny(launcher)) {
      const id = odczyt.konfig.id;
      w.push(...bezpiecznie('dym', () => {
        const wynik = dym(launcher, id, ctx.home);
        return wynik.ok
          ? wiersz('ok', 'host_ping_ok', jezyk, { szczegol: `program ${wynik.wersjaProgramu}, ${jezyk === 'pl' ? 'protokół' : 'protocol'} ${wynik.wersjaProtokolu}` })
          : wiersz('blad', 'host_ping_blad', jezyk, { szczegol: wynik.powod, polecenie: polecenie(ctx) });
      }, jezyk));
    }
  }
  return {
    sekcja: { tytul, wiersze: w },
    zainstalowano: true,
    konfig: odczyt.rodzaj === 'ok' ? odczyt.konfig : undefined,
    dziennik: dziennik.rodzaj === 'ok' ? dziennik.dziennik : undefined,
  };
}

function maski(ctx: KontekstDoctor): Maska[] {
  const wynik: Maska[] = [];
  const dodaj = (prefiks: string | undefined, jako: string): void => {
    if (prefiks === undefined || prefiks.length === 0) return;
    wynik.push({ prefiks, jako });
    try {
      const prawdziwa = realpathSync(prefiks);
      if (prawdziwa !== prefiks) wynik.push({ prefiks: prawdziwa, jako });
    } catch {
      // brak katalogu: wystarczy zapis podany
    }
  };
  dodaj(ctx.home, '~');
  dodaj(ctx.profil, '<profil>');
  return wynik;
}

/** Pliki `.plist` zarządzania organizacyjnego; Arc nie ma własnego. Sam fakt pliku, bez czytania zawartości. */
const PLISTY: Record<string, string> = {
  chrome: 'com.google.Chrome',
  edge: 'com.microsoft.Edge',
  brave: 'com.brave.Browser',
  vivaldi: 'com.vivaldi.Vivaldi',
};

function zarzadzana(id: string, home: string): boolean {
  const plist = PLISTY[id];
  if (plist === undefined) return false;
  const katalog = process.env.HERESTT_MANAGED_PREFS !== undefined && process.env.HERESTT_MANAGED_PREFS.length > 0
    ? process.env.HERESTT_MANAGED_PREFS
    : '/Library/Managed Preferences';
  const uzytkownik = process.env.USER !== undefined && process.env.USER.length > 0 ? process.env.USER : basename(home);
  return zwyklyPlik(join(katalog, `${plist}.plist`)) || zwyklyPlik(join(katalog, uzytkownik, `${plist}.plist`));
}

function tak(jest: boolean, jezyk: Jezyk, nazwa: string): string {
  return jezyk === 'pl' ? `${nazwa} ${jest ? 'jest' : 'brak'}` : `${nazwa} ${jest ? 'present' : 'missing'}`;
}

function sekcjaPrzegladarki(ctx: KontekstDoctor, jezyk: Jezyk, stan: StanProgramu): Sekcja {
  const n = ctx.narzedzia;
  const w: Wiersz[] = [];
  const launcher = join(n.katalogKonfigu(ctx.home, ctx.profil), 'uruchom-host.sh');
  for (const p of n.przegladarki) {
    w.push(...bezpiecznie(`przegladarka_${p.id}`, () => {
      const sciezka = n.sciezkaManifestu(ctx.home, ctx.profil, p);
      const manifestJest = zwyklyPlik(sciezka);
      const aplikacja = n.aplikacjaJest(p, ctx.home);
      if (!aplikacja && !manifestJest) return undefined;
      const id = stan.konfig?.id;
      const wtyczka = id === undefined ? undefined : n.maWtyczke(ctx.home, p, id);
      const opis = [
        tak(aplikacja, jezyk, jezyk === 'pl' ? 'aplikacja' : 'app'),
        tak(manifestJest, jezyk, jezyk === 'pl' ? 'opis połączenia' : 'connection description'),
        wtyczka === undefined ? (jezyk === 'pl' ? 'wtyczka w profilu nieznana' : 'extension in profile unknown') : tak(wtyczka, jezyk, jezyk === 'pl' ? 'wtyczka w profilu' : 'extension in profile'),
      ].join(', ');
      const dopisek = p.sprawdzona ? '' : (jezyk === 'pl' ? ' (niesprawdzone)' : ' (not verified here)');
      const wiersze: Wiersz[] = [wiersz('info', 'przegladarka', jezyk, { szczegol: `${p.nazwa}${dopisek}: ${opis}` })];
      const poleceniePelne = polecenie(ctx);
      if (manifestJest) {
        const surowy = czytajPlik(sciezka, LIMIT_PLIKU);
        let manifest: Record<string, unknown> | null = null;
        try {
          const dane: unknown = surowy === null ? null : JSON.parse(surowy);
          manifest = typeof dane === 'object' && dane !== null && !Array.isArray(dane) ? (dane as Record<string, unknown>) : null;
        } catch {
          manifest = null;
        }
        if (manifest === null) {
          wiersze.push(wiersz('blad', 'manifest_zly', jezyk, { szczegol: p.nazwa, polecenie: poleceniePelne }));
        } else {
          if (id !== undefined) {
            const origins = manifest.allowed_origins;
            const zgodny = Array.isArray(origins) && origins.length === 1 && origins[0] === `chrome-extension://${id}/`;
            if (!zgodny) wiersze.push(wiersz('blad', 'manifest_origin_inny', jezyk, { szczegol: p.nazwa, polecenie: poleceniePelne }));
          }
          if (manifest.path !== launcher) wiersze.push(wiersz('blad', 'manifest_sciezka_inna', jezyk, { szczegol: p.nazwa, polecenie: poleceniePelne }));
          if (wtyczka === false) wiersze.push(wiersz('uwaga', 'wtyczki_brak_w_profilu', jezyk, { szczegol: p.nazwa, polecenie: poleceniePelne }));
        }
      } else if (stan.zainstalowano && (wtyczka === true || stan.dziennik?.wybor.przegladarki.includes(p.id) === true)) {
        wiersze.push(wiersz('uwaga', 'manifest_brak', jezyk, { szczegol: p.nazwa, polecenie: poleceniePelne }));
      }
      if (zarzadzana(p.id, ctx.home)) wiersze.push(wiersz('uwaga', 'przegladarka_zarzadzana', jezyk, { szczegol: p.nazwa }));
      return wiersze;
    }, jezyk));
  }
  return { tytul: jezyk === 'pl' ? 'Przeglądarki' : 'Browsers', wiersze: w };
}

function limitAgentaMs(): number {
  const surowe = Number(process.env.HERESTT_DOCTOR_LIMIT_MS);
  return Number.isInteger(surowe) && surowe >= 100 && surowe <= 60_000 ? surowe : 20_000;
}

function sekcjaAgenci(ctx: KontekstDoctor, jezyk: Jezyk, stan: StanProgramu): Sekcja {
  const w: Wiersz[] = [];
  const mcp = join(ctx.narzedzia.katalogKonfigu(ctx.home, ctx.profil), 'mcp.mjs');
  let ktorykolwiekMaWpis = false;
  for (const agent of ctx.narzedzia.agenci) {
    w.push(...bezpiecznie(`agent_${agent.id}`, () => {
      const program = ctx.narzedzia.naSciezce(agent.program, process.env.PATH ?? '');
      if (program === undefined) return wiersz('info', 'agent_brak', jezyk, { szczegol: agent.nazwa });
      // Z wyjścia `mcp get` bierzemy tylko kod wyjścia i fakt, że wspomina ścieżkę `mcp.mjs`. Samo wyjście nie jest wypisywane.
      const wynik = spawnSync(program, ['mcp', 'get', 'herestt'], {
        encoding: 'utf8',
        timeout: limitAgentaMs(),
        maxBuffer: 256 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const wyjscie = `${typeof wynik.stdout === 'string' ? wynik.stdout : ''}${typeof wynik.stderr === 'string' ? wynik.stderr : ''}`;
      if (wynik.error === undefined && wynik.status === 0) {
        ktorykolwiekMaWpis = true;
        if (wyjscie.includes('mcp.mjs') && !wyjscie.includes(mcp)) {
          return wiersz('uwaga', 'agent_wpis_inna_sciezka', jezyk, { szczegol: agent.nazwa, polecenie: polecenie(ctx) });
        }
        return wiersz('ok', 'agent_wpis_ok', jezyk, { szczegol: agent.nazwa });
      }
      // Agent, którego nie wybrano przy instalacji, nie musi mieć wpisu: to informacja, nie uwaga.
      const wybrany = stan.dziennik === undefined || stan.dziennik.wybor.agenci.includes(agent.id);
      return wiersz(wybrany ? 'uwaga' : 'info', 'agent_bez_wpisu', jezyk, { szczegol: agent.nazwa, polecenie: polecenie(ctx) });
    }, jezyk));
  }
  if (ktorykolwiekMaWpis) w.push(wiersz('info', 'agent_nowa_sesja', jezyk));
  return { tytul: jezyk === 'pl' ? 'Agenci' : 'Agents', wiersze: w };
}

function sekcjaSlady(ctx: KontekstDoctor, jezyk: Jezyk): Sekcja | undefined {
  const n = ctx.narzedzia;
  const wiersze = bezpiecznie('stare_slady', () => {
    let ile = istnieje(n.katalogStaregoKonfigu(ctx.home, ctx.profil)) ? 1 : 0;
    for (const p of n.przegladarki) {
      if (istnieje(n.sciezkaManifestu(ctx.home, ctx.profil, p, 'pl.tryb_uwag.host.json'))) ile++;
    }
    return ile === 0 ? undefined : wiersz('uwaga', 'stare_slady', jezyk, { szczegol: String(ile), polecenie: polecenie(ctx) });
  }, jezyk);
  return wiersze.length === 0 ? undefined : { tytul: jezyk === 'pl' ? 'Ślady starej wersji' : 'Traces of the old version', wiersze };
}

/** Zbiera sekcje raportu. Nie rzuca. */
export function zbierzRaport(ctx: KontekstDoctor): Sekcja[] {
  const jezyk: Jezyk = ctx.pl ? 'pl' : 'en';
  const n = ctx.narzedzia;
  const manifestyIstnieja = n.przegladarki.some(p => {
    try {
      return zwyklyPlik(n.sciezkaManifestu(ctx.home, ctx.profil, p));
    } catch {
      return false;
    }
  });
  const sekcje: Sekcja[] = [sekcjaSystem(ctx, jezyk)];
  const stan = sekcjaProgram(ctx, jezyk, manifestyIstnieja);
  sekcje.push(stan.sekcja);
  if (stan.zainstalowano || manifestyIstnieja) {
    sekcje.push(sekcjaPrzegladarki(ctx, jezyk, stan));
    sekcje.push(sekcjaAgenci(ctx, jezyk, stan));
  }
  const slady = sekcjaSlady(ctx, jezyk);
  if (slady !== undefined) sekcje.push(slady);
  return sekcje;
}

/** Drukuje raport i kończy proces: 0 bez wiersza `blad`, 1 z nim. */
export function uruchomDoctor(ctx: KontekstDoctor): never {
  const jezyk: Jezyk = ctx.pl ? 'pl' : 'en';
  const sekcje = zbierzRaport(ctx);
  const naglowek = [
    `heresthething doctor${ctx.wersja === '' ? '' : ` ${ctx.wersja}`}`,
    jezyk === 'pl'
      ? 'Raport powstał na tym komputerze. Niczego nie wysyła. Ścieżka domowa jest skrócona do ~.'
      : 'This report was made on this computer. It sends nothing. The home path is shortened to ~.',
  ];
  let tekst = renderuj(naglowek, sekcje, jezyk, maski(ctx));
  const dzialanie = pierwszeDzialanie(sekcje);
  tekst += `\n${dzialanie === undefined
    ? (jezyk === 'pl' ? 'Wszystko gra.' : 'All good.')
    : `${jezyk === 'pl' ? 'Co teraz:' : 'What now:'} ${dzialanie}`}\n`;
  process.stdout.write(tekst);
  process.exit(maBlad(sekcje) ? 1 : 0);
}
