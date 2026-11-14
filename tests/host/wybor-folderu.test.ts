import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { obsluzZadanie, type Kontekst } from '../../src/host/dyspozytor';
import { wybierzFolder } from '../../src/host/projekt';
import { osascriptWybierzFolder } from '../../src/host/uruchom';
import { binarkiPrawdziwe, katalogTymczasowy, nowyRepo } from './pomocnicze';

const baza = katalogTymczasowy();
const ID = 'hlpoejokkmdlocmplaodddcgcimfmpoi';
let n = 0;

/**
 * Fałszywy osascript: zapisuje argv i odtwarza nagraną odpowiedź albo śpi.
 * Dowodzi NASZEJ strony (argv, kody, limit czasu); prawdziwego okna nie otwieramy.
 */
function falszywyOsascript(kodWyjscia: number, stdout: string, stderr: string, spijMs = 0): { sciezka: string; zapis: string } {
  const k = join(baza, `osascript-${n++}`);
  mkdirSync(k);
  const zapis = join(k, 'wywolanie.json');
  const sciezka = join(k, 'osascript');
  writeFileSync(
    sciezka,
    `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(zapis)}, JSON.stringify(process.argv.slice(2)));\n` +
      `setTimeout(()=>{process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(${kodWyjscia})},${spijMs});\n`,
  );
  chmodSync(sciezka, 0o755);
  return { sciezka, zapis };
}

describe('osascriptWybierzFolder', () => {
  it('zwraca ścieżkę bez końcowego ukośnika, a prompt idzie jako argument po `--`, nie w treści skryptu', async () => {
    const f = falszywyOsascript(0, '/home/ktos/dev/projekt/\n', '');
    const prompt = 'Wybierz "folder" -x; do shell script "rm -rf /"';
    expect(await osascriptWybierzFolder(f.sciezka, prompt, 5000)).toBe('/home/ktos/dev/projekt');
    const argv = JSON.parse(readFileSync(f.zapis, 'utf8')) as string[];
    expect(argv.slice(-2)).toEqual(['--', prompt]);
    const skrypt = argv.filter((_, i) => argv[i - 1] === '-e').join('\n');
    expect(skrypt).not.toContain('rm -rf');
    expect(skrypt).toContain('choose folder with prompt (item 1 of argv)');
  });

  it('korzeń dysku zostaje „/”', async () => {
    expect(await osascriptWybierzFolder(falszywyOsascript(0, '/\n', '').sciezka, 'x', 5000)).toBe('/');
  });

  it('anulowanie (-128) to null, nie błąd', async () => {
    const f = falszywyOsascript(1, '', '0:5: execution error: User canceled. (-128)\n');
    expect(await osascriptWybierzFolder(f.sciezka, 'x', 5000)).toBeNull();
  });

  it('inny błąd osascript to wewnetrzny', async () => {
    const f = falszywyOsascript(1, '', 'syntax error (-2741)\n');
    await expect(osascriptWybierzFolder(f.sciezka, 'x', 5000)).rejects.toMatchObject({ kod: 'wewnetrzny' });
  });

  it('limit czasu zabija proces i daje wewnetrzny z informacją o czasie', async () => {
    const f = falszywyOsascript(0, '/x\n', '', 10_000);
    await expect(osascriptWybierzFolder(f.sciezka, 'x', 150)).rejects.toMatchObject({ kod: 'wewnetrzny', message: expect.stringContaining('przekroczony czas 150') });
  });

  it('pusta odpowiedź przy kodzie 0 to błąd, nie „wybrano pusty folder”', async () => {
    await expect(osascriptWybierzFolder(falszywyOsascript(0, '\n', '').sciezka, 'x', 5000)).rejects.toMatchObject({ kod: 'wewnetrzny' });
  });
});

describe('wybierzFolder (walidacja)', () => {
  const b = { ...binarkiPrawdziwe(), osascript: falszywyOsascript(0, '/a/b/\n', '').sciezka };

  it.each([[42], [''], ['x'.repeat(201)], ['a\0b'], [undefined]])('zły prompt %j → zadanie_niepoprawne', async prompt => {
    await expect(wybierzFolder(b, prompt)).rejects.toMatchObject({ kod: 'zadanie_niepoprawne' });
  });

  describe('poza macOS', () => {
    const oryginal = Object.getOwnPropertyDescriptor(process, 'platform')!;
    afterEach(() => Object.defineProperty(process, 'platform', oryginal));

    it('bez jawnej binarki odmawia jak starszy host (zadanie_niepoprawne)', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      await expect(wybierzFolder(binarkiPrawdziwe(), 'x')).rejects.toMatchObject({ kod: 'zadanie_niepoprawne' });
    });
  });
});

describe('zadanie wybierz_folder w dyspozytorze', () => {
  const katalog = join(baza, 'konf');
  mkdirSync(katalog, { mode: 0o700 });
  const kontekst = (osascript: string): Kontekst => ({ katalog, konfiguracja: { wersja: 1, idWtyczki: ID, binarki: { ...binarkiPrawdziwe(), osascript } } });
  const zadanie = (extra: object = {}) => ({ typ: 'wybierz_folder', prompt: 'Wybierz', wersja: 2, idZadania: 'z1', zakres: { od: 2, do: 2 }, ...extra });

  it('wybór → ok z folderem; anulowanie → folder null', async () => {
    expect(await obsluzZadanie(kontekst(falszywyOsascript(0, '/x/y/\n', '').sciezka), zadanie())).toMatchObject({ ok: true, typ: 'wybierz_folder', folder: '/x/y' });
    expect(await obsluzZadanie(kontekst(falszywyOsascript(1, '', '(-128)').sciezka), zadanie())).toMatchObject({ ok: true, typ: 'wybierz_folder', folder: null });
  });

  it('błąd osascript → ok:false wewnetrzny', async () => {
    expect(await obsluzZadanie(kontekst(falszywyOsascript(1, '', 'boom').sciezka), zadanie())).toMatchObject({ ok: false, kod: 'wewnetrzny' });
  });

  it('nieistniejący folder to projekt_nie_istnieje, a nie-git projekt_nie_git (osobne kody)', async () => {
    const k = kontekst('/usr/bin/false');
    const mapuj = (projekt: string) => obsluzZadanie(k, { typ: 'mapuj', origin: 'https://x.pl', projekt, wersja: 2, idZadania: 'z2', zakres: { od: 2, do: 2 } });
    const bezGit = join(baza, 'bez-git');
    mkdirSync(bezGit);
    expect(await mapuj(join(baza, 'nie-ma'))).toMatchObject({ ok: false, kod: 'projekt_nie_istnieje' });
    expect(await mapuj(bezGit)).toMatchObject({ ok: false, kod: 'projekt_nie_git' });
  });

  it('podfolder repo: błąd niesie korzeń repozytorium', async () => {
    const repo = nowyRepo(baza, 'repo-korzen');
    mkdirSync(join(repo, 'src'));
    const odp = await obsluzZadanie(kontekst('/usr/bin/false'), { typ: 'mapuj', origin: 'https://x.pl', projekt: join(repo, 'src'), wersja: 2, idZadania: 'z3', zakres: { od: 2, do: 2 } });
    expect(odp).toMatchObject({ ok: false, kod: 'projekt_nie_toplevel', korzen: repo });
  });
});
