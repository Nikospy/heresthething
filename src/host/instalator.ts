/**
 * Instalator połączenia (faza 2): podgląd, zapis z dziennikiem i `undo`.
 * Szew testów to zmienne HERESTT_*, nie flagi publiczne:
 * HERESTT_PLATFORM, HERESTT_NODE_STALE, HERESTT_XCODE_SELECT,
 * HERESTT_APPLICATIONS, HERESTT_PLIK_SKLEPU, HERESTT_TTY.
 * Tylko dla starych skryptów (install.sh, polacz.sh, uninstall.sh):
 * HERESTT_WYMUS_PRZEGLADARKI=1 (nazwana przeglądarka bez aplikacji w /Applications) i
 * HERESTT_BEZ_PROSBY=1 (prośbę do agenta wypisuje skrypt),
 * HERESTT_BEZ_MCP=1 (nie woła CLI agentów przy sprzątaniu starego wpisu; install.sh nigdy nie ruszał MCP).
 * `--bez-budowania` jest przyjmowane; instalator sam niczego nie buduje.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PROSBA_DO_AGENTA } from '../wspolne/prosba';
import { uruchomDoctor } from './doctor';

const WZOR_ID = /^[a-p]{32}$/;

const PRZEGLADARKI = [
  { id: 'chrome', nazwa: 'Chrome', aplikacja: 'Google Chrome.app', katalog: 'Google/Chrome', sprawdzona: true },
  { id: 'edge', nazwa: 'Edge', aplikacja: 'Microsoft Edge.app', katalog: 'Microsoft Edge', sprawdzona: false },
  { id: 'brave', nazwa: 'Brave', aplikacja: 'Brave Browser.app', katalog: 'BraveSoftware/Brave-Browser', sprawdzona: false },
  { id: 'arc', nazwa: 'Arc', aplikacja: 'Arc.app', katalog: 'Arc/User Data', sprawdzona: false },
  { id: 'vivaldi', nazwa: 'Vivaldi', aplikacja: 'Vivaldi.app', katalog: 'Vivaldi', sprawdzona: false },
] as const;

const AGENCI = [
  { id: 'claude', program: 'claude', nazwa: 'Claude Code' },
  { id: 'codex', program: 'codex', nazwa: 'Codex' },
] as const;

type Przegladarka = (typeof PRZEGLADARKI)[number];
type IdPrzegladarki = Przegladarka['id'];
type Agent = (typeof AGENCI)[number];
type IdAgenta = Agent['id'];

interface Opcje {
  dryRun: boolean;
  yes: boolean;
  undo: boolean;
  /** S-33: `doctor` — raport tylko do odczytu. */
  doctor: boolean;
  all: boolean;
  browsers: IdPrzegladarki[] | undefined;
  agents: IdAgenta[] | undefined;
  profil: string | undefined;
  id: string | undefined;
}

function polskiJezyk(): boolean {
  for (const klucz of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const wartosc = process.env[klucz];
    if (wartosc !== undefined && wartosc.length > 0) return wartosc.startsWith('pl');
  }
  return false;
}

function koniec(kod: number, zdanie: string): never {
  process.stdout.write(`${zdanie}\n`);
  process.exit(kod);
}

function naSciezce(nazwa: string, pathEnv: string): string | undefined {
  for (const katalog of pathEnv.split(':')) {
    if (katalog.length === 0) continue;
    const pelna = join(katalog, nazwa);
    try {
      // Jak powłoka: zepsute dowiązanie albo plik bez prawa wykonania nie jest programem na PATH.
      if (!statSync(pelna).isFile()) continue;
      accessSync(pelna, constants.X_OK);
      return pelna;
    } catch {
      // kolejny katalog PATH
    }
  }
  return undefined;
}

/** Ścieżka nvm/fnm: numer wersji w katalogu albo `versions/node`. Sam fakt ścieżki, bez uruchamiania. */
function wersjonowana(sciezka: string): boolean {
  return /\/v\d+\.\d+/.test(sciezka) || sciezka.includes('versions/node') || sciezka.includes('node-versions');
}

