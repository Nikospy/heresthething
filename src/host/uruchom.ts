import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { BladHosta } from './bledy';
import type { Binarki } from './konfiguracja';

/**
 * Jedyne miejsce w hoście, które uruchamia procesy. Zamiast ogólnego
 * `uruchom(narzedzie, args)` eksportujemy tylko konkretne komendy z BRIEF §5,
 * więc lista dozwolonych wywołań wynika z kodu, a nie z dyscypliny.
 *
 * Zawsze: absolutna ścieżka z konfiguracji, `execFile` (bez powłoki), czyste
 * env. Chrome uruchomiony z panelu herdr przekazuje hostowi `HERDR_*`,
 * a z dowolnej powłoki mógłby przekazać `GIT_DIR`/`GIT_CONFIG_*` (host.md §1.3,
 * red-team §14) — nic z tego nie dociera do dzieci.
 */

export type WynikProcesu = { kodWyjscia: number; stdout: string; stderr: string };

const LIMIT_WYJSCIA = 4 * 1024 * 1024;
const LIMIT_CZASU_MS = 5000;

function czysteEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    // Z bazy użytkowników, nie z env — podmieniony HOME mógłby wskazać cudzy .gitconfig.
    HOME: userInfo().homedir,
    LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function wykonaj(binarka: string, args: string[], limitCzasuMs: number = LIMIT_CZASU_MS): Promise<WynikProcesu> {
  return new Promise((resolve, reject) => {
    execFile(
      binarka,
      args,
      { env: czysteEnv(), timeout: limitCzasuMs, maxBuffer: LIMIT_WYJSCIA, encoding: 'utf8', shell: false, cwd: '/' },
      (blad, stdout, stderr) => {
        if (blad === null) return resolve({ kodWyjscia: 0, stdout, stderr });
        const kod = (blad as NodeJS.ErrnoException).code;
        if (typeof kod === 'number') return resolve({ kodWyjscia: kod, stdout, stderr });
        if (blad.killed) return reject(new BladHosta('wewnetrzny', `${binarka}: przekroczony czas ${limitCzasuMs} ms`));
        if (kod === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new BladHosta('wewnetrzny', `${binarka}: wyjście > ${LIMIT_WYJSCIA} B`));
        // ENOENT/EACCES przy starcie = binarka zniknęła od instalacji.
        reject(new BladHosta('konfiguracja', `${binarka}: nie da się uruchomić (${String(kod)}) — uruchom ponownie install.sh`));
      },
    );
  });
}

// --- git (tylko odczyt) ---

/** `git rev-parse --show-toplevel`; null, gdy katalog nie jest w repo. */
export async function gitToplevel(b: Binarki, katalog: string): Promise<string | null> {
  const w = await wykonaj(b.git, ['-C', katalog, 'rev-parse', '--show-toplevel']);
  return w.kodWyjscia === 0 ? w.stdout.replace(/\n$/, '') : null;
}

/** `git check-ignore -q`; kod 0 = ignorowane, 1 = nie, inne = nie wiemy (traktujemy jak „nie”). */
export async function gitCzyIgnorowane(b: Binarki, projekt: string, sciezkaWzgledna: string): Promise<boolean> {
  const w = await wykonaj(b.git, ['-C', projekt, 'check-ignore', '-q', '--', sciezkaWzgledna]);
  return w.kodWyjscia === 0;
}

// --- okno wyboru folderu (macOS) ---

/** Systemowe `osascript`, gdy konfiguracja nie podaje innego. */
export const OSASCRIPT_SYSTEMOWY = '/usr/bin/osascript';

/**
 * Okno „Wybierz folder”. Tekst nad oknem idzie jako argument skryptu
 * (`item 1 of argv`), nie wklejony w jego treść, więc nie da się go użyć do
 * wstrzyknięcia AppleScriptu. Zwraca ścieżkę bez końcowego `/` albo `null`, gdy
 * użytkownik anulował (kod błędu AppleScript -128).
 */
export async function osascriptWybierzFolder(binarka: string, prompt: string, limitCzasuMs: number): Promise<string | null> {
  const w = await wykonaj(
    binarka,
    ['-e', 'on run argv', '-e', 'POSIX path of (choose folder with prompt (item 1 of argv))', '-e', 'end run', '--', prompt],
    limitCzasuMs,
  );
  if (w.kodWyjscia !== 0) {
    if (w.stderr.includes('(-128)')) return null;
    throw new BladHosta('wewnetrzny', `osascript: kod wyjścia ${w.kodWyjscia}`);
  }
  const sciezka = w.stdout.replace(/\n$/, '');
  if (sciezka === '') throw new BladHosta('wewnetrzny', 'osascript: pusta odpowiedź');
  return sciezka.length > 1 ? sciezka.replace(/\/+$/, '') : sciezka;
}

