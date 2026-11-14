import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { bezKluczy, migawka, migawkaStanowiska, odpal, stanowisko, type Stanowisko } from './instalator-pomocnicze';
import { katalogTymczasowy, zbudujDistDlaTestow } from './pomocnicze';

vi.setConfig({ testTimeout: 60_000 });

const baza = katalogTymczasowy('uwagi-instalator-undo-');
const MANIFEST = 'NativeMessagingHosts/com.herestt.host.json';
const DANE = ['herestt/mapowania.json', 'herestt/host.log', 'herestt/instalacja.json'];

interface Dz {
  stan: string;
  kroki: Array<{ rodzaj: string; cel: string; ok: boolean }>;
}
const dziennik = (profil: string): Dz => JSON.parse(readFileSync(join(profil, 'herestt/instalacja.json'), 'utf8')) as Dz;

/** Stan sprzed zapisu: obcy manifest, projekt z `.herestt/`, cudzy wpis MCP w zaślepce. */
function przygotuj(): Stanowisko {
  const s = stanowisko(baza);
  mkdirSync(join(s.profil, 'NativeMessagingHosts'), { recursive: true });
  writeFileSync(join(s.profil, 'NativeMessagingHosts/obcy.json'), '{"obcy":true}\n');
  mkdirSync(join(s.home, 'projekt/.herestt'), { recursive: true });
  writeFileSync(join(s.home, 'projekt/.herestt/uwagi.md'), 'uwaga\n');
  writeFileSync(join(s.magazyn, 'claude.cudzy'), 'cudzy wpis\n');
  return s;
}

function zapisz(s: Stanowisko, przegladarki = 'chrome,arc', agenci = 'claude'): void {
  const w = odpal(['--yes', '--browsers', przegladarki, '--agents', agenci, '--profil', s.profil], s.env());
  expect(w.kod, w.stdout + w.stderr).toBe(0);
}

beforeAll(() => zbudujDistDlaTestow(), 120_000);

