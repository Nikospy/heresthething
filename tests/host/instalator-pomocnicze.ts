import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wspólny szew testów zapisu i `undo` instalatora. Nigdy prawdziwe konto: tymczasowy HOME,
 * PATH bez prawdziwych `claude`/`codex` (zaślepki w `bin/`), zdjęte `CLAUDE_CONFIG_DIR` i `CODEX_HOME`.
 */

export const KORZEN = join(import.meta.dirname, '../..');
export const INSTALATOR = join(KORZEN, 'dist/host/instalator.mjs');

const { CLAUDE_CONFIG_DIR: _claude, CODEX_HOME: _codex, ...SRODOWISKO } = process.env;

/** Zaślepka CLI agenta: loguje argv i trzyma „wpisy MCP” jako pliki w magazynie. */
const ZASLEPKA = `#!/bin/sh
nazwa="$(basename "$0")"
echo "$nazwa $*" >> "$STUB_LOG"
if [ "$1 $2" = "mcp add" ]; then
  [ -z "$STUB_FAIL_ADD" ] || exit 1
  if [ "$3" = "--scope" ]; then wpis="$5"; else wpis="$3"; fi
  echo "$*" > "$STUB_STORE/$nazwa.$wpis"
  exit 0
fi
if [ "$1 $2" = "mcp remove" ]; then
  if [ "$3" = "--scope" ]; then wpis="$5"; else wpis="$3"; fi
  [ -e "$STUB_STORE/$nazwa.$wpis" ] || exit 1
  rm -f "$STUB_STORE/$nazwa.$wpis"
  exit 0
fi
exit 2
`;

export interface Stanowisko {
  home: string;
  profil: string;
  aplikacje: string;
  bin: string;
  log: string;
  magazyn: string;
  env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
}

export function stanowisko(baza: string, agenci: Array<'claude' | 'codex'> = ['claude', 'codex'], aplikacje: string[] = ['Google Chrome.app', 'Arc.app']): Stanowisko {
  const korzen = join(baza, `s-${Math.random().toString(36).slice(2)}`);
  const home = join(korzen, 'home');
  const profil = join(korzen, 'profil');
  const apps = join(korzen, 'aplikacje');
  const bin = join(korzen, 'bin');
  const magazyn = join(korzen, 'magazyn');
  const log = join(korzen, 'cli.log');
  for (const katalog of [home, profil, bin, magazyn]) mkdirSync(katalog, { recursive: true });
  for (const aplikacja of aplikacje) mkdirSync(join(apps, aplikacja), { recursive: true });
  mkdirSync(apps, { recursive: true });
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(log, '');
  for (const agent of agenci) {
    writeFileSync(join(bin, agent), ZASLEPKA, { mode: 0o755 });
    chmodSync(join(bin, agent), 0o755);
  }
  return {
    home,
    profil,
    aplikacje: apps,
    bin,
    log,
    magazyn,
    env: (extra = {}) => ({
      ...SRODOWISKO,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: 'pl_PL.UTF-8',
      LC_ALL: '',
      HERESTT_APPLICATIONS: apps,
      HERESTT_NODE_STALE: '',
      STUB_LOG: log,
      STUB_STORE: magazyn,
      ...extra,
    }),
  };
}

export interface Wynik {
  kod: number;
  stdout: string;
  stderr: string;
}

export function odpal(args: string[], env: NodeJS.ProcessEnv, wejscie?: string): Wynik {
  try {
    const stdout = execFileSync(process.execPath, [INSTALATOR, ...args], {
      env,
      encoding: 'utf8',
      timeout: 40_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(wejscie === undefined ? { input: '' } : { input: wejscie }),
    });
    return { kod: 0, stdout, stderr: '' };
  } catch (e) {
    const blad = e as { status?: number | null; stdout?: unknown; stderr?: unknown };
    const tekst = (wartosc: unknown): string => (typeof wartosc === 'string' ? wartosc : wartosc instanceof Uint8Array ? Buffer.from(wartosc).toString('utf8') : '');
    return { kod: blad.status ?? 1, stdout: tekst(blad.stdout), stderr: tekst(blad.stderr) };
  }
}

/** Wszystkie pliki i symlinki pod korzeniem: ścieżka względna → treść (albo `-> cel`). Puste katalogi pomija. */
export function migawka(korzen: string): Record<string, string> {
  const wynik: Record<string, string> = {};
  const idz = (dir: string, rel: string): void => {
    let wpisy: string[];
    try {
      wpisy = readdirSync(dir);
    } catch {
      return;
    }
    for (const wpis of wpisy) {
      const pelna = join(dir, wpis);
      const wzgledna = rel === '' ? wpis : `${rel}/${wpis}`;
      const opis = lstatSync(pelna);
      if (opis.isSymbolicLink()) wynik[wzgledna] = `-> ${readlinkSync(pelna)}`;
      else if (opis.isDirectory()) idz(pelna, wzgledna);
      else wynik[wzgledna] = readFileSync(pelna, 'utf8');
    }
  };
  if (existsSync(korzen)) idz(korzen, '');
  return wynik;
}

export function bezKluczy(m: Record<string, string>, ...klucze: string[]): Record<string, string> {
  const kopia = { ...m };
  for (const klucz of klucze) delete kopia[klucz];
  return kopia;
}

/** Pliki z HOME i z profilu razem (profil leży obok HOME), z przedrostkiem `home/` i `profil/`. */
export function migawkaStanowiska(s: Stanowisko): Record<string, string> {
  const wynik: Record<string, string> = {};
  for (const [k, v] of Object.entries(migawka(s.home))) wynik[`home/${k}`] = v;
  for (const [k, v] of Object.entries(migawka(s.profil))) wynik[`profil/${k}`] = v;
  return wynik;
}
