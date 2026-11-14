import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { katalogTymczasowy, zbudujDistDlaTestow } from './pomocnicze';

vi.setConfig({ testTimeout: 20_000 });

const KORZEN = join(import.meta.dirname, '../..');
const INSTALATOR = join(KORZEN, 'dist/host/instalator.mjs');
const ID_DEV = readFileSync(join(KORZEN, 'src/wspolne/id-wtyczki.txt'), 'utf8').trim();
const WERSJA = (JSON.parse(readFileSync(join(KORZEN, 'package.json'), 'utf8')) as { version: string }).version;
const ID_SKLEPU = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ID_FLAGA = 'abcdefghijklmnopabcdefghijklmnop';
const ZDANIE_ZAPISU = 'Podgląd (--dry-run). Nic nie zapisano.';
const baza = katalogTymczasowy('uwagi-instalator-');

const PRAWDZIWE = [join(homedir(), '.claude.json'), join(homedir(), '.codex', 'config.toml')];
const odciski = new Map<string, string>();

/**
 * Odcisk tylko tego, co instalator mógłby zmienić: wpisy `herestt` i `tryb-uwag` serwerów MCP.
 * Cały plik (rozmiar, mtime) zmienia żywa sesja Claude, więc dawał fałszywą czerwień.
 */
function odcisk(sciezka: string): string {
  let tresc: string;
  try {
    tresc = readFileSync(sciezka, 'utf8');
  } catch {
    return 'brak';
  }
  const nazwy = ['herestt', 'tryb-uwag'];
  if (sciezka.endsWith('.json')) {
    try {
      const serwery = (JSON.parse(tresc) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
      return JSON.stringify(nazwy.map(nazwa => serwery[nazwa] ?? null));
    } catch {
      return 'nieczytelny';
    }
  }
  const sekcje = nazwy.map(nazwa => {
    const poczatek = tresc.indexOf(`[mcp_servers.${nazwa}]`);
    if (poczatek === -1) return null;
    const reszta = tresc.slice(poczatek + 1);
    const koniec = reszta.search(/^\[/m);
    return koniec === -1 ? reszta : reszta.slice(0, koniec);
  });
  return JSON.stringify(sekcje);
}

function pliki(korzen: string): string[] {
  const wynik: string[] = [];
  const stos: Array<{ p: string; rel: string }> = [{ p: korzen, rel: '' }];
  while (stos.length > 0) {
    const biezacy = stos.pop();
    if (biezacy === undefined) break;
    let wpisy: string[];
    try {
      wpisy = readdirSync(biezacy.p);
    } catch {
      continue;
    }
    for (const wpis of wpisy) {
      const pelna = join(biezacy.p, wpis);
      const rel = biezacy.rel === '' ? wpis : `${biezacy.rel}/${wpis}`;
      if (lstatSync(pelna).isDirectory()) stos.push({ p: pelna, rel });
      else wynik.push(rel);
    }
  }
  return wynik.sort();
}

function dom(): string {
  const sciezka = join(baza, `dom-${Math.random().toString(36).slice(2)}`);
  mkdirSync(sciezka, { recursive: true });
  return sciezka;
}

function srodowisko(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'pl_PL.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    ...extra,
  };
}

function skrypt(sciezka: string, tresc: string): void {
  mkdirSync(join(sciezka, '..'), { recursive: true });
  writeFileSync(sciezka, tresc, { mode: 0o755 });
  chmodSync(sciezka, 0o755);
}

function odpal(args: string[], env: NodeJS.ProcessEnv, wejscie?: string): { kod: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [INSTALATOR, ...args], {
      env,
      encoding: 'utf8',
      timeout: 15_000,
      ...(wejscie === undefined ? {} : { input: wejscie }),
    });
    return { kod: 0, stdout, stderr: '' };
  } catch (e) {
    const blad = e as { status?: number | null; stdout?: unknown; stderr?: unknown };
    const tekst = (wartosc: unknown): string => {
      if (typeof wartosc === 'string') return wartosc;
      if (wartosc instanceof Uint8Array) return Buffer.from(wartosc).toString('utf8');
      return '';
    };
    return { kod: blad.status ?? 1, stdout: tekst(blad.stdout), stderr: tekst(blad.stderr) };
  }
}