describe('instalator, faza 2: undo', () => {
  it('R11 undo zostawia mapowania, log i dziennik (stan cofniecie); reszta wraca bajt w bajt', () => {
    const s = przygotuj();
    const przed = migawkaStanowiska(s);
    const wpisyPrzed = migawka(s.magazyn);
    zapisz(s);
    writeFileSync(join(s.profil, 'herestt/mapowania.json'), '{"wersja":1,"mapowania":{}}\n');
    writeFileSync(join(s.profil, 'herestt/host.log'), 'log\n');
    expect(odpal(['undo', '--profil', s.profil], s.env()).kod).toBe(0);
    const po = migawkaStanowiska(s);
    expect(bezKluczy(po, ...DANE.map(d => `profil/${d}`))).toEqual(przed);
    expect(po['profil/herestt/mapowania.json']).toBe('{"wersja":1,"mapowania":{}}\n');
    expect(po['profil/herestt/host.log']).toBe('log\n');
    expect(dziennik(s.profil).stan).toBe('cofniecie');
    expect(dziennik(s.profil).kroki).toEqual([]);
    // wpis herestt zdjęty z zaślepki, cudzy zostaje, projekt nietknięty
    expect(migawka(s.magazyn)).toEqual(wpisyPrzed);
    expect(readFileSync(join(s.home, 'projekt/.herestt/uwagi.md'), 'utf8')).toBe('uwaga\n');
    expect(readFileSync(join(s.profil, 'NativeMessagingHosts/obcy.json'), 'utf8')).toBe('{"obcy":true}\n');
    expect(readFileSync(s.log, 'utf8')).toContain('claude mcp remove herestt --scope user');
  });

  it('R12 undo --all kasuje też mapowania, log i dziennik: stan jak przed zapisem', () => {
    const s = przygotuj();
    const przed = migawkaStanowiska(s);
    zapisz(s);
    writeFileSync(join(s.profil, 'herestt/mapowania.json'), '{}\n');
    writeFileSync(join(s.profil, 'herestt/host.log'), 'log\n');
    writeFileSync(join(s.profil, 'herestt/host.log.1'), 'log1\n');
    const w = odpal(['undo', '--all', '--profil', s.profil], s.env());
    expect(w.kod, w.stdout).toBe(0);
    expect(migawkaStanowiska(s)).toEqual(przed);
    expect(existsSync(join(s.profil, 'herestt'))).toBe(false);
  });

  it('R13 brak dziennika: tylko Chrome i pliki programu, mapowania i log zostają', () => {
    const s = przygotuj();
    zapisz(s);
    rmSync(join(s.profil, 'herestt/instalacja.json'));
    writeFileSync(join(s.profil, 'herestt/mapowania.json'), '{}\n');
    writeFileSync(join(s.profil, 'herestt/host.log'), 'log\n');
    const w = odpal(['undo', '--profil', s.profil], s.env());
    expect(w.kod, w.stdout).toBe(0);
    expect(existsSync(join(s.profil, MANIFEST))).toBe(false);
    for (const plik of ['host.mjs', 'mcp.mjs', 'uruchom-host.sh', 'config.json']) expect(existsSync(join(s.profil, 'herestt', plik))).toBe(false);
    // Arc nie jest w zestawie sprzed dziennika, więc zostaje; obcy manifest też.
    expect(existsSync(join(s.profil, 'przegladarki/arc', MANIFEST))).toBe(true);
    expect(existsSync(join(s.profil, 'NativeMessagingHosts/obcy.json'))).toBe(true);
    expect(readFileSync(join(s.profil, 'herestt/mapowania.json'), 'utf8')).toBe('{}\n');
    expect(readFileSync(join(s.profil, 'herestt/host.log'), 'utf8')).toBe('log\n');
    const log = readFileSync(s.log, 'utf8');
    expect(log).toContain('claude mcp remove herestt --scope user');
    expect(log).toContain('codex mcp remove herestt\n');
  });

  it('R13/R17 brak dziennika sprząta też starą nazwę, po kopii mapowań', () => {
    const s = stanowisko(baza);
    mkdirSync(join(s.profil, 'tryb-uwag'), { recursive: true });
    writeFileSync(join(s.profil, 'tryb-uwag/mapowania.json'), 'stare\n');
    mkdirSync(join(s.profil, 'NativeMessagingHosts'), { recursive: true });
    writeFileSync(join(s.profil, 'NativeMessagingHosts/pl.tryb_uwag.host.json'), '{}');
    writeFileSync(join(s.magazyn, 'claude.tryb-uwag'), 'stary');
    const w = odpal(['undo', '--profil', s.profil], s.env());
    expect(w.kod, w.stdout).toBe(0);
    expect(existsSync(join(s.profil, 'tryb-uwag'))).toBe(false);
    expect(existsSync(join(s.profil, 'NativeMessagingHosts/pl.tryb_uwag.host.json'))).toBe(false);
    expect(existsSync(join(s.magazyn, 'claude.tryb-uwag'))).toBe(false);
    expect(readFileSync(join(s.profil, 'herestt/mapowania.json'), 'utf8')).toBe('stare\n');
  });

  it('plik zmieniony po zapisie zostaje: undo mówi, co zrobić, kod ≠ 0, reszta zdjęta', () => {
    const s = przygotuj();
    zapisz(s);
    const arc = join(s.profil, 'przegladarki/arc', MANIFEST);
    writeFileSync(arc, '{"edytowany":true}\n');
    const w = odpal(['undo', '--profil', s.profil], s.env());
    expect(w.kod).not.toBe(0);
    expect(w.stdout).toContain(arc);
    expect(w.stdout).toContain('zmieniono po zapisie');
    expect(w.stdout).toContain('usuń go ręcznie');
    expect(readFileSync(arc, 'utf8')).toBe('{"edytowany":true}\n');
    expect(existsSync(join(s.profil, MANIFEST))).toBe(false);
    expect(existsSync(join(s.profil, 'herestt/host.mjs'))).toBe(false);
    expect(dziennik(s.profil).kroki.map(k => k.cel)).toEqual([arc]);
    // po ręcznym usunięciu drugie undo kończy się czysto
    rmSync(arc);
    expect(odpal(['undo', '--profil', s.profil], s.env()).kod).toBe(0);
  });

  it('uszkodzony dziennik: program nie pada, cofa zestaw podstawowy i mówi o dzienniku; --all go kasuje', () => {
    const s = przygotuj();
    zapisz(s, 'chrome', 'none');
    writeFileSync(join(s.profil, 'herestt/instalacja.json'), '{ to nie jest json');
    const w = odpal(['undo', '--profil', s.profil], s.env());
    expect(w.kod, w.stdout + w.stderr).toBe(0);
    expect(w.stdout).toContain('Dziennik instalacja.json jest uszkodzony');
    expect(w.stderr).not.toContain('at ');
    expect(existsSync(join(s.profil, MANIFEST))).toBe(false);
    expect(readFileSync(join(s.profil, 'herestt/instalacja.json'), 'utf8')).toBe('{ to nie jest json');
    expect(odpal(['undo', '--all', '--profil', s.profil], s.env()).kod).toBe(0);
    expect(existsSync(join(s.profil, 'herestt'))).toBe(false);
  });

  it('uszkodzony dziennik nie blokuje nowego zapisu', () => {
    const s = stanowisko(baza);
    mkdirSync(join(s.profil, 'herestt'), { recursive: true });
    writeFileSync(join(s.profil, 'herestt/instalacja.json'), 'śmieci');
    const w = odpal(['--yes', '--browsers', 'chrome', '--agents', 'none', '--profil', s.profil], s.env());
    expect(w.kod, w.stdout + w.stderr).toBe(0);
    expect(w.stdout).toContain('jest uszkodzony');
    expect(dziennik(s.profil).stan).toBe('zapis');
  });

  it('symlink na drodze: odmowa, kod ≠ 0, nic nie jest kasowane', () => {
    const s = przygotuj();
    zapisz(s);
    const arcKatalog = join(s.profil, 'przegladarki/arc/NativeMessagingHosts');
    const logPrzed = readFileSync(s.log, 'utf8');
    const ofiara = join(s.home, 'ofiara');
    mkdirSync(ofiara);
    writeFileSync(join(ofiara, 'com.herestt.host.json'), 'cudzy');
    rmSync(arcKatalog, { recursive: true });
    symlinkSync(ofiara, arcKatalog);
    const w = odpal(['undo', '--profil', s.profil], s.env());
    expect(w.kod).not.toBe(0);
    expect(w.stdout).toContain('symlinkiem');
    expect(readFileSync(join(ofiara, 'com.herestt.host.json'), 'utf8')).toBe('cudzy');
    expect(existsSync(join(s.profil, MANIFEST))).toBe(true);
    expect(existsSync(join(s.profil, 'herestt/host.mjs'))).toBe(true);
    expect(readFileSync(s.log, 'utf8')).toBe(logPrzed);

    // symlink zamiast katalogu programu
    const s2 = przygotuj();
    zapisz(s2, 'chrome', 'none');
    const cel = join(s2.home, 'przeniesiony');
    mkdirSync(join(s2.profil, 'herestt'), { recursive: true });
    rmSync(join(s2.profil, 'herestt'), { recursive: true });
    mkdirSync(cel);
    writeFileSync(join(cel, 'config.json'), 'cudzy');
    symlinkSync(cel, join(s2.profil, 'herestt'));
    const w2 = odpal(['undo', '--profil', s2.profil], s2.env());
    expect(w2.kod).not.toBe(0);
    expect(readFileSync(join(cel, 'config.json'), 'utf8')).toBe('cudzy');
  });

  it('wpis dziennika spoza naszych miejsc jest pomijany, a plik zostaje', () => {
    const s = przygotuj();
    zapisz(s, 'chrome', 'none');
    const cudzy = join(s.home, 'cudzy-plik.txt');
    writeFileSync(cudzy, 'nie ruszać');
    const dz = dziennik(s.profil);
    dz.kroki.push({ rodzaj: 'plik', cel: cudzy, ok: true });
    writeFileSync(join(s.profil, 'herestt/instalacja.json'), JSON.stringify({ ...dz, wersja: 1 }));
    const w = odpal(['undo', '--profil', s.profil], s.env());
    expect(w.kod, w.stdout).toBe(0);
    expect(readFileSync(cudzy, 'utf8')).toBe('nie ruszać');
  });

  it('brak CLI agenta przy undo: instrukcja ręcznego usunięcia, kod ≠ 0, reszta zdjęta', () => {
    const s = przygotuj();
    zapisz(s, 'chrome', 'claude');
    rmSync(join(s.bin, 'claude'));
    const w = odpal(['undo', '--profil', s.profil], s.env());
    expect(w.kod).not.toBe(0);
    expect(w.stdout).toContain('claude mcp remove herestt --scope user');
    expect(existsSync(join(s.profil, MANIFEST))).toBe(false);
    chmodSync(s.profil, 0o755);
  });

  it('undo --dry-run niczego nie usuwa', () => {
    const s = przygotuj();
    zapisz(s);
    const przed = migawkaStanowiska(s);
    const wpisy = migawka(s.magazyn);
    const w = odpal(['undo', '--dry-run', '--profil', s.profil], s.env());
    expect(w.kod).toBe(0);
    expect(w.stdout).toContain(join(s.profil, MANIFEST));
    expect(migawkaStanowiska(s)).toEqual(przed);
    expect(migawka(s.magazyn)).toEqual(wpisy);
  });
});

