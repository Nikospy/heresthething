import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { Binarki } from '../../src/host/konfiguracja';

const KORZEN_POM = join(import.meta.dirname, '../..');

/** Wejścia builda: nowy, zmieniony i usunięty plik zmieniają odcisk. */
function odciskZrodel(): string {
  let ile = 0;
  let najnowszy = 0;
  const odwiedz = (sciezka: string): void => {
    const opis = statSync(sciezka);
    if (opis.isDirectory()) { for (const wpis of readdirSync(sciezka)) odwiedz(join(sciezka, wpis)); return; }
    ile++;
    najnowszy = Math.max(najnowszy, opis.mtimeMs);
  };
  // `host/` (stare skrypty) nie ma w publicznym repo części lokalnej (S-37).
  for (const wejscie of ['src', 'host', 'scripts', 'package.json']) if (existsSync(join(KORZEN_POM, wejscie))) odwiedz(join(KORZEN_POM, wejscie));
  return `${ile}:${najnowszy}`;
}

/**
 * `dist/` dla testów skryptów (instalacja, polacz): jedna budowa na stan źródeł.
 * Build robi rm -rf dist/, a te pliki testów biegną równolegle. Drugi plik nie może
 * więc budować, gdy pierwszy już używa `dist/`: `install.sh --bez-budowania` kończył
 * się wtedy kodem 1 („brak dist/host/host.mjs”, T217; wcześniej chmod, T208). Odcisk
 * leży w `dist/`, więc znika razem z nim, a każdy inny build wymusza budowę od nowa.
 * Zamek jest międzyprocesowy (mkdir jest atomowy); starszy niż 2 min = po padniętym procesie.
 */
export async function zbudujDistDlaTestow(): Promise<void> {
  // Zamek POZA dist/ (build robi rm -rf dist) i bez recursive: mkdir bez recursive
  // jest atomowy i rzuca EEXIST, gdy ktoś już buduje.
  const blokada = join(KORZEN_POM, 'node_modules', '.budowa-dist-blokada');
  for (;;) {
    try {
      mkdirSync(blokada);
    } catch {
      // Ktoś już buduje (lib ES2023 nie zna Promise.withResolvers — forma z wykonawcą).
      await new Promise<void>(w => {
        setTimeout(w, 300);
      });
      try {
        if (Date.now() - statSync(blokada).mtimeMs > 120_000) rmSync(blokada, { force: true, recursive: true });
      } catch {
        // ktoś właśnie zdjął zamek — kolejny obieg sprawdzi stan
      }
      continue;
    }
    try {
      const plikOdcisku = join(KORZEN_POM, 'dist', '.odcisk-zrodel');
      const odcisk = odciskZrodel();
      if (!existsSync(plikOdcisku) || readFileSync(plikOdcisku, 'utf8') !== odcisk) {
        execFileSync('npm', ['run', '--silent', 'build'], { cwd: KORZEN_POM, stdio: 'pipe' });
        writeFileSync(plikOdcisku, odcisk);
      }
    } finally {
      rmSync(blokada, { force: true, recursive: true });
    }
    return;
  }
}

/** Katalog tymczasowy po realpath (na macOS /var → /private/var), sprzątany po pliku testów. */
export function katalogTymczasowy(prefiks = 'uwagi-host-'): string {
  const k = realpathSync(mkdtempSync(join(tmpdir(), prefiks)));
  afterAll(() => rmSync(k, { recursive: true, force: true }));
  return k;
}

function ktora(nazwa: string): string {
  return execFileSync('/usr/bin/which', [nazwa]).toString().trim();
}

/** Prawdziwe binarki z PATH testującego — testy resolve/zapisu działają na prawdziwym git i lsof. */
export function binarkiPrawdziwe(herdr = '/usr/bin/false'): Binarki {
  return { git: ktora('git'), lsof: ktora('lsof'), herdr };
}

export function nowyRepo(rodzic: string, nazwa: string): string {
  const p = join(rodzic, nazwa);
  execFileSync(ktora('git'), ['init', '-q', p]);
  return realpathSync(p);
}