function ostatnia(stdout: string): string {
  const linie = stdout.split('\n').filter(linia => linia.trim().length > 0);
  return linie.at(-1) ?? '';
}

function originy(stdout: string): string[] {
  return stdout.match(/chrome-extension:\/\/[a-p]{32}\//g) ?? [];
}

beforeAll(async () => {
  for (const plik of PRAWDZIWE) odciski.set(plik, odcisk(plik));
  await zbudujDistDlaTestow();
}, 120_000);

afterAll(() => {
  for (const plik of PRAWDZIWE) expect(odcisk(plik), plik).toBe(odciski.get(plik));
});

describe('instalator, faza 1: podgląd niczego nie zapisuje', () => {
  it('R1 brak pliku sklepu: origin to id wtyczki', () => {
    const home = dom();
    const przed = pliki(home);
    const wynik = odpal(['--dry-run', '--bez-budowania'], srodowisko(home));
    expect(wynik.kod).toBe(0);
    expect(originy(wynik.stdout)).toEqual([`chrome-extension://${ID_DEV}/`]);
    expect(wynik.stdout).toContain(`heresthething ${WERSJA}`);
    expect(wynik.stdout).not.toContain('numer wersji');
    expect(pliki(home)).toEqual(przed);
  });

  it('R1 --id jest jedynym originem', () => {
    const home = dom();
    const wynik = odpal(['--dry-run', '--bez-budowania', '--id', ID_FLAGA], srodowisko(home));
    expect(wynik.kod).toBe(0);
    expect(originy(wynik.stdout)).toEqual([`chrome-extension://${ID_FLAGA}/`]);
    expect(wynik.stdout).not.toContain(ID_DEV);
    expect(pliki(home)).toEqual([]);
  });

  it('R1 tymczasowy plik sklepu jest jedynym originem', () => {
    const home = dom();
    const plik = join(baza, `sklep-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(plik, `${ID_SKLEPU}\n`);
    const wynik = odpal(['--dry-run', '--bez-budowania'], srodowisko(home, { HERESTT_PLIK_SKLEPU: plik }));
    expect(wynik.kod).toBe(0);
    expect(originy(wynik.stdout)).toEqual([`chrome-extension://${ID_SKLEPU}/`]);
    expect(wynik.stdout).not.toContain(ID_DEV);
    expect(pliki(home)).toEqual([]);
  });

  it('R1 zły plik sklepu i złe --id kończą się przed podglądem', () => {
    const home = dom();
    const plik = join(baza, `zly-sklep-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(plik, 'ZZZ\n');
    const zlyPlik = odpal(['--dry-run', '--bez-budowania'], srodowisko(home, { HERESTT_PLIK_SKLEPU: plik }));
    const zleId = odpal(['--dry-run', '--bez-budowania', '--id', 'ZZZ'], srodowisko(home));
    for (const wynik of [zlyPlik, zleId]) {
      expect(wynik.kod).not.toBe(0);
      expect(wynik.stdout).not.toContain('chrome-extension://');
      expect(wynik.stdout).not.toContain(ZDANIE_ZAPISU);
      expect(wynik.stdout).not.toContain('heresthething');
      expect(pliki(home)).toEqual([]);
    }
  });

  it('R2 --dry-run kończy się zdaniem o następnej fazie i nie pyta', () => {
    const home = dom();
    const wynik = odpal(['--dry-run', '--bez-budowania'], srodowisko(home, { HERESTT_TTY: '1' }), 'ZZZ\n');
    expect(wynik.kod).toBe(0);
    expect(ostatnia(wynik.stdout)).toBe(ZDANIE_ZAPISU);
    expect(wynik.stdout).not.toContain('Enter = zapisz');
    expect(wynik.stdout).toContain('Nic nie zostanie zapisane, dopóki nie potwierdzisz');
    expect(wynik.stdout).toContain('Nie zmieniamy: ustawień przeglądarki, innych wpisów agentów, plików projektów');
    expect(wynik.stdout).toContain('~/.config/herestt');
    expect(wynik.stdout).not.toContain('żeby zostawić domyślne');
    expect(wynik.stdout).not.toMatch(/\u001b\[/);
    expect(pliki(home)).toEqual([]);
  });

  it('R2 brak TTY i brak --yes: podgląd, bez czytania złego wejścia', () => {
    const home = dom();
    const wynik = odpal(['--bez-budowania'], srodowisko(home), 'ZZZ\n');
    expect(wynik.kod).toBe(0);
    expect(ostatnia(wynik.stdout)).toContain('Bez terminala nie pytam o zapis.');
    expect(wynik.stdout).not.toContain('Enter = zapisz');
    expect(pliki(home)).toEqual([]);
  });

  it('R2 po angielsku ostatnia linia to Preview (--dry-run). Nothing was written.', () => {
    const home = dom();
    const wynik = odpal(['--dry-run', '--bez-budowania'], srodowisko(home, { LANG: 'en_US.UTF-8' }));
    expect(wynik.kod).toBe(0);
    expect(ostatnia(wynik.stdout)).toBe('Preview (--dry-run). Nothing was written.');
    expect(wynik.stdout).toContain('We do not change: browser settings, other agent entries, project files');
    expect(wynik.stdout).not.toContain(ZDANIE_ZAPISU);
    expect(pliki(home)).toEqual([]);
  });

  it('R2 przebieg interaktywny pyta o zapis; n anuluje, nie uruchamia claude i nic nie zapisuje', () => {
    const home = dom();
    const aplikacje = join(baza, `aplikacje-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(aplikacje, 'Arc.app'), { recursive: true });
    const znacznik = join(baza, `claude-${Math.random().toString(36).slice(2)}`);
    const bin = join(baza, `bin-${Math.random().toString(36).slice(2)}`);
    skrypt(join(bin, 'claude'), `#!/bin/sh\nprintf x >> ${JSON.stringify(znacznik)}\n`);
    const wynik = odpal(['--bez-budowania'], srodowisko(home, {
      HERESTT_TTY: '1',
      HERESTT_APPLICATIONS: aplikacje,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    }), '\n\nn\n');
    expect(wynik.kod).toBe(0);
    expect(ostatnia(wynik.stdout)).toBe('Anulowano. Nic nie zapisano.');
    expect(wynik.stdout).toContain('Zapisać te zmiany? [Enter = zapisz, n = anuluj]');
    expect(wynik.stdout).toContain('żeby zostawić domyślne');
    expect(wynik.stdout.match(/\[Enter = tak, n = nie\]/g)).toEqual(['[Enter = tak, n = nie]']);
    expect(wynik.stdout).toContain('Nie znaleziono Codexa. Pomijam.');
    expect(wynik.stdout).toContain('przeglądarka: Arc');
    const liniaNode = wynik.stdout.split('\n').find(linia => linia.startsWith('node: '));
    expect(liniaNode).toBeDefined();
    const node = liniaNode?.slice('node: '.length);
    expect(wynik.stdout).toContain(`claude mcp add --scope user herestt -- ${node} ${join(home, '.config/herestt/mcp.mjs')}`);
    expect(wynik.stdout).not.toContain('codex mcp add');
    expect(existsSync(znacznik)).toBe(false);
    expect(pliki(home)).toEqual([]);
  });

  it('R3 inny system: zdanie D15, kod 0, zero plików, bez zdania o zapisie', () => {
    const home = dom();
    const polski = odpal(['--bez-budowania'], srodowisko(home, { HERESTT_PLATFORM: 'linux' }));
    expect(polski.kod).toBe(0);
    expect(polski.stdout).toBe('Połączenie z agentem działa na razie tylko na macOS. Czat działa wszędzie.\n');
    expect(pliki(home)).toEqual([]);
    const angielski = odpal(['--bez-budowania'], srodowisko(home, { HERESTT_PLATFORM: 'linux', LANG: 'en_US.UTF-8' }));
    expect(angielski.kod).toBe(0);
    expect(angielski.stdout).toBe('Connection to an agent works on macOS for now. Chat works everywhere.\n');
    expect(angielski.stdout).not.toContain('Saving comes');
  });

  it('R4 katalog danych bez aplikacji nie wchodzi na listę', () => {
    const home = dom();
    const aplikacje = join(baza, `aplikacje-r4-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(aplikacje, 'Arc.app'), { recursive: true });
    mkdirSync(join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default'), { recursive: true });
    const wynik = odpal(['--dry-run', '--bez-budowania'], srodowisko(home, { HERESTT_APPLICATIONS: aplikacje }));
    expect(wynik.kod).toBe(0);
    expect(wynik.stdout).toContain('przeglądarka: Arc');
    expect(wynik.stdout).not.toContain('przeglądarka: Chrome');
    expect(pliki(home).some(rel => rel.endsWith('herestt') || rel.includes('NativeMessagingHosts'))).toBe(false);
  });

  it('R4 aplikacja bez katalogu wchodzi, a domyślnie zostaje ta z wtyczką', () => {
    const home = dom();
    const aplikacje = join(baza, `aplikacje-r4b-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(aplikacje, 'Google Chrome.app'), { recursive: true });
    mkdirSync(join(aplikacje, 'Arc.app'), { recursive: true });
    mkdirSync(join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Extensions', ID_DEV, '1.0'), { recursive: true });
    const wynik = odpal(['--dry-run', '--bez-budowania'], srodowisko(home, { HERESTT_APPLICATIONS: aplikacje }));
    expect(wynik.kod).toBe(0);
    expect(wynik.stdout).toContain('przeglądarka: Chrome');
    expect(wynik.stdout).toContain('przeglądarka: Arc');
    expect(wynik.stdout).toContain('przeglądarka: Arc (niesprawdzone)');
    expect(wynik.stdout).not.toContain('przeglądarka: Chrome (niesprawdzone)');
    const manifestChrome = join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.herestt.host.json');
    const manifestArc = join(home, 'Library/Application Support/Arc/User Data/NativeMessagingHosts/com.herestt.host.json');
    expect(wynik.stdout).toContain(manifestChrome);
    expect(wynik.stdout).not.toContain(manifestArc);
    expect(existsSync(manifestChrome)).toBe(false);
  });

  it('R5 stała ścieżka Node wygrywa ze ścieżką z numerem wersji i ostrzega raz', () => {
    const home = dom();
    const stala = join(baza, `stale-${Math.random().toString(36).slice(2)}`, 'bin', 'node');
    const wersjonowana = join(baza, `wersje-${Math.random().toString(36).slice(2)}`, 'versions', 'node', 'v22.0.0', 'bin', 'node');
    skrypt(stala, '#!/bin/sh\necho v22.14.0\n');
    skrypt(wersjonowana, '#!/bin/sh\necho v22.0.0\n');
    const wynik = odpal(['--dry-run', '--bez-budowania'], srodowisko(home, {
      HERESTT_NODE_STALE: stala,
      PATH: `${join(wersjonowana, '..')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    }));
    expect(wynik.kod).toBe(0);
    expect(wynik.stdout.split('\n').filter(linia => linia.startsWith('node: '))).toEqual([`node: ${stala}`]);
    expect(wynik.stdout).not.toContain(`node: ${wersjonowana}`);
    expect(wynik.stdout.split('Node z PATH zawiera numer wersji.').length - 1).toBe(1);
    expect(ostatnia(wynik.stdout)).toBe(ZDANIE_ZAPISU);
    expect(pliki(home)).toEqual([]);
  });

  it('R6 nieudane xcode-select nie uruchamia gita', () => {
    const home = dom();
    const znacznik = join(baza, `git-${Math.random().toString(36).slice(2)}`);
    const bin = join(baza, `gitbin-${Math.random().toString(36).slice(2)}`);
    const git = join(bin, 'git');
    const xcode = join(baza, `xcode-${Math.random().toString(36).slice(2)}`);
    skrypt(git, `#!/bin/sh\nprintf x >> ${JSON.stringify(znacznik)}\n`);
    skrypt(xcode, '#!/bin/sh\nexit 1\n');
    execFileSync(git);
    expect(readFileSync(znacznik, 'utf8').length).toBeGreaterThan(0);
    rmSync(znacznik);
    const wynik = odpal(['--dry-run', '--bez-budowania'], srodowisko(home, {
      HERESTT_XCODE_SELECT: xcode,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    }));
    expect(wynik.kod).not.toBe(0);
    expect(existsSync(znacznik)).toBe(false);
    expect(wynik.stdout).not.toContain(ZDANIE_ZAPISU);
    expect(wynik.stdout).not.toContain('chrome-extension://');
    expect(wynik.stdout).toContain('xcode-select -p');
    expect(pliki(home)).toEqual([]);
  });

  it('--yes bez list kończy się przed podglądem, a z listami nadal nic nie zapisuje', () => {
    const home = dom();
    const aplikacje = join(baza, `aplikacje-yes-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(aplikacje, 'Google Chrome.app'), { recursive: true });
    mkdirSync(join(aplikacje, 'Arc.app'), { recursive: true });
    const samo = odpal(['--yes', '--bez-budowania'], srodowisko(home, { HERESTT_APPLICATIONS: aplikacje }));
    expect(samo.kod).not.toBe(0);
    expect(samo.stdout).not.toContain(ZDANIE_ZAPISU);
    const tylkoArc = join(baza, `aplikacje-arc-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tylkoArc, 'Arc.app'), { recursive: true });
    const brak = odpal(['--yes', '--browsers', 'chrome', '--agents', 'none', '--bez-budowania'], srodowisko(home, { HERESTT_APPLICATIONS: tylkoArc }));
    expect(brak.kod).not.toBe(0);
    expect(brak.stdout).toContain('Nie znaleziono przeglądarki Chrome.');
    expect(brak.stdout).not.toContain(ZDANIE_ZAPISU);
    const profil = join(home, 'profil');
    mkdirSync(profil);
    const przed = pliki(home);
    const zapis = odpal(
      ['--yes', '--dry-run', '--browsers', 'chrome,arc', '--agents', 'none', '--profil', profil, '--bez-budowania'],
      srodowisko(home, { HERESTT_APPLICATIONS: aplikacje }),
    );
    expect(zapis.kod).toBe(0);
    expect(ostatnia(zapis.stdout)).toBe(ZDANIE_ZAPISU);
    expect(zapis.stdout).toContain(join(profil, 'NativeMessagingHosts/com.herestt.host.json'));
    expect(zapis.stdout).toContain(join(profil, 'przegladarki/arc/NativeMessagingHosts/com.herestt.host.json'));
    expect(zapis.stdout).toContain(join(profil, 'herestt/host.mjs'));
    expect(zapis.stdout).not.toContain('~/.config/herestt');
    expect(zapis.stdout).not.toContain('claude mcp add');
    expect(originy(zapis.stdout)).toEqual([`chrome-extension://${ID_DEV}/`]);
    expect(pliki(home)).toEqual(przed);
  });

  it('undo bez dziennika na pustym HOME i nieznana opcja nie tworzą plików', () => {
    const home = dom();
    const undo = odpal(['undo', '--all'], srodowisko(home));
    expect(undo.kod).toBe(0);
    const obca = odpal(['--nie-ma'], srodowisko(home));
    expect(obca.kod).toBe(2);
    expect(obca.stdout).not.toContain(ZDANIE_ZAPISU);
    expect(pliki(home)).toEqual([]);
  });
});
