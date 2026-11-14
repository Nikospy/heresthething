import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PROSBA_DO_AGENTA } from '../../src/wspolne/prosba';
import { bezKluczy, KORZEN, migawka, odpal, stanowisko } from './instalator-pomocnicze';
import { katalogTymczasowy, zbudujDistDlaTestow } from './pomocnicze';

vi.setConfig({ testTimeout: 60_000 });

const baza = katalogTymczasowy('uwagi-instalator-zapis-');
const ID_DEV = readFileSync(join(KORZEN, 'src/wspolne/id-wtyczki.txt'), 'utf8').trim();
const WERSJA = (JSON.parse(readFileSync(join(KORZEN, 'package.json'), 'utf8')) as { version: string }).version;
const MANIFEST = 'NativeMessagingHosts/com.herestt.host.json';

interface Dz {
  idWtyczki: string;
  stan: string;
  wybor: { przegladarki: string[]; agenci: string[] };
  kroki: Array<{ rodzaj: string; cel: string; ok: boolean; sha?: string }>;
}

const dziennik = (profil: string): Dz => JSON.parse(readFileSync(join(profil, 'herestt/instalacja.json'), 'utf8')) as Dz;

beforeAll(() => zbudujDistDlaTestow(), 120_000);

describe('instalator, faza 2: zapis', () => {
  it('R7 --yes zapisuje manifesty Chrome i Arc, jedno wywołanie claude, zero codex, jeden origin', () => {
    const s = stanowisko(baza);
    const w = odpal(['--yes', '--browsers', 'chrome,arc', '--agents', 'claude', '--profil', s.profil], s.env());
    expect(w.kod, w.stdout + w.stderr).toBe(0);
    const chrome = JSON.parse(readFileSync(join(s.profil, MANIFEST), 'utf8')) as { name: string; description: string; allowed_origins: string[]; path: string };
    const arc = JSON.parse(readFileSync(join(s.profil, 'przegladarki/arc', MANIFEST), 'utf8')) as typeof chrome;
    for (const manifest of [chrome, arc]) {
      expect(manifest.name).toBe('com.herestt.host');
      expect(manifest.description).toBe('Tryb uwag — host native messaging');
      expect(manifest.allowed_origins).toEqual([`chrome-extension://${ID_DEV}/`]);
      expect(manifest.path).toBe(join(s.profil, 'herestt/uruchom-host.sh'));
    }
    const config = JSON.parse(readFileSync(join(s.profil, 'herestt/config.json'), 'utf8')) as { idWtyczki: string; binarki: Record<string, string> };
    expect(config.idWtyczki).toBe(ID_DEV);
    expect(Object.keys(config.binarki).sort()).toEqual(['git', 'lsof']);
    const log = readFileSync(s.log, 'utf8').trim().split('\n');
    expect(log.filter(l => l.startsWith('codex') && !l.includes('tryb-uwag'))).toEqual([]);
    expect(log.filter(l => l.startsWith('claude mcp add --scope user herestt -- '))).toHaveLength(1);
    expect(log.filter(l => l.includes('mcp remove tryb-uwag --scope user'))).toHaveLength(1);
    expect(existsSync(join(s.magazyn, 'claude.herestt'))).toBe(true);
    expect(w.stdout).toContain(`Cofnięcie: npx heresthething@${WERSJA} undo`);
    expect(w.stdout).toContain(PROSBA_DO_AGENTA.pl);
    const dz = dziennik(s.profil);
    expect(dz.stan).toBe('zapis');
    expect(dz.idWtyczki).toBe(ID_DEV);
    expect(dz.wybor).toEqual({ przegladarki: ['chrome', 'arc'], agenci: ['claude'] });
    expect(dz.kroki.filter(k => k.rodzaj === 'manifest' && k.ok)).toHaveLength(2);
    expect(dz.kroki.filter(k => k.rodzaj === 'mcp').map(k => k.cel)).toEqual(['claude']);
  });

  it('--agents none nie woła CLI zapisu, tylko zdejmuje stary wpis', () => {
    const s = stanowisko(baza);
    expect(odpal(['--yes', '--browsers', 'chrome', '--agents', 'none', '--profil', s.profil], s.env()).kod).toBe(0);
    const log = readFileSync(s.log, 'utf8');
    expect(log).not.toContain('mcp add');
    expect(log).not.toContain('remove herestt');
  });

  it('R10 po zapisie dym z PATH launchd dostaje ping i jest krokiem dziennika', () => {
    const s = stanowisko(baza);
    const w = odpal(['--yes', '--browsers', 'chrome', '--agents', 'none', '--profil', s.profil], s.env());
    expect(w.kod).toBe(0);
    expect(w.stdout).toContain('test dymny: ping OK');
    expect(w.stdout).toContain('PATH launchd');
    expect(dziennik(s.profil).kroki.find(k => k.rodzaj === 'dym')?.ok).toBe(true);
  });

  it('zapis tylko po potwierdzeniu: Enter zapisuje, n i koniec wejścia nie', () => {
    const anuluj = stanowisko(baza, ['claude'], ['Google Chrome.app']);
    const n = odpal(['--profil', anuluj.profil], anuluj.env({ HERESTT_TTY: '1' }), '\n\nn\n');
    expect(n.kod).toBe(0);
    expect(n.stdout).toContain('Zapisać te zmiany? [Enter = zapisz, n = anuluj]');
    expect(migawka(anuluj.profil)).toEqual({});
    expect(readFileSync(anuluj.log, 'utf8')).toBe('');

    const eof = stanowisko(baza, ['claude'], ['Google Chrome.app']);
    const brak = odpal(['--profil', eof.profil], eof.env({ HERESTT_TTY: '1' }), '\n\n');
    expect(brak.kod).toBe(0);
    expect(brak.stdout).toContain('Brak odpowiedzi. Nic nie zapisano.');
    expect(migawka(eof.profil)).toEqual({});

    const zle = stanowisko(baza, ['claude'], ['Google Chrome.app']);
    const smiec = odpal(['--profil', zle.profil], zle.env({ HERESTT_TTY: '1' }), '\n\ntak\n');
    expect(smiec.kod).not.toBe(0);
    expect(migawka(zle.profil)).toEqual({});

    const tak = stanowisko(baza, ['claude'], ['Google Chrome.app']);
    const zapis = odpal(['--profil', tak.profil], tak.env({ HERESTT_TTY: '1' }), '\n\n\n');
    expect(zapis.kod, zapis.stdout).toBe(0);
    expect(zapis.stdout).toContain('Nic nie zostanie zapisane, dopóki nie potwierdzisz');
    expect(existsSync(join(tak.profil, MANIFEST))).toBe(true);
  });

  it('R8 katalog docelowy jako symlink: kod ≠ 0, cel bez zmian, zero plików', () => {
    const s = stanowisko(baza);
    const ofiara = join(s.home, 'ofiara');
    mkdirSync(ofiara);
    symlinkSync(ofiara, join(s.profil, 'herestt'));
    const w = odpal(['--yes', '--browsers', 'chrome,arc', '--agents', 'claude', '--profil', s.profil], s.env());
    expect(w.kod).not.toBe(0);
    expect(w.stdout).toContain('symlinkiem');
    expect(migawka(ofiara)).toEqual({});
    expect(migawka(s.profil)).toEqual({ herestt: `-> ${ofiara}` });
    expect(readFileSync(s.log, 'utf8')).toBe('');
  });

  it('R8 katalog manifestów drugiej przeglądarki jako symlink: odmowa przed pierwszym zapisem', () => {
    const s = stanowisko(baza);
    const ofiara = join(s.home, 'ofiara-manifestow');
    mkdirSync(ofiara);
    mkdirSync(join(s.profil, 'przegladarki/arc'), { recursive: true });
    symlinkSync(ofiara, join(s.profil, 'przegladarki/arc/NativeMessagingHosts'));
    const w = odpal(['--yes', '--browsers', 'chrome,arc', '--agents', 'none', '--profil', s.profil], s.env());
    expect(w.kod).not.toBe(0);
    expect(migawka(ofiara)).toEqual({});
    expect(existsSync(join(s.profil, 'herestt'))).toBe(false);
    expect(existsSync(join(s.profil, MANIFEST))).toBe(false);
  });

  it('R9 pad na drugim manifeście: zdanie częściowe, dziennik z jednym krokiem manifestu ok, undo zdejmuje tylko to', () => {
    const s = stanowisko(baza);
    const arcKatalog = join(s.profil, 'przegladarki/arc/NativeMessagingHosts');
    mkdirSync(arcKatalog, { recursive: true });
    chmodSync(arcKatalog, 0o555);
    try {
      const w = odpal(['--yes', '--browsers', 'chrome,arc', '--agents', 'claude', '--profil', s.profil], s.env());
      expect(w.kod).not.toBe(0);
      expect(w.stdout).toContain('Zapisano 1 z 3 zmian. undo cofnie je wszystkie');
      const dz = dziennik(s.profil);
      expect(dz.stan).toBe('czesciowy');
      expect(dz.kroki.filter(k => k.rodzaj === 'manifest' && k.ok)).toHaveLength(1);
      expect(dz.kroki.filter(k => k.rodzaj === 'manifest' && !k.ok)).toHaveLength(1);
      expect(readFileSync(s.log, 'utf8')).not.toContain('mcp add'); // po padzie nic dalej nie idzie
      expect(existsSync(join(s.profil, MANIFEST))).toBe(true);

      const undo = odpal(['undo', '--profil', s.profil], s.env());
      expect(undo.kod, undo.stdout).toBe(0);
      expect(existsSync(join(s.profil, MANIFEST))).toBe(false);
      expect(existsSync(join(s.profil, 'herestt/host.mjs'))).toBe(false);
      expect(dziennik(s.profil).stan).toBe('cofniecie');
    } finally {
      chmodSync(arcKatalog, 0o755);
    }
  });

  it('nieudane mcp add po manifestach: zdanie częściowe z licznikiem, kod ≠ 0, dziennik zna manifest', () => {
    const s = stanowisko(baza);
    const w = odpal(['--yes', '--browsers', 'chrome', '--agents', 'claude', '--profil', s.profil], s.env({ STUB_FAIL_ADD: '1' }));
    expect(w.kod).not.toBe(0);
    expect(w.stdout).toContain('Zapisano 1 z 2 zmian. undo cofnie je wszystkie');
    const dz = dziennik(s.profil);
    expect(dz.stan).toBe('czesciowy');
    expect(dz.kroki.find(k => k.rodzaj === 'mcp')?.ok).toBe(false);
  });

  it('zły plik sklepu: nic się nie zapisuje, nawet z --yes', () => {
    const s = stanowisko(baza);
    const plik = join(s.home, 'sklep.txt');
    writeFileSync(plik, 'ZZZ\n');
    const w = odpal(['--yes', '--browsers', 'chrome', '--agents', 'none', '--profil', s.profil], s.env({ HERESTT_PLIK_SKLEPU: plik }));
    expect(w.kod).not.toBe(0);
    expect(migawka(s.profil)).toEqual({});
  });

  it('R17 zapis zdejmuje ślady tryb-uwag: wpisy MCP u obu agentów, manifesty w pięciu przeglądarkach, katalog po kopii mapowań', () => {
    const s = stanowisko(baza);
    const wsparcie = join(s.home, 'Library/Application Support');
    const katalogi = ['Google/Chrome', 'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Arc/User Data', 'Vivaldi'];
    const cudzy = join(s.home, 'cudzy-manifest.json');
    writeFileSync(cudzy, 'cudzy');
    for (const k of katalogi) {
      mkdirSync(join(wsparcie, k, 'NativeMessagingHosts'), { recursive: true });
      writeFileSync(join(wsparcie, k, 'NativeMessagingHosts/pl.tryb_uwag.host.json'), '{}');
    }
    // Brave: dowiązanie zamiast pliku. Znika wskaźnik, cel zostaje.
    const brave = join(wsparcie, 'BraveSoftware/Brave-Browser/NativeMessagingHosts/pl.tryb_uwag.host.json');
    writeFileSync(join(wsparcie, 'BraveSoftware/Brave-Browser/NativeMessagingHosts/pl.tryb_uwag.host.json'), '{}');
    // wpisy starego serwera MCP w zaślepkach
    writeFileSync(join(s.magazyn, 'claude.tryb-uwag'), 'stary');
    writeFileSync(join(s.magazyn, 'codex.tryb-uwag'), 'stary');
    mkdirSync(join(s.home, '.config/tryb-uwag'), { recursive: true });
    writeFileSync(join(s.home, '.config/tryb-uwag/mapowania.json'), '{"wersja":1,"mapowania":{"a":"/b"}}\n');
    writeFileSync(join(s.home, '.config/tryb-uwag/host.log'), 'log');
    expect(brave).toContain('Brave');

    const w = odpal(['--yes', '--browsers', 'chrome', '--agents', 'none'], s.env());
    expect(w.kod, w.stdout + w.stderr).toBe(0);
    for (const k of katalogi) expect(existsSync(join(wsparcie, k, 'NativeMessagingHosts/pl.tryb_uwag.host.json'))).toBe(false);
    expect(existsSync(join(s.magazyn, 'claude.tryb-uwag'))).toBe(false);
    expect(existsSync(join(s.magazyn, 'codex.tryb-uwag'))).toBe(false);
    const log = readFileSync(s.log, 'utf8');
    expect(log).toContain('claude mcp remove tryb-uwag --scope user');
    expect(log).toContain('codex mcp remove tryb-uwag\n');
    expect(existsSync(join(s.home, '.config/tryb-uwag'))).toBe(false);
    expect(readFileSync(join(s.home, '.config/herestt/mapowania.json'), 'utf8')).toBe('{"wersja":1,"mapowania":{"a":"/b"}}\n');
    expect(existsSync(join(wsparcie, 'Google/Chrome', MANIFEST))).toBe(true);
    expect(readFileSync(cudzy, 'utf8')).toBe('cudzy');
  });

  it('R17 dowiązanie w miejscu starego manifestu i starego katalogu: znika wskaźnik, cel zostaje', () => {
    const s = stanowisko(baza);
    const cel = join(s.home, 'cel-manifestu.json');
    const celKatalog = join(s.home, 'cel-katalogu');
    writeFileSync(cel, 'zostaje');
    mkdirSync(celKatalog);
    writeFileSync(join(celKatalog, 'mapowania.json'), 'zostaje-tez');
    mkdirSync(join(s.profil, 'NativeMessagingHosts'), { recursive: true });
    symlinkSync(cel, join(s.profil, 'NativeMessagingHosts/pl.tryb_uwag.host.json'));
    symlinkSync(celKatalog, join(s.profil, 'tryb-uwag'));
    const w = odpal(['--yes', '--browsers', 'chrome', '--agents', 'none', '--profil', s.profil], s.env());
    expect(w.kod, w.stdout).toBe(0);
    expect(() => lstatSync(join(s.profil, 'NativeMessagingHosts/pl.tryb_uwag.host.json'))).toThrow();
    expect(() => lstatSync(join(s.profil, 'tryb-uwag'))).toThrow();
    expect(readFileSync(cel, 'utf8')).toBe('zostaje');
    expect(readFileSync(join(celKatalog, 'mapowania.json'), 'utf8')).toBe('zostaje-tez');
    expect(existsSync(join(s.profil, 'herestt/mapowania.json'))).toBe(false);
  });

  it('powtórny zapis jest stanem docelowym: dziennik się aktualizuje, a wypadająca przeglądarka schodzi', () => {
    const s = stanowisko(baza);
    expect(odpal(['--yes', '--browsers', 'chrome', '--agents', 'none', '--profil', s.profil], s.env()).kod).toBe(0);
    expect(odpal(['--yes', '--browsers', 'arc', '--agents', 'none', '--profil', s.profil], s.env()).kod).toBe(0);
    expect(dziennik(s.profil).kroki.filter(k => k.rodzaj === 'manifest').map(k => k.cel)).toEqual([join(s.profil, 'przegladarki/arc', MANIFEST)]);
    expect(existsSync(join(s.profil, MANIFEST))).toBe(false);
    expect(bezKluczy({ a: '1' }, 'a')).toEqual({});
  });
});