// --- lsof ---

/** PID-y procesów nasłuchujących na porcie TCP (IPv4 i IPv6). */
export async function lsofNasluchujace(b: Binarki, port: number): Promise<number[]> {
  const w = await wykonaj(b.lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  // Kod 1 = nikt nie nasłuchuje. Inny niezerowy kod to błąd (uprawnienia,
  // hardening): zamaskowanie go pustą listą zamieniłoby żywy obcy serwer
  // na „pusty port” i ufnie przyjęło mapowanie (przegląd W3).
  if (w.kodWyjscia === 1) return [];
  if (w.kodWyjscia !== 0) {
    throw new BladHosta('wewnetrzny', `lsof: nieoczekiwany kod wyjścia ${w.kodWyjscia} — nie mogę sprawdzić portu ${port}`);
  }
  const pidy = new Set<number>();
  for (const linia of w.stdout.split('\n')) {
    const m = /^p(\d+)$/.exec(linia);
    if (m) pidy.add(Number(m[1]));
  }
  return [...pidy];
}

/** Katalog roboczy procesu; null, gdy proces zniknął albo należy do innego użytkownika. */
export async function lsofCwd(b: Binarki, pid: number): Promise<string | null> {
  const w = await wykonaj(b.lsof, ['-a', '-nP', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (w.kodWyjscia !== 0) return null;
  const linia = w.stdout.split('\n').find(l => l.startsWith('n'));
  return linia ? linia.slice(1) : null;
}

// --- herdr ---

export type BladHerdr = { kod: string; wiadomosc: string };
export type WynikHerdr = { ok: true; json: unknown } | { ok: false; blad: BladHerdr };

/** herdr pisze błędy jako JSON na stderr z kodem wyjścia 1; herdr-core (`hc`) tak samo, ale pole nazywa `kind` (kod 3 przy `not_found`). */
function zWynikuHerdr(w: WynikProcesu): WynikHerdr {
  if (w.kodWyjscia === 0) {
    try {
      return { ok: true, json: JSON.parse(w.stdout) as unknown };
    } catch {
      return { ok: false, blad: { kod: 'nieczytelna_odpowiedz', wiadomosc: w.stdout.slice(0, 200) } };
    }
  }
  try {
    const surowy: unknown = JSON.parse(w.stderr);
    if (surowy !== null && typeof surowy === 'object' && 'error' in surowy) {
      const e: unknown = surowy.error;
      if (e !== null && typeof e === 'object') {
        // herdr: `code`; herdr-core (`hc`): `kind`.
        const kod = 'code' in e && typeof e.code === 'string' ? e.code : 'kind' in e && typeof e.kind === 'string' ? e.kind : null;
        if (kod !== null) {
          const wiadomosc = 'message' in e && typeof e.message === 'string' ? e.message : '';
          return { ok: false, blad: { kod, wiadomosc } };
        }
      }
    }
  } catch {
    // niżej
  }
  return { ok: false, blad: { kod: `wyjscie_${w.kodWyjscia}`, wiadomosc: w.stderr.slice(0, 200) } };
}

const WZOR_PANE = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;

function sprawdzPane(paneId: string): void {
  // Pane trafia do argv; wzór wyklucza wszystko, co mogłoby udawać flagę.
  if (!WZOR_PANE.test(paneId)) throw new BladHosta('zadanie_niepoprawne', 'niepoprawny paneId');
}

function wymagajHerdr(b: Binarki): string {
  if (b.herdr === undefined) throw new BladHosta('herdr_niedostepny', 'brak herdr w konfiguracji — zainstaluj ponownie z herdr w PATH');
  return b.herdr;
}

export async function herdrListaAgentow(b: Binarki): Promise<WynikHerdr> {
  return zWynikuHerdr(await wykonaj(wymagajHerdr(b), ['agent', 'list']));
}

export async function herdrAgent(b: Binarki, paneId: string): Promise<WynikHerdr> {
  sprawdzPane(paneId);
  return zWynikuHerdr(await wykonaj(wymagajHerdr(b), ['agent', 'get', paneId]));
}

/** Linii dołu ekranu: nagłówki dialogów z nagrań mieszczą się w oknie 15 linii. */
export const LINII_EKRANU = 15;

/**
 * `herdr agent read <pane> --source detection` — tylko odczyt (BRIEF §5, F1).
 * Zwraca zwykły tekst; błąd jest JSON-em na stderr jak w innych komendach.
 */
export async function herdrEkran(b: Binarki, paneId: string): Promise<{ ok: true; tekst: string } | { ok: false; blad: BladHerdr }> {
  sprawdzPane(paneId);
  const w = await wykonaj(wymagajHerdr(b), ['agent', 'read', paneId, '--source', 'detection', '--lines', String(LINII_EKRANU)]);
  if (w.kodWyjscia === 0) return { ok: true, tekst: w.stdout };
  const blad = zWynikuHerdr(w);
  return { ok: false, blad: blad.ok ? { kod: 'nieczytelna_odpowiedz', wiadomosc: '' } : blad.blad };
}

/**
 * `herdr agent prompt <pane> <tekst>` — tekst jest ściśle pozycyjny, a `--`
 * w herdr 0.9.3 NIE jest separatorem (zostałby wzięty jako tekst, a właściwy
 * tekst jako nieznana opcja; host.md §1.5). Dlatego dokładnie cztery argumenty.
 */
export async function herdrPrompt(b: Binarki, paneId: string, tekst: string): Promise<WynikHerdr> {
  sprawdzPane(paneId);
  if (tekst.length === 0 || tekst.startsWith('-')) throw new BladHosta('wewnetrzny', 'tekst promptu musi zaczynać się od stałego prefiksu');
  return zWynikuHerdr(await wykonaj(wymagajHerdr(b), ['agent', 'prompt', paneId, tekst]));
}

// --- herdr-core (`hc`) ---

/**
 * Agenci w aplikacji Herdr (T208). Adresy `t…` to inna przestrzeń nazw niż pane
 * starego TUI (`w…:p…`) — obie walidowane osobno, żeby identyfikator z jednego
 * źródła nie wszedł do komendy drugiego.
 */
const WZOR_ADRESU_HC = /^t[0-9a-z]{1,31}$/;

function sprawdzAdresHc(adres: string): void {
  // Adres trafia do argv; wzór wyklucza wszystko, co mogłoby udawać flagę.
  if (!WZOR_ADRESU_HC.test(adres)) throw new BladHosta('zadanie_niepoprawne', 'niepoprawny adres terminala hc');
}

function wymagajHc(b: Binarki): string {
  if (b.hc === undefined) throw new BladHosta('herdr_niedostepny', 'brak hc w konfiguracji — zainstaluj ponownie z herdr-core w PATH');
  return b.hc;
}

/** `hc ls --json` — kompaktowa lista: `{terminals:[{address,agent,cwd,name,state,turn}]}`. */
export async function hcLista(b: Binarki): Promise<WynikHerdr> {
  return zWynikuHerdr(await wykonaj(wymagajHc(b), ['ls', '--json']));
}

/** `hc get <adres> --json` — pełny rekord: status agenta, `foreground.cwd`, argv. */
export async function hcAgent(b: Binarki, adres: string): Promise<WynikHerdr> {
  sprawdzAdresHc(adres);
  return zWynikuHerdr(await wykonaj(wymagajHc(b), ['get', adres, '--json']));
}

/**
 * `hc read <adres> --lines 0` — tylko widoczny ekran, zwykły tekst (bez przewijania
 * historii). To odpowiednik `herdr agent read --source detection`.
 */
export async function hcEkran(b: Binarki, adres: string): Promise<{ ok: true; tekst: string } | { ok: false; blad: BladHerdr }> {
  sprawdzAdresHc(adres);
  const w = await wykonaj(wymagajHc(b), ['read', adres, '--lines', '0']);
  if (w.kodWyjscia === 0) return { ok: true, tekst: w.stdout };
  const blad = zWynikuHerdr(w);
  return { ok: false, blad: blad.ok ? { kod: 'nieczytelna_odpowiedz', wiadomosc: '' } : blad.blad };
}

/**
 * `hc send <adres> <tekst>` — bez `--force` (nigdy nie piszemy w zablokowany
 * program) i bez `--if` (status oceniamy sami, jak w ścieżce TUI). `hc` odmawia
 * zapisu blokowanym programom; odmowa wraca jako kod wyjścia ≠ 0 z JSON-em na stderr.
 */
export async function hcWyslij(b: Binarki, adres: string, tekst: string): Promise<WynikHerdr> {
  sprawdzAdresHc(adres);
  if (tekst.length === 0 || tekst.startsWith('-')) throw new BladHosta('wewnetrzny', 'tekst promptu musi zaczynać się od stałego prefiksu');
  return zWynikuHerdr(await wykonaj(wymagajHc(b), ['send', adres, tekst]));
}