describe('instalator, faza 3: ponowny przebieg', () => {
  it('R14 drugi podgląd przy dzienniku z chrome pokazuje dopisanie arc i nic nie zapisuje', () => {
    const s = przygotuj();
    zapisz(s, 'chrome', 'none');
    const przed = migawkaStanowiska(s);
    const w = odpal(['--dry-run', '--yes', '--browsers', 'chrome,arc', '--agents', 'none', '--profil', s.profil], s.env());
    expect(w.kod, w.stdout).toBe(0);
    expect(w.stdout).toContain('Poprzedni zapis: przeglądarki chrome; agenci —');
    expect(w.stdout).toContain(`+ Arc: ${join(s.profil, 'przegladarki/arc', MANIFEST)}`);
    expect(w.stdout).not.toContain('- Chrome');
    expect(migawkaStanowiska(s)).toEqual(przed);
  });

  it('domyślny wybór bierze się z dziennika, zapis aktualizuje go zamiast dokładać drugi', () => {
    const s = przygotuj();
    zapisz(s, 'chrome', 'claude');
    // bez --agents: claude zostaje z poprzedniego wyboru
    const w = odpal(['--yes', '--browsers', 'chrome,arc', '--profil', s.profil], s.env());
    expect(w.kod, w.stdout + w.stderr).toBe(0);
    const dz = dziennik(s.profil) as Dz & { wybor: { przegladarki: string[]; agenci: string[] } };
    expect(dz.wybor).toEqual({ przegladarki: ['chrome', 'arc'], agenci: ['claude'] });
    expect(dz.kroki.filter(k => k.rodzaj === 'manifest')).toHaveLength(2);
    expect(dz.kroki.filter(k => k.rodzaj === 'mcp')).toHaveLength(1);
    // zdjęcie: arc i claude wypadają, manifest i wpis znikają
    const zdjecie = odpal(['--yes', '--browsers', 'chrome', '--agents', 'none', '--profil', s.profil], s.env());
    expect(zdjecie.kod, zdjecie.stdout).toBe(0);
    expect(existsSync(join(s.profil, 'przegladarki/arc', MANIFEST))).toBe(false);
    expect(existsSync(join(s.magazyn, 'claude.herestt'))).toBe(false);
    expect(existsSync(join(s.magazyn, 'claude.cudzy'))).toBe(true);
    expect(dziennik(s.profil).kroki.filter(k => k.rodzaj === 'manifest' || k.rodzaj === 'mcp')).toHaveLength(1);
  });

  it('podgląd pokazuje zdejmowanie; po undo albo bez dziennika domyślne wracają do fazy 1', () => {
    const s = przygotuj();
    zapisz(s, 'chrome,arc', 'claude');
    const w = odpal(['--dry-run', '--yes', '--browsers', 'chrome', '--agents', 'none', '--profil', s.profil], s.env());
    expect(w.stdout).toContain(`- Arc: ${join(s.profil, 'przegladarki/arc', MANIFEST)}`);
    expect(w.stdout).toContain('- Claude Code');
    expect(odpal(['undo', '--profil', s.profil], s.env()).kod).toBe(0);
    const po = odpal(['--dry-run', '--yes', '--browsers', 'chrome', '--profil', s.profil], s.env());
    expect(po.stdout).not.toContain('Poprzedni zapis');
    expect(po.stdout).toContain('claude mcp add');
  });
});