function majorNode(sciezka: string): number {
  try {
    const opis = lstatSync(sciezka);
    if (!opis.isFile() && !opis.isSymbolicLink()) return -1;
  } catch {
    return -1;
  }
  try {
    const wyjscie = execFileSync(sciezka, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const traf = /v?(\d+)/.exec(wyjscie);
    const major = traf?.[1];
    return major === undefined ? -1 : Number(major);
  } catch {
    return -1;
  }
}

function katalogJest(sciezka: string): boolean {
  try {
    return lstatSync(sciezka).isDirectory();
  } catch {
    return false;
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

function korzenRepo(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (istnieje(join(dir, 'package.json'))) return dir;
    const rodzic = dirname(dir);
    if (rodzic === dir) koniec(1, 'Nie znaleziono package.json nad instalatorem.');
    dir = rodzic;
  }
}

function czytajId(korzen: string, opcja: string | undefined, pl: boolean): string {
  if (opcja !== undefined) {
    const id = opcja.trim();
    if (!WZOR_ID.test(id)) {
      koniec(1, pl ? 'Identyfikator z --id jest niepoprawny.' : 'The --id value is invalid.');
    }
    return id;
  }
  const plikSklepu = process.env.HERESTT_PLIK_SKLEPU ?? join(korzen, 'src/wspolne/id-sklepu.txt');
  if (istnieje(plikSklepu)) {
    const tresc = readFileSync(plikSklepu, 'utf8').trim();
    if (!WZOR_ID.test(tresc)) {
      koniec(1, pl ? 'Plik identyfikatora sklepu jest niepoprawny.' : 'The store id file is invalid.');
    }
    return tresc;
  }
  const plikWtyczki = join(korzen, 'src/wspolne/id-wtyczki.txt');
  if (!istnieje(plikWtyczki)) {
    koniec(1, pl ? 'Brak pliku identyfikatora wtyczki.' : 'The extension id file is missing.');
  }
  const tresc = readFileSync(plikWtyczki, 'utf8').trim();
  if (!WZOR_ID.test(tresc)) {
    koniec(1, pl ? 'Plik identyfikatora wtyczki jest niepoprawny.' : 'The extension id file is invalid.');
  }
  return tresc;
}

function znanaPrzegladarka(id: string): id is IdPrzegladarki {
  return PRZEGLADARKI.some(p => p.id === id);
}

function znanyAgent(id: string): id is IdAgenta {
  return AGENCI.some(a => a.id === id);
}

function parsujListe(surowa: string): string[] {
  return surowa.split(',').map(czesc => czesc.trim()).filter(czesc => czesc.length > 0);
}

function parsuj(argv: string[], pl: boolean): Opcje {
  const opcje: Opcje = {
    dryRun: false,
    yes: false,
    undo: false,
    doctor: false,
    all: false,
    browsers: undefined,
    agents: undefined,
    profil: undefined,
    id: undefined,
  };
  const wez = (i: number, arg: string): { indeks: number; wartosc: string } => {
    const rowna = arg.indexOf('=');
    if (rowna !== -1) return { indeks: i, wartosc: arg.slice(rowna + 1) };
    const nastepna = argv[i + 1];
    if (nastepna === undefined || nastepna.startsWith('-')) {
      koniec(2, pl ? `Brak wartości po ${arg}.` : `Missing value after ${arg}.`);
    }
    return { indeks: i + 1, wartosc: nastepna };
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === 'undo') {
      opcje.undo = true;
      continue;
    }
    if (arg === 'doctor') {
      opcje.doctor = true;
      continue;
    }
    if (arg === '--all') {
      opcje.all = true;
      continue;
    }
    if (arg === '--dry-run') {
      opcje.dryRun = true;
      continue;
    }
    if (arg === '--yes') {
      opcje.yes = true;
      continue;
    }
    if (arg === '--bez-budowania') continue;
    if (arg === '--browsers' || arg.startsWith('--browsers=')) {
      if (opcje.browsers !== undefined) koniec(2, pl ? 'Flaga --browsers podana drugi raz.' : '--browsers was given twice.');
      const pobrane = wez(i, arg);
      i = pobrane.indeks;
      const ids = parsujListe(pobrane.wartosc);
      if (ids.length === 0) koniec(2, pl ? 'Pusta lista --browsers.' : 'Empty --browsers list.');
      const wynik: IdPrzegladarki[] = [];
      for (const id of ids) {
        if (!znanaPrzegladarka(id)) koniec(2, pl ? `Nieznana przeglądarka: ${id}` : `Unknown browser: ${id}`);
        if (!wynik.includes(id)) wynik.push(id);
      }
      opcje.browsers = wynik;
      continue;
    }
    if (arg === '--agents' || arg.startsWith('--agents=')) {
      if (opcje.agents !== undefined) koniec(2, pl ? 'Flaga --agents podana drugi raz.' : '--agents was given twice.');
      const pobrane = wez(i, arg);
      i = pobrane.indeks;
      const ids = parsujListe(pobrane.wartosc);
      if (ids.length === 1 && ids[0] === 'none') {
        opcje.agents = [];
        continue;
      }
      if (ids.includes('none') || ids.length === 0) {
        koniec(2, pl ? 'Lista --agents: claude, codex albo none.' : '--agents expects claude, codex, or none.');
      }
      const wynik: IdAgenta[] = [];
      for (const id of ids) {
        if (!znanyAgent(id)) koniec(2, pl ? `Nieznany agent: ${id}` : `Unknown agent: ${id}`);
        if (!wynik.includes(id)) wynik.push(id);
      }
      opcje.agents = wynik;
      continue;
    }
    if (arg === '--profil' || arg.startsWith('--profil=')) {
      if (opcje.profil !== undefined) koniec(2, pl ? 'Flaga --profil podana drugi raz.' : '--profil was given twice.');
      const pobrane = wez(i, arg);
      i = pobrane.indeks;
      if (pobrane.wartosc.length === 0) koniec(2, pl ? 'Pusta ścieżka --profil.' : 'Empty --profil path.');
      opcje.profil = pobrane.wartosc;
      continue;
    }
    if (arg === '--id' || arg.startsWith('--id=')) {
      if (opcje.id !== undefined) koniec(2, pl ? 'Flaga --id podana drugi raz.' : '--id was given twice.');
      const pobrane = wez(i, arg);
      i = pobrane.indeks;
      opcje.id = pobrane.wartosc;
      continue;
    }
    koniec(2, pl ? `Nieznana opcja: ${arg}` : `Unknown option: ${arg}`);
  }
  if (opcje.doctor && (opcje.undo || opcje.all || opcje.dryRun || opcje.yes || opcje.browsers !== undefined || opcje.agents !== undefined || opcje.id !== undefined)) {
    koniec(2, pl ? 'Polecenie doctor nie przyjmuje innych opcji niż --profil.' : 'The doctor command takes no options other than --profil.');
  }
  if (opcje.all && !opcje.undo) koniec(2, pl ? 'Flaga --all tylko razem z undo.' : '--all belongs with undo.');
  return opcje;
}

function korzenieAplikacji(home: string): string[] {
  const nadpisane = process.env.HERESTT_APPLICATIONS;
  const glowne = nadpisane !== undefined && nadpisane.length > 0 ? nadpisane : '/Applications';
  return [glowne, join(home, 'Applications')];
}

function aplikacjaJest(przegladarka: Przegladarka, home: string): boolean {
  return korzenieAplikacji(home).some(korzen => istnieje(join(korzen, przegladarka.aplikacja)));
}

function katalogDanych(home: string, przegladarka: Przegladarka): string {
  return join(home, 'Library', 'Application Support', przegladarka.katalog);
}

/** Plik ustawień profilu większy niż to jest podejrzany: nie czytamy go i nie zgadujemy. */
const LIMIT_USTAWIEN_PROFILU = 32 * 1024 * 1024;

/**
 * Czy profil zna wtyczkę z ustawień (`extensions.settings.<id>`). Wtyczka rozpakowana nie ma
 * katalogu `Extensions/<id>`: jest tylko wpis ze ścieżką w `Preferences` albo `Secure Preferences`.
 * `undefined`: pliku nie da się przeczytać ani zrozumieć. Tylko odczyt, bez śledzenia dowiązań.
 */
function wtyczkaWUstawieniach(profil: string, id: string): boolean | undefined {
  let nieczytelny = false;
  for (const nazwa of ['Secure Preferences', 'Preferences']) {
    const sciezka = join(profil, nazwa);
    let dane: unknown;
    try {
      const opis = lstatSync(sciezka);
      if (!opis.isFile() || opis.size > LIMIT_USTAWIEN_PROFILU) { nieczytelny = true; continue; }
      dane = JSON.parse(readFileSync(sciezka, 'utf8'));
    } catch (blad) {
      if ((blad as NodeJS.ErrnoException).code !== 'ENOENT') nieczytelny = true;
      continue;
    }
    const ustawienia = (dane as { extensions?: { settings?: unknown } } | null)?.extensions?.settings;
    if (typeof ustawienia === 'object' && ustawienia !== null && Object.hasOwn(ustawienia, id)) return true;
  }
  return nieczytelny ? undefined : false;
}

/**
 * Czy któryś profil przeglądarki ma wtyczkę: katalog `Extensions/<id>` (ze sklepu)
 * albo wpis w ustawieniach profilu (rozpakowana). `undefined` = nie wiadomo
 * (katalog danych albo plik ustawień nieczytelny): to informacja, nie ostrzeżenie.
 */
function maWtyczke(home: string, przegladarka: Przegladarka, id: string): boolean | undefined {
  const korzen = katalogDanych(home, przegladarka);
  let wpisy: string[];
  try {
    wpisy = readdirSync(korzen);
  } catch (blad) {
    return (blad as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined;
  }
  let niepewne = false;
  for (const wpis of wpisy) {
    const profil = join(korzen, wpis);
    if (!katalogJest(profil)) continue;
    if (katalogJest(join(profil, 'Extensions', id))) return true;
    // Profil to katalog z ustawieniami; inne katalogi (Crashpad, Safe Browsing) nie mają tych plików.
    const zUstawien = wtyczkaWUstawieniach(profil, id);
    if (zUstawien === true) return true;
    if (zUstawien === undefined) niepewne = true;
  }
  return niepewne ? undefined : false;
}

function sciezkaManifestu(home: string, profil: string | undefined, przegladarka: Przegladarka, nazwa = 'com.herestt.host.json'): string {
  if (profil !== undefined) {
    if (przegladarka.id === 'chrome') return join(profil, 'NativeMessagingHosts', nazwa);
    return join(profil, 'przegladarki', przegladarka.id, 'NativeMessagingHosts', nazwa);
  }
  return join(katalogDanych(home, przegladarka), 'NativeMessagingHosts', nazwa);
}

function katalogKonfigu(home: string, profil: string | undefined): string {
  return profil === undefined ? join(home, '.config', 'herestt') : join(profil, 'herestt');
}

function liniaPrzegladarki(przegladarka: Przegladarka, pl: boolean): string {
  const etykieta = pl ? 'przeglądarka' : 'browser';
  if (przegladarka.sprawdzona) return `${etykieta}: ${przegladarka.nazwa}`;
  const dopisek = pl ? 'niesprawdzone' : 'not verified here';
  return `${etykieta}: ${przegladarka.nazwa} (${dopisek})`;
}

function zdanieBrakuAgenta(agent: Agent, pl: boolean): string {
  if (agent.id === 'codex') {
    return pl ? 'Nie znaleziono Codexa. Pomijam.' : 'Codex was not found. Skipping.';
  }
  return pl ? 'Nie znaleziono Claude Code. Pomijam.' : 'Claude Code was not found. Skipping.';
}

function tty(): boolean {
  const wymuszenie = process.env.HERESTT_TTY;
  if (wymuszenie === '1') return true;
  if (wymuszenie === '0') return false;
  return process.stdout.isTTY === true;
}

function parsujNumery(linia: string, ile: number): number[] | 'domyslne' | 'zle' {
  const tresc = linia.trim();
  if (tresc.length === 0) return 'domyslne';
  const czesci = tresc.split(/[\s,]+/).filter(czesc => czesc.length > 0);
  if (czesci.length === 0) return 'domyslne';
  const numery: number[] = [];
  for (const czesc of czesci) {
    if (!/^[1-9]\d*$/.test(czesc)) return 'zle';
    const numer = Number(czesc);
    if (numer < 1 || numer > ile || numery.includes(numer)) return 'zle';
    numery.push(numer);
  }
  return numery;
}

interface NodeWybrany {
  sciezka: string;
  ostrzezenie: string | undefined;
}

function wybierzNode(pl: boolean): NodeWybrany | undefined {
  const surowe = process.env.HERESTT_NODE_STALE;
  const stale = surowe === undefined
    ? ['/opt/homebrew/bin/node', '/usr/local/bin/node']
    : surowe.split(':').filter(sciezka => sciezka.length > 0);
  const zPath = naSciezce('node', process.env.PATH ?? '');
  let wybrana: string | undefined;
  for (const kandydat of stale) {
    if (majorNode(kandydat) >= 22) {
      wybrana = kandydat;
      break;
    }
  }
  const pathWersjonowana = zPath !== undefined && wersjonowana(zPath);
  if (wybrana === undefined && zPath !== undefined && majorNode(zPath) >= 22) wybrana = zPath;
  if (wybrana === undefined) return undefined;
  const ostrzezenie = pathWersjonowana && zPath !== wybrana
    ? (pl
      ? `Node z PATH zawiera numer wersji. Używam ${wybrana}.`
      : `The Node on PATH contains a version number. Using ${wybrana}.`)
    : undefined;
  return { sciezka: wybrana, ostrzezenie };
}

function xcodeDziala(): boolean {
  const polecenie = process.env.HERESTT_XCODE_SELECT !== undefined && process.env.HERESTT_XCODE_SELECT.length > 0
    ? process.env.HERESTT_XCODE_SELECT
    : 'xcode-select';
  try {
    execFileSync(polecenie, ['-p'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}


// ---------------------------------------------------------------------------
// Faza 2: zapis, dziennik, undo
// ---------------------------------------------------------------------------

const NAZWA_HOSTA = 'com.herestt.host';
const PLIK_MANIFESTU = `${NAZWA_HOSTA}.json`;
const STARY_MANIFEST = 'pl.tryb_uwag.host.json';
const OPIS_MANIFESTU = 'Tryb uwag — host native messaging';
const PLIKI_PROGRAMU = ['host.mjs', 'mcp.mjs', 'uruchom-host.sh', 'config.json'] as const;
const PATH_LAUNCHD = '/usr/bin:/bin:/usr/sbin:/sbin';

type RodzajKroku = 'plik' | 'manifest' | 'mcp' | 'dym';
type StanDziennika = 'zapis' | 'czesciowy' | 'cofniecie';

interface Krok {
  rodzaj: RodzajKroku;
  cel: string;
  ok: boolean;
  /** Skrót zapisanej treści (plik, manifest): `undo` nie kasuje pliku zmienionego po zapisie. */
  sha?: string;
}

interface Dziennik {
  wersja: 1;
  idWtyczki: string;
  wybor: { przegladarki: string[]; agenci: string[] };
  kroki: Krok[];
  stan: StanDziennika;
}

type OdczytDziennika = { rodzaj: 'brak' } | { rodzaj: 'zly' } | { rodzaj: 'ok'; dziennik: Dziennik };

interface Akcja {
  opis: string;
  /** Zwraca zdanie problemu albo undefined, gdy poszło dobrze. Wyjątek też jest problemem. */
  wykonaj: () => string | undefined;
}

function sha(tresc: Buffer | string): string {
  return createHash('sha256').update(tresc).digest('hex');
}

function komunikat(blad: unknown): string {
  return blad instanceof Error ? blad.message : String(blad);
}

/** Realpath najbliższego istniejącego przodka + reszta: profil, którego jeszcze nie ma, ma stałą ścieżkę. */
function realnaSciezka(sciezka: string): string {
  const abs = resolve(sciezka);
  try {
    return realpathSync(abs);
  } catch {
    const rodzic = dirname(abs);
    if (rodzic === abs) return abs;
    return join(realnaSciezka(rodzic), basename(abs));
  }
}

function jestSymlinkiem(sciezka: string): boolean {
  try {
    return lstatSync(sciezka).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Odmowa przed jakimkolwiek zapisem: katalog docelowy nie może być symlinkiem ani plikiem. */
function sprawdzKatalogDocelowy(katalog: string, pl: boolean): void {
  let opis;
  try {
    opis = lstatSync(katalog);
  } catch {
    return;
  }
  if (opis.isSymbolicLink()) {
    koniec(1, pl ? `${katalog} jest symlinkiem — odmawiam. Nic nie zapisano.` : `${katalog} is a symlink — refusing. Nothing was written.`);
  }
  if (!opis.isDirectory()) {
    koniec(1, pl ? `${katalog} istnieje i nie jest katalogiem. Nic nie zapisano.` : `${katalog} exists and is not a directory. Nothing was written.`);
  }
}

function zapiszAtomowo(cel: string, tresc: string | Buffer, tryb: number): void {
  const tymczasowy = `${cel}.tmp-${process.pid}`;
  try {
    writeFileSync(tymczasowy, tresc, { mode: tryb });
    chmodSync(tymczasowy, tryb);
    renameSync(tymczasowy, cel);
  } catch (blad) {
    try {
      rmSync(tymczasowy, { force: true });
    } catch {
      // nic więcej do zrobienia
    }
    throw blad;
  }
}

function odczytajDziennik(sciezka: string): OdczytDziennika {
  if (!istnieje(sciezka)) return { rodzaj: 'brak' };
  try {
    if (!lstatSync(sciezka).isFile()) return { rodzaj: 'zly' };
    const dane: unknown = JSON.parse(readFileSync(sciezka, 'utf8'));
    if (typeof dane !== 'object' || dane === null) return { rodzaj: 'zly' };
    const d = dane as Record<string, unknown>;
    const wybor = d.wybor as { przegladarki?: unknown; agenci?: unknown } | undefined;
    const listaTekstow = (x: unknown): x is string[] => Array.isArray(x) && x.every(el => typeof el === 'string');
    if (d.wersja !== 1 || typeof d.idWtyczki !== 'string') return { rodzaj: 'zly' };
    if (d.stan !== 'zapis' && d.stan !== 'czesciowy' && d.stan !== 'cofniecie') return { rodzaj: 'zly' };
    if (wybor === undefined || wybor === null || !listaTekstow(wybor.przegladarki) || !listaTekstow(wybor.agenci)) return { rodzaj: 'zly' };
    if (!Array.isArray(d.kroki)) return { rodzaj: 'zly' };
    const rodzaje = ['plik', 'manifest', 'mcp', 'dym'];
    for (const krok of d.kroki as unknown[]) {
      const k = krok as Partial<Krok> | null;
      if (k === null || typeof k !== 'object') return { rodzaj: 'zly' };
      if (typeof k.rodzaj !== 'string' || !rodzaje.includes(k.rodzaj) || typeof k.cel !== 'string' || typeof k.ok !== 'boolean') return { rodzaj: 'zly' };
      if (k.sha !== undefined && typeof k.sha !== 'string') return { rodzaj: 'zly' };
    }
    return { rodzaj: 'ok', dziennik: d as unknown as Dziennik };
  } catch {
    return { rodzaj: 'zly' };
  }
}

function zapiszDziennik(sciezka: string, dziennik: Dziennik): void {
  zapiszAtomowo(sciezka, `${JSON.stringify(dziennik, null, 2)}\n`, 0o600);
}

function ustawKrok(dziennik: Dziennik, krok: Krok): void {
  const indeks = dziennik.kroki.findIndex(k => k.rodzaj === krok.rodzaj && k.cel === krok.cel);
  if (indeks === -1) dziennik.kroki.push(krok);
  else dziennik.kroki[indeks] = krok;
}

function argumentyMcp(agent: IdAgenta, akcja: 'add' | 'remove', nazwa: string, node?: string, mcp?: string): string[] {
  if (agent === 'claude') {
    return akcja === 'add'
      ? ['mcp', 'add', '--scope', 'user', nazwa, '--', node ?? '', mcp ?? '']
      : ['mcp', 'remove', nazwa, '--scope', 'user'];
  }
  return akcja === 'add' ? ['mcp', 'add', nazwa, '--', node ?? '', mcp ?? ''] : ['mcp', 'remove', nazwa];
}

function uruchomCli(program: string, args: string[]): { ok: boolean; wyjscie: string } {
  const wynik = spawnSync(program, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const wyjscie = `${wynik.stdout ?? ''}${wynik.stderr ?? ''}`.trim().slice(0, 300);
  return { ok: wynik.status === 0 && wynik.error === undefined, wyjscie };
}

function sciezkaProgramu(agent: Agent): string | undefined {
  return naSciezce(agent.program, process.env.PATH ?? '');
}

function wykonajAkcje(akcje: Akcja[]): string[] {
  const problemy: string[] = [];
  for (const akcja of akcje) {
    try {
      const problem = akcja.wykonaj();
      if (problem === undefined) process.stdout.write(`  ${akcja.opis}\n`);
      else problemy.push(problem);
    } catch (blad) {
      problemy.push(`${akcja.opis}: ${komunikat(blad)}`);
    }
  }
  return problemy;
}

/** Usuwa plik albo sam wskaźnik symlinku (cel zostaje). Katalogu nie rusza. */
function usunWskaznikLubPlik(sciezka: string): 'usuniety' | 'brak' | 'katalog' {
  let opis;
  try {
    opis = lstatSync(sciezka);
  } catch {
    return 'brak';
  }
  if (opis.isDirectory()) return 'katalog';
  unlinkSync(sciezka);
  return 'usuniety';
}

function katalogStaregoKonfigu(home: string, profil: string | undefined): string {
  return profil === undefined ? join(home, '.config', 'tryb-uwag') : join(profil, 'tryb-uwag');
}

/**
 * Ślady starej nazwy (R17): wpis MCP `tryb-uwag`, manifesty `pl.tryb_uwag.host.json` w pięciu przeglądarkach,
 * zwykły katalog starego konfigu po jednorazowej kopii `mapowania.json`. Nic z tego `undo` nie przywraca.
 */
function zaplanujStareSlady(home: string, profil: string | undefined, konfig: string, pl: boolean): Akcja[] {
  const akcje: Akcja[] = [];
  for (const agent of process.env.HERESTT_BEZ_MCP === '1' ? [] : AGENCI) {
    const program = sciezkaProgramu(agent);
    if (program === undefined) continue;
    const args = argumentyMcp(agent.id, 'remove', 'tryb-uwag');
    akcje.push({
      opis: `${agent.program} ${args.join(' ')}`,
      wykonaj: () => {
        uruchomCli(program, args); // brak starego wpisu kończy się błędem CLI i to jest w porządku
        return undefined;
      },
    });
  }
  for (const przegladarka of PRZEGLADARKI) {
    const sciezka = sciezkaManifestu(home, profil, przegladarka, STARY_MANIFEST);
    if (!istnieje(sciezka)) continue;
    akcje.push({
      opis: sciezka,
      wykonaj: () => {
        if (jestSymlinkiem(dirname(sciezka))) return pl ? `${dirname(sciezka)} jest symlinkiem — nie ruszam ${sciezka}.` : `${dirname(sciezka)} is a symlink — leaving ${sciezka}.`;
        usunWskaznikLubPlik(sciezka);
        return undefined;
      },
    });
  }
  const stary = katalogStaregoKonfigu(home, profil);
  if (istnieje(stary)) {
    akcje.push({
      opis: stary,
      wykonaj: () => {
        if (jestSymlinkiem(stary)) {
          unlinkSync(stary); // znika sam wskaźnik, cel zostaje
          return undefined;
        }
        if (!katalogJest(stary)) return undefined;
        const nowa = join(konfig, 'mapowania.json');
        const starePlik = join(stary, 'mapowania.json');
        let plikZwykly = false;
        try {
          plikZwykly = lstatSync(starePlik).isFile();
        } catch {
          // brak starego pliku
        }
        if (plikZwykly && !istnieje(nowa)) {
          if (jestSymlinkiem(konfig)) return pl ? `${konfig} jest symlinkiem — zostawiam ${stary}.` : `${konfig} is a symlink — leaving ${stary}.`;
          mkdirSync(konfig, { recursive: true, mode: 0o700 });
          zapiszAtomowo(nowa, readFileSync(starePlik), 0o600);
        }
        rmSync(stary, { recursive: true, force: true });
        return undefined;
      },
    });
  }
  return akcje;
}

function liniaProsby(pl: boolean): string {
  return pl
    ? PROSBA_DO_AGENTA.pl
    : 'Start your agent in the project folder and ask it to wait for notes from the extension: loop notes_list, notes_read, notes_status, and call notes_wait when the list is empty.';
}

function zdanieCzesciowe(ile: number, ogolem: number, pl: boolean): string {
  return pl
    ? `Zapisano ${ile} z ${ogolem} zmian. undo cofnie je wszystkie`
    : `Saved ${ile} of ${ogolem} changes. undo will revert all of them.`;
}

function kolejkaLinii(rl: Interface): () => Promise<string | undefined> {
  const kolejka: string[] = [];
  let zamkniety = false;
  let czeka: ((linia: string | undefined) => void) | undefined;
  rl.on('line', linia => {
    if (czeka === undefined) {
      kolejka.push(linia);
      return;
    }
    const odbiorca = czeka;
    czeka = undefined;
    odbiorca(linia);
  });
  rl.on('close', () => {
    zamkniety = true;
    const odbiorca = czeka;
    czeka = undefined;
    odbiorca?.(undefined);
  });
  return () =>
    new Promise(resolvePromise => {
      const linia = kolejka.shift();
      if (linia !== undefined) resolvePromise(linia);
      else if (zamkniety) resolvePromise(undefined);
      else czeka = resolvePromise;
    });
}

interface KontekstZapisu {
  korzen: string;
  home: string;
  profil: string | undefined;
  id: string;
  pl: boolean;
  node: string;
  git: string;
  lsof: string;
  herdr: string | undefined;
  hc: string | undefined;
  konfig: string;
  przegladarki: Przegladarka[];
  agenci: Agent[];
}

function zapisz(ctx: KontekstZapisu): never {
  const { pl, konfig } = ctx;
  const sciezkaDziennika = join(konfig, 'instalacja.json');
  const hostZrodlo = join(ctx.korzen, 'dist', 'host', 'host.mjs');
  const mcpZrodlo = join(ctx.korzen, 'dist', 'mcp', 'mcp.mjs');
  if (!istnieje(hostZrodlo)) {
    koniec(1, pl ? 'Brak dist/host/host.mjs — uruchom npm run build.' : 'dist/host/host.mjs is missing — run npm run build.');
  }
  if (konfig.includes("'") || ctx.node.includes("'") || konfig.includes('\n') || ctx.node.includes('\n')) {
    koniec(1, pl ? 'Ścieżka instalacji albo Node zawiera niedozwolony znak (apostrof lub nowa linia).' : 'The install or Node path contains a forbidden character (apostrophe or newline).');
  }
  // Wszystkie odmowy przed pierwszym zapisem.
  sprawdzKatalogDocelowy(konfig, pl);
  for (const przegladarka of ctx.przegladarki) {
    sprawdzKatalogDocelowy(dirname(sciezkaManifestu(ctx.home, ctx.profil, przegladarka)), pl);
  }

  const zmian = ctx.przegladarki.length + ctx.agenci.length;
  let udane = 0;
  mkdirSync(konfig, { recursive: true, mode: 0o700 });
  chmodSync(konfig, 0o700);

  const odczyt = odczytajDziennik(sciezkaDziennika);
  if (odczyt.rodzaj === 'zly') {
    process.stdout.write(`${pl ? 'Uwaga: stary dziennik instalacja.json jest uszkodzony. Zakładam nowy.' : 'Note: the old instalacja.json journal is damaged. Starting a new one.'}\n`);
  }
  const dziennik: Dziennik = {
    wersja: 1,
    idWtyczki: ctx.id,
    wybor: { przegladarki: ctx.przegladarki.map(p => p.id), agenci: ctx.agenci.map(a => a.id) },
    kroki: odczyt.rodzaj === 'ok' ? odczyt.dziennik.kroki.filter(k => k.ok && k.rodzaj !== 'dym') : [],
    stan: 'zapis',
  };

  // Faza 3: zapis jest stanem docelowym. Przeglądarki i agenci spoza nowego wyboru schodzą (sha chroni zmienione pliki).
  for (const krok of [...dziennik.kroki]) {
    const wybrany = krok.rodzaj === 'manifest'
      ? ctx.przegladarki.some(p => sciezkaManifestu(ctx.home, ctx.profil, p) === krok.cel)
      : krok.rodzaj === 'mcp' ? ctx.agenci.some(a => a.id === krok.cel) : true;
    if (wybrany) continue;
    let zdjety = false;
    if (krok.rodzaj === 'mcp') {
      const agent = AGENCI.find(a => a.id === krok.cel);
      const program = agent === undefined ? undefined : sciezkaProgramu(agent);
      if (agent !== undefined && program !== undefined) {
        uruchomCli(program, argumentyMcp(agent.id, 'remove', 'herestt'));
        zdjety = true;
      }
    } else if (celDozwolony(krok, konfig) && !jestSymlinkiem(dirname(krok.cel)) && !jestSymlinkiem(krok.cel)) {
      try {
        if (!istnieje(krok.cel)) zdjety = true;
        else if (krok.sha === undefined || sha(readFileSync(krok.cel)) === krok.sha) {
          unlinkSync(krok.cel);
          zdjety = true;
        }
      } catch {
        // zostaje w dzienniku
      }
    }
    if (zdjety) dziennik.kroki = dziennik.kroki.filter(k => k !== krok);
    else process.stdout.write(`${pl ? 'Uwaga: nie zdjąłem' : 'Note: could not remove'} ${krok.cel}\n`);
  }

  const przerwij = (opis: string): never => {
    dziennik.stan = 'czesciowy';
    try {
      zapiszDziennik(sciezkaDziennika, dziennik);
    } catch {
      // dziennik nie powstał: nic więcej nie da się zapisać
    }
    process.stdout.write(`${opis}\n${zdanieCzesciowe(udane, zmian, pl)}\n`);
    process.exit(1);
  };
  const krokOk = (krok: Krok): void => {
    ustawKrok(dziennik, krok);
    try {
      zapiszDziennik(sciezkaDziennika, dziennik);
    } catch (blad) {
      przerwij(pl ? `Nie udało się zapisać dziennika: ${komunikat(blad)}` : `Could not write the journal: ${komunikat(blad)}`);
    }
  };
  const krokBlad = (krok: Krok, opis: string): never => {
    ustawKrok(dziennik, { ...krok, ok: false });
    return przerwij(opis);
  };
  try {
    zapiszDziennik(sciezkaDziennika, dziennik);
  } catch (blad) {
    koniec(1, pl ? `Nie udało się zapisać dziennika: ${komunikat(blad)}` : `Could not write the journal: ${komunikat(blad)}`);
  }

  // 1. Pliki programu. Kopia mapowań (i zdjęcie starego katalogu) idzie dopiero po całym zapisie.
  const launcher = join(konfig, 'uruchom-host.sh');
  const binarki: Record<string, string> = { git: ctx.git, lsof: ctx.lsof };
  if (ctx.herdr !== undefined) binarki.herdr = ctx.herdr;
  if (ctx.hc !== undefined) binarki.hc = ctx.hc;
  const pliki: Array<{ nazwa: (typeof PLIKI_PROGRAMU)[number]; tresc: Buffer | string; tryb: number }> = [
    { nazwa: 'host.mjs', tresc: readFileSync(hostZrodlo), tryb: 0o600 },
  ];
  if (istnieje(mcpZrodlo)) pliki.push({ nazwa: 'mcp.mjs', tresc: readFileSync(mcpZrodlo), tryb: 0o600 });
  pliki.push(
    {
      nazwa: 'config.json',
      tresc: `${JSON.stringify({ wersja: 1, idWtyczki: ctx.id, binarki }, null, 2)}\n`,
      tryb: 0o600,
    },
    {
      nazwa: 'uruchom-host.sh',
      tresc: `#!/bin/sh\n# Wygenerowane przez heresthething — nie edytuj; uruchom instalator ponownie.\nexec '${ctx.node}' '${join(konfig, 'host.mjs')}' "$@"\n`,
      tryb: 0o700,
    },
  );
  for (const plik of pliki) {
    const cel = join(konfig, plik.nazwa);
    const krok: Krok = { rodzaj: 'plik', cel, ok: true, sha: sha(plik.tresc) };
    try {
      zapiszAtomowo(cel, plik.tresc, plik.tryb);
    } catch (blad) {
      krokBlad(krok, pl ? `Nie udało się zapisać ${cel}: ${komunikat(blad)}` : `Could not write ${cel}: ${komunikat(blad)}`);
    }
    krokOk(krok);
  }

  // 2. Manifesty: jeden origin, ten sam id co w config.json.
  for (const przegladarka of ctx.przegladarki) {
    const cel = sciezkaManifestu(ctx.home, ctx.profil, przegladarka);
    const manifest = `${JSON.stringify({
      name: NAZWA_HOSTA,
      description: OPIS_MANIFESTU,
      path: launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${ctx.id}/`],
    }, null, 2)}\n`;
    const krok: Krok = { rodzaj: 'manifest', cel, ok: true, sha: sha(manifest) };
    try {
      mkdirSync(dirname(cel), { recursive: true });
      zapiszAtomowo(cel, manifest, 0o644);
    } catch (blad) {
      krokBlad(krok, pl ? `Nie udało się zapisać manifestu ${przegladarka.nazwa}: ${komunikat(blad)}` : `Could not write the ${przegladarka.nazwa} manifest: ${komunikat(blad)}`);
    }
    krokOk(krok);
    udane += 1;
  }

  // 3. Agenci przez ich CLI.
  const mcpMjs = join(konfig, 'mcp.mjs');
  for (const agent of ctx.agenci) {
    const krok: Krok = { rodzaj: 'mcp', cel: agent.id, ok: true };
    const program = sciezkaProgramu(agent);
    if (program === undefined) {
      krokBlad(krok, pl ? `${agent.nazwa}: program ${agent.program} zniknął z PATH.` : `${agent.nazwa}: ${agent.program} is no longer on PATH.`);
      continue;
    }
    uruchomCli(program, argumentyMcp(agent.id, 'remove', 'herestt')); // idempotencja: brak wpisu to nie błąd
    const dodanie = uruchomCli(program, argumentyMcp(agent.id, 'add', 'herestt', ctx.node, mcpMjs));
    if (!dodanie.ok) {
      krokBlad(krok, pl ? `${agent.nazwa}: polecenie mcp add nie przeszło${dodanie.wyjscie === '' ? '.' : `: ${dodanie.wyjscie}`}` : `${agent.nazwa}: mcp add failed${dodanie.wyjscie === '' ? '.' : `: ${dodanie.wyjscie}`}`);
    }
    krokOk(krok);
    udane += 1;
  }

  // 4. Ślady starej nazwy. Porażka tu nie cofa zapisu.
  const sprzatanie = zaplanujStareSlady(ctx.home, ctx.profil, konfig, pl);
  if (sprzatanie.length > 0) {
    process.stdout.write(`${pl ? 'Zdejmuję ślady starej nazwy tryb-uwag:' : 'Removing traces of the old tryb-uwag name:'}\n`);
    for (const problem of wykonajAkcje(sprzatanie)) process.stdout.write(`${pl ? 'Uwaga' : 'Note'}: ${problem}\n`);
  }

  // 5. Dym z PATH launchd.
  const dymKrok: Krok = { rodzaj: 'dym', cel: 'sprawdz-instalacje', ok: true };
  try {
    const wyjscie = execFileSync(ctx.node, [join(ctx.korzen, 'host', 'sprawdz-instalacje.mjs'), launcher, ctx.id], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: PATH_LAUNCHD },
    });
    process.stdout.write(wyjscie);
  } catch (blad) {
    const b = blad as { stderr?: unknown };
    const szczegoly = typeof b.stderr === 'string' ? b.stderr.trim() : '';
    ustawKrok(dziennik, { ...dymKrok, ok: false });
    dziennik.stan = 'czesciowy';
    try {
      zapiszDziennik(sciezkaDziennika, dziennik);
    } catch {
      // dziennik już istnieje z poprzedniego kroku
    }
    process.stdout.write(`${pl ? `Test dymny hosta nie przeszedł (szczegóły: ${join(konfig, 'host.log')}).` : `The host smoke test failed (details: ${join(konfig, 'host.log')}).`}${szczegoly === '' ? '' : `\n${szczegoly}`}\n`);
    process.stdout.write(`${zdanieCzesciowe(udane, zmian, pl)}\n`);
    process.exit(1);
  }
  ustawKrok(dziennik, dymKrok);
  dziennik.stan = 'zapis';
  try {
    zapiszDziennik(sciezkaDziennika, dziennik);
  } catch (blad) {
    koniec(1, pl ? `Nie udało się zapisać dziennika: ${komunikat(blad)}` : `Could not write the journal: ${komunikat(blad)}`);
  }

  const wersja = wersjaPaczki(ctx.korzen);
  process.stdout.write(`${pl ? 'Połączono.' : 'Connected.'}\n`);
  process.stdout.write(`${pl ? 'Cofnięcie' : 'Undo'}: npx heresthething@${wersja} undo\n`);
  if (process.env.HERESTT_BEZ_PROSBY !== '1') process.stdout.write(`\n${liniaProsby(pl)}\n`);
  process.exit(0);
}

function wersjaPaczki(korzen: string): string {
  const paczka = JSON.parse(readFileSync(join(korzen, 'package.json'), 'utf8')) as { version?: unknown };
  return typeof paczka.version === 'string' ? paczka.version : '';
}

function celDozwolony(krok: Krok, konfig: string): boolean {
  if (krok.rodzaj === 'plik') {
    return dirname(krok.cel) === konfig && (PLIKI_PROGRAMU as readonly string[]).includes(basename(krok.cel));
  }
  return basename(krok.cel) === PLIK_MANIFESTU && basename(dirname(krok.cel)) === 'NativeMessagingHosts';
}

function cofnij(opcje: Opcje, home: string, pl: boolean): never {
  const konfig = katalogKonfigu(home, opcje.profil);
  const sciezkaDziennika = join(konfig, 'instalacja.json');
  if (jestSymlinkiem(konfig)) {
    koniec(1, pl ? `${konfig} jest symlinkiem — odmawiam. Nic nie usunięto.` : `${konfig} is a symlink — refusing. Nothing was removed.`);
  }
  const odczyt = odczytajDziennik(sciezkaDziennika);
  const wstep: string[] = [];
  if (odczyt.rodzaj === 'zly') {
    wstep.push(pl
      ? 'Dziennik instalacja.json jest uszkodzony, więc cofam tylko zestaw podstawowy (Chrome i pliki programu). Dziennik zostaje; undo --all go skasuje.'
      : 'The instalacja.json journal is damaged, so I only revert the basic set (Chrome and program files). The journal stays; undo --all removes it.');
  }
  const akcje: Akcja[] = [];
  const pozostale: Krok[] = [];

  const sciezkiPlikow: Array<{ cel: string; sha?: string | undefined }> = [];
  const mcpDoZdjecia: IdAgenta[] = [];
  if (odczyt.rodzaj === 'ok') {
    for (const krok of odczyt.dziennik.kroki) {
      if (!krok.ok || krok.rodzaj === 'dym') continue;
      if (krok.rodzaj === 'mcp') {
        if (znanyAgent(krok.cel)) mcpDoZdjecia.push(krok.cel);
        continue;
      }
      if (!celDozwolony(krok, konfig)) {
        wstep.push(pl ? `Pomijam wpis dziennika spoza naszych miejsc: ${krok.cel}` : `Skipping a journal entry outside our locations: ${krok.cel}`);
        continue;
      }
      sciezkiPlikow.push({ cel: krok.cel, sha: krok.sha });
    }
  } else {
    sciezkiPlikow.push({ cel: sciezkaManifestu(home, opcje.profil, PRZEGLADARKI[0]) });
    for (const nazwa of PLIKI_PROGRAMU) sciezkiPlikow.push({ cel: join(konfig, nazwa) });
    for (const agent of AGENCI) mcpDoZdjecia.push(agent.id);
  }

  // Symlink na drodze: odmowa przed pierwszym usunięciem.
  for (const wpis of sciezkiPlikow) {
    const rodzic = dirname(wpis.cel);
    if (jestSymlinkiem(rodzic) || jestSymlinkiem(wpis.cel)) {
      const winny = jestSymlinkiem(rodzic) ? rodzic : wpis.cel;
      koniec(1, pl ? `${winny} jest symlinkiem — odmawiam. Nic nie usunięto.` : `${winny} is a symlink — refusing. Nothing was removed.`);
    }
  }

  for (const wpis of sciezkiPlikow) {
    akcje.push({
      opis: wpis.cel,
      wykonaj: () => {
        if (!istnieje(wpis.cel)) return undefined;
        if (!lstatSync(wpis.cel).isFile()) return pl ? `${wpis.cel} nie jest plikiem — zostawiam. Usuń go ręcznie.` : `${wpis.cel} is not a file — leaving it. Remove it by hand.`;
        if (wpis.sha !== undefined && sha(readFileSync(wpis.cel)) !== wpis.sha) {
          pozostale.push({ rodzaj: wpis.cel.endsWith(PLIK_MANIFESTU) ? 'manifest' : 'plik', cel: wpis.cel, ok: true, sha: wpis.sha });
          return pl
            ? `${wpis.cel} zmieniono po zapisie — zostawiam. Jeśli ma zniknąć, usuń go ręcznie i powtórz undo.`
            : `${wpis.cel} was changed after the install — leaving it. Remove it by hand if you want it gone, then run undo again.`;
        }
        unlinkSync(wpis.cel);
        return undefined;
      },
    });
  }
  for (const idAgenta of mcpDoZdjecia) {
    const agent = AGENCI.find(kandydat => kandydat.id === idAgenta);
    if (agent === undefined) continue;
    const args = argumentyMcp(agent.id, 'remove', 'herestt');
    const polecenie = `${agent.program} ${args.join(' ')}`;
    akcje.push({
      opis: polecenie,
      wykonaj: () => {
        const program = sciezkaProgramu(agent);
        if (program === undefined) {
          if (odczyt.rodzaj !== 'ok') return undefined; // bez dziennika nic nie wskazuje, że ten agent miał nasz wpis
          pozostale.push({ rodzaj: 'mcp', cel: agent.id, ok: true });
          return pl ? `Nie ma ${agent.program} na PATH. Usuń wpis ręcznie: ${polecenie}` : `${agent.program} is not on PATH. Remove the entry by hand: ${polecenie}`;
        }
        const wynik = uruchomCli(program, args);
        if (!wynik.ok) process.stdout.write(`  ${pl ? `${polecenie} nie przeszło (może wpisu już nie ma)` : `${polecenie} failed (the entry may already be gone)`}\n`);
        return undefined;
      },
    });
  }
  if (odczyt.rodzaj !== 'ok') akcje.push(...zaplanujStareSlady(home, opcje.profil, konfig, pl));

  if (opcje.dryRun) {
    const linie = [...wstep, pl ? 'Podgląd cofnięcia, nic nie zostanie usunięte:' : 'Undo preview, nothing will be removed:', ...akcje.map(a => a.opis)];
    if (opcje.all) {
      linie.push(...['mapowania.json', 'host.log', 'host.log.1', 'instalacja.json'].map(n => join(konfig, n)));
    }
    koniec(0, linie.join('\n'));
  }

  for (const linia of wstep) process.stdout.write(`${linia}\n`);
  process.stdout.write(`${pl ? 'Cofam zapis:' : 'Reverting the install:'}\n`);
  const problemy = wykonajAkcje(akcje);

  if (opcje.all) {
    for (const nazwa of ['mapowania.json', 'host.log', 'host.log.1']) {
      try {
        usunWskaznikLubPlik(join(konfig, nazwa));
      } catch (blad) {
        problemy.push(`${join(konfig, nazwa)}: ${komunikat(blad)}`);
      }
    }
    if (odczyt.rodzaj !== 'ok' || problemy.length === 0) {
      try {
        usunWskaznikLubPlik(sciezkaDziennika);
      } catch (blad) {
        problemy.push(`${sciezkaDziennika}: ${komunikat(blad)}`);
      }
    }
    try {
      rmdirSync(konfig);
    } catch {
      // niepusty albo nieistniejący: zostaje
    }
  } else if (odczyt.rodzaj === 'ok') {
    const dziennik = odczyt.dziennik;
    dziennik.stan = 'cofniecie';
    dziennik.kroki = pozostale;
    try {
      zapiszDziennik(sciezkaDziennika, dziennik);
    } catch (blad) {
      problemy.push(`${sciezkaDziennika}: ${komunikat(blad)}`);
    }
  }

  if (problemy.length > 0) {
    process.stdout.write(`${pl ? 'Cofnięto częściowo. Do zrobienia ręcznie:' : 'Reverted only partly. To do by hand:'}\n`);
    for (const problem of problemy) process.stdout.write(`- ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(`${pl ? 'Cofnięto. Uwagi w projektach zostają.' : 'Reverted. Notes in your projects stay.'}\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  const pl = polskiJezyk();
  const opcje = parsuj(process.argv.slice(2), pl);
  const home = process.env.HOME !== undefined && process.env.HOME.length > 0 ? process.env.HOME : homedir();
  if (opcje.profil !== undefined) opcje.profil = realnaSciezka(opcje.profil);
  const platforma = process.env.HERESTT_PLATFORM !== undefined && process.env.HERESTT_PLATFORM.length > 0
    ? process.env.HERESTT_PLATFORM
    : process.platform;
  const naMacOS = (): void => {
    if (platforma !== 'darwin') {
      koniec(0, pl
        ? 'Połączenie z agentem działa na razie tylko na macOS. Czat działa wszędzie.'
        : 'Connection to an agent works on macOS for now. Chat works everywhere.');
    }
  };
  if (opcje.doctor) {
    naMacOS();
    uruchomDoctor({
      pl,
      home,
      profil: opcje.profil,
      wersja: (() => {
        try {
          return wersjaPaczki(korzenRepo());
        } catch {
          return '';
        }
      })(),
      platforma,
      narzedzia: { naSciezce, wybierzNode, xcodeDziala, odczytajDziennik, katalogKonfigu, przegladarki: PRZEGLADARKI, agenci: AGENCI, aplikacjaJest, maWtyczke, sciezkaManifestu, katalogStaregoKonfigu },
    });
  }
  if (opcje.undo) {
    naMacOS();
    cofnij(opcje, home, pl);
  }
  const korzen = korzenRepo();
  const id = czytajId(korzen, opcje.id, pl);
  naMacOS();

  const node = wybierzNode(pl);
  if (node === undefined) {
    koniec(1, pl ? 'Nie znaleziono Node w wersji 22 albo nowszej.' : 'Node 22 or newer was not found.');
  }
  // Nieudane xcode-select: nie szukamy gita i go nie uruchamiamy (zaślepka Apple otwiera okno).
  if (!xcodeDziala()) {
    koniec(1, pl
      ? 'Brak narzędzi wiersza poleceń Apple (xcode-select -p się nie udało).'
      : 'Apple command line tools are missing (xcode-select -p failed).');
  }
  const git = naSciezce('git', process.env.PATH ?? '');
  if (git === undefined) koniec(1, pl ? 'Nie znaleziono gita.' : 'Git was not found.');
  try {
    execFileSync(git, ['--version'], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    koniec(1, pl ? 'Git nie działa.' : 'Git does not run.');
  }
  const lsof = naSciezce('lsof', `${process.env.PATH ?? ''}:/usr/sbin:/usr/bin`);
  if (lsof === undefined) koniec(1, pl ? 'Nie znaleziono lsof.' : 'lsof was not found.');

  // Stare skrypty (install.sh, polacz.sh) instalują Chrome także wtedy, gdy nie ma go w /Applications (profil testowy).
  const wymus = process.env.HERESTT_WYMUS_PRZEGLADARKI === '1';
  const wykryte = PRZEGLADARKI.filter(przegladarka => aplikacjaJest(przegladarka, home));
  const zWtyczka = wykryte.filter(przegladarka => maWtyczke(home, przegladarka, id) === true);
  const znalezioneAgenty = AGENCI.filter(agent => sciezkaProgramu(agent) !== undefined);
  // Faza 3: poprzedni zapis (dziennik bez cofnięcia) wyznacza domyślny wybór i różnicę w podglądzie.
  const poprzedni = odczytajDziennik(join(katalogKonfigu(home, opcje.profil), 'instalacja.json'));
  const wczesniej = poprzedni.rodzaj === 'ok' && poprzedni.dziennik.stan !== 'cofniecie' ? poprzedni.dziennik.wybor : undefined;
  const domyslnePrzegladarki = wczesniej === undefined
    ? (zWtyczka.length > 0 ? zWtyczka : wykryte)
    : wykryte.filter(przegladarka => wczesniej.przegladarki.includes(przegladarka.id));
  const domyslniAgenci = wczesniej === undefined
    ? znalezioneAgenty
    : znalezioneAgenty.filter(agent => wczesniej.agenci.includes(agent.id));
  const brakujacyAgenci = AGENCI.filter(agent => !znalezioneAgenty.includes(agent));

  if (opcje.yes && opcje.browsers === undefined && opcje.agents === undefined) {
    koniec(1, pl ? 'Flaga --yes wymaga --browsers albo --agents.' : '--yes needs --browsers or --agents.');
  }
  if (opcje.browsers !== undefined && !wymus) {
    for (const idPrzegladarki of opcje.browsers) {
      const przegladarka = PRZEGLADARKI.find(kandydat => kandydat.id === idPrzegladarki);
      if (przegladarka === undefined || !wykryte.includes(przegladarka)) {
        const nazwa = przegladarka?.nazwa ?? idPrzegladarki;
        koniec(1, pl ? `Nie znaleziono przeglądarki ${nazwa}.` : `Browser ${nazwa} was not found.`);
      }
    }
  }
  if (opcje.agents !== undefined) {
    for (const idAgenta of opcje.agents) {
      const agent = AGENCI.find(kandydat => kandydat.id === idAgenta);
      if (agent === undefined || !znalezioneAgenty.includes(agent)) {
        const nazwa = agent?.nazwa ?? idAgenta;
        koniec(1, pl ? `Nie znaleziono ${nazwa}.` : `${nazwa} was not found.`);
      }
    }
  }

  const lista = (ids: IdPrzegladarki[]): Przegladarka[] =>
    PRZEGLADARKI.filter(przegladarka => ids.includes(przegladarka.id) && (wymus || wykryte.includes(przegladarka)));
  let wybranePrzegladarki: Przegladarka[] = opcje.browsers === undefined ? [...domyslnePrzegladarki] : lista(opcje.browsers);
  let wybraniAgenci: Agent[] = opcje.agents === undefined
    ? [...domyslniAgenci]
    : znalezioneAgenty.filter(agent => opcje.agents?.includes(agent.id));

  const wersja = wersjaPaczki(korzen);
  const linie: string[] = [`heresthething ${wersja}`, ''];
  if (!opcje.yes) {
    linie.push(pl ? 'Nic nie zostanie zapisane, dopóki nie potwierdzisz' : 'Nothing will be written until you confirm', '');
  }
  linie.push(`node: ${node.sciezka}`);
  if (node.ostrzezenie !== undefined) linie.push(node.ostrzezenie);
  linie.push(`git: ${git}`, `lsof: ${lsof}`);
  const herdr = naSciezce('herdr', process.env.PATH ?? '');
  const hc = naSciezce('hc', process.env.PATH ?? '');
  const brak = pl ? 'brak' : 'missing';
  linie.push(`herdr: ${herdr ?? brak}`, `hc: ${hc ?? brak}`);
  for (const przegladarka of wykryte) linie.push(liniaPrzegladarki(przegladarka, pl));
  for (const agent of znalezioneAgenty) linie.push(`agent: ${agent.nazwa}`);
  for (const agent of brakujacyAgenci) linie.push(zdanieBrakuAgenta(agent, pl));

  const pytac = tty() && !opcje.dryRun && !opcje.yes;
  let rl: Interface | undefined;
  let czytaj: (() => Promise<string | undefined>) | undefined;
  if (pytac) {
    process.stdout.write(`${linie.join('\n')}\n`);
    linie.length = 0;
    rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
    czytaj = kolejkaLinii(rl);
  }
  let zapisac = opcje.yes && !opcje.dryRun;
  try {
    if (pytac && czytaj !== undefined) {
      const zlyWybor = (zdanie: string): never => {
        rl?.close();
        koniec(1, zdanie);
      };
      if (opcje.browsers === undefined && wykryte.length > 0) {
        const naglowek = pl
          ? 'Przeglądarki — numery (1,2) albo Enter, żeby zostawić domyślne:'
          : 'Browsers — numbers (1,2) or Enter to keep the defaults:';
        process.stdout.write(`${naglowek}\n`);
        wykryte.forEach((przegladarka, indeks) => {
          const domyslna = domyslnePrzegladarki.includes(przegladarka);
          const znacznik = domyslna ? (pl ? ' — domyślna' : ' — default') : '';
          const dopisek = przegladarka.sprawdzona ? '' : (pl ? ' (niesprawdzone)' : ' (not verified here)');
          process.stdout.write(`${indeks + 1}. ${przegladarka.nazwa}${dopisek}${znacznik}\n`);
        });
        const wybor = parsujNumery((await czytaj()) ?? '', wykryte.length);
        const zdanieWyboru = pl ? 'Nie rozumiem wyboru przeglądarek.' : 'I do not understand the browser choice.';
        if (Array.isArray(wybor)) {
          const wskazane: Przegladarka[] = [];
          for (const numer of wybor) {
            const przegladarka = wykryte[numer - 1];
            if (przegladarka === undefined) zlyWybor(zdanieWyboru);
            else wskazane.push(przegladarka);
          }
          wybranePrzegladarki = wskazane;
        } else if (wybor === 'zle') {
          zlyWybor(zdanieWyboru);
        }
      }
      if (opcje.agents === undefined && znalezioneAgenty.length > 0) {
        const zostaw: Agent[] = [];
        for (const agent of znalezioneAgenty) {
          const domyslnie = domyslniAgenci.includes(agent);
          const pytanie = domyslnie
            ? (pl ? `${agent.nazwa}? [Enter = tak, n = nie]` : `${agent.nazwa}? [Enter = yes, n = no]`)
            : (pl ? `${agent.nazwa}? [Enter = nie, t = tak]` : `${agent.nazwa}? [Enter = no, y = yes]`);
          process.stdout.write(`${pytanie}\n`);
          const odpowiedz = ((await czytaj()) ?? '').trim();
          if (domyslnie) {
            if (odpowiedz === '') zostaw.push(agent);
            else if (odpowiedz === 'n' || odpowiedz === 'N') continue;
            else zlyWybor(pl ? 'Nie rozumiem odpowiedzi. Wpisz Enter albo n.' : 'I do not understand the answer. Press Enter or n.');
          } else if (odpowiedz === '' || odpowiedz === 'n' || odpowiedz === 'N') continue;
          else if (['t', 'T', 'y', 'Y'].includes(odpowiedz)) zostaw.push(agent);
          else zlyWybor(pl ? 'Nie rozumiem odpowiedzi. Wpisz Enter albo t.' : 'I do not understand the answer. Press Enter or y.');
        }
        wybraniAgenci = zostaw;
      }
    }

    const konfig = katalogKonfigu(home, opcje.profil);
    if (opcje.profil === undefined) linie.push('', '~/.config/herestt');
    linie.push(konfig);
    for (const plik of PLIKI_PROGRAMU) linie.push(join(konfig, plik));
    for (const przegladarka of wybranePrzegladarki) linie.push(sciezkaManifestu(home, opcje.profil, przegladarka));
    linie.push(`chrome-extension://${id}/`);
    const mcp = join(konfig, 'mcp.mjs');
    for (const agent of wybraniAgenci) {
      if (agent.id === 'claude') linie.push(`claude mcp add --scope user herestt -- ${node.sciezka} ${mcp}`);
      else linie.push(`codex mcp add herestt -- ${node.sciezka} ${mcp}`);
    }
    if (wczesniej !== undefined) {
      const dopisz = [
        ...wybranePrzegladarki.filter(p => !wczesniej.przegladarki.includes(p.id)).map(p => `${p.nazwa}: ${sciezkaManifestu(home, opcje.profil, p)}`),
        ...wybraniAgenci.filter(a => !wczesniej.agenci.includes(a.id)).map(a => a.nazwa),
      ];
      const zdejmij = [
        ...PRZEGLADARKI.filter(p => wczesniej.przegladarki.includes(p.id) && !wybranePrzegladarki.includes(p)).map(p => `${p.nazwa}: ${sciezkaManifestu(home, opcje.profil, p)}`),
        ...AGENCI.filter(a => wczesniej.agenci.includes(a.id) && !wybraniAgenci.includes(a)).map(a => a.nazwa),
      ];
      linie.push('', pl ? `Poprzedni zapis: przeglądarki ${wczesniej.przegladarki.join(', ') || '—'}; agenci ${wczesniej.agenci.join(', ') || '—'}` : `Previous install: browsers ${wczesniej.przegladarki.join(', ') || '—'}; agents ${wczesniej.agenci.join(', ') || '—'}`);
      linie.push(pl ? 'Dopisujemy:' : 'Adding:', ...(dopisz.length > 0 ? dopisz.map(x => `+ ${x}`) : ['—']));
      linie.push(pl ? 'Zdejmujemy:' : 'Removing:', ...(zdejmij.length > 0 ? zdejmij.map(x => `- ${x}`) : ['—']));
    }
    const stare = zaplanujStareSlady(home, opcje.profil, konfig, pl);
    if (stare.length > 0) {
      linie.push('', pl ? 'Zdejmiemy ślady starej nazwy tryb-uwag:' : 'We will remove traces of the old tryb-uwag name:');
      for (const akcja of stare) linie.push(akcja.opis);
    }
    linie.push('', pl
      ? 'Nie zmieniamy: ustawień przeglądarki, innych wpisów agentów, plików projektów'
      : 'We do not change: browser settings, other agent entries, project files');

    if (pytac && czytaj !== undefined) {
      linie.push(pl ? 'Zapisać te zmiany? [Enter = zapisz, n = anuluj]' : 'Write these changes? [Enter = write, n = cancel]');
      process.stdout.write(`${linie.join('\n')}\n`);
      linie.length = 0;
      const odpowiedz = await czytaj();
      if (odpowiedz === undefined) {
        // koniec wejścia to nie zgoda
        koniec(0, pl ? 'Brak odpowiedzi. Nic nie zapisano.' : 'No answer. Nothing was written.');
      }
      const tresc = odpowiedz.trim();
      if (tresc === '') zapisac = true;
      else if (tresc === 'n' || tresc === 'N') koniec(0, pl ? 'Anulowano. Nic nie zapisano.' : 'Cancelled. Nothing was written.');
      else koniec(1, pl ? 'Nie rozumiem odpowiedzi. Nic nie zapisano.' : 'I do not understand the answer. Nothing was written.');
    } else if (!zapisac) {
      if (opcje.dryRun) linie.push(pl ? 'Podgląd (--dry-run). Nic nie zapisano.' : 'Preview (--dry-run). Nothing was written.');
      else linie.push(pl ? 'Bez terminala nie pytam o zapis. Nic nie zapisano; dodaj --yes z --browsers i --agents.' : 'Without a terminal I do not ask. Nothing was written; add --yes with --browsers and --agents.');
      process.stdout.write(`${linie.join('\n')}\n`);
      process.exit(0);
    } else {
      process.stdout.write(`${linie.join('\n')}\n`);
    }
  } finally {
    rl?.close();
  }

  zapisz({
    korzen,
    home,
    profil: opcje.profil,
    id,
    pl,
    node: node.sciezka,
    git,
    lsof,
    herdr,
    hc,
    konfig: katalogKonfigu(home, opcje.profil),
    przegladarki: wybranePrzegladarki,
    agenci: wybraniAgenci,
  });
}

await main();
