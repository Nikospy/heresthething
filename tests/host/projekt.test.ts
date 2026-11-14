import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mapuj, parsujOrigin, projektDlaOriginu, rozpoznaj, wewnatrz, zweryfikujProjekt } from '../../src/host/projekt';
import { zapiszMapowanie } from '../../src/host/mapowania';
import { binarkiPrawdziwe, katalogTymczasowy, nowyRepo } from './pomocnicze';

const baza = katalogTymczasowy();
const b = binarkiPrawdziwe();
const procesy: ChildProcess[] = [];
afterAll(() => procesy.forEach(p => p.kill()));

/** Prawdziwy proces nasłuchujący z podanym cwd — tak resolve widzi `next dev` czy Vite. */
async function serwer(cwd: string, host: string, port = 0): Promise<{ port: number; proces: ChildProcess }> {
  const proces = spawn(process.execPath, ['-e', `const s=require('http').createServer().listen(${port},${JSON.stringify(host)},()=>console.log(s.address().port))`], { cwd });
  procesy.push(proces);
  const p = await new Promise<number>(r => proces.stdout!.once('data', d => r(Number(String(d).trim()))));
  return { port: p, proces };
}

let n = 0;
function katalogKonfiguracji(): string {
  const k = join(baza, `konf-${n++}`);
  mkdirSync(k, { mode: 0o700 });
  return k;
}

describe('wewnatrz', () => {
  it('porównuje po granicy komponentu, nie prefiksie napisu', () => {
    expect(wewnatrz('/a/proj', '/a/proj/src')).toBe(true);
    expect(wewnatrz('/a/proj', '/a/proj')).toBe(true);
    expect(wewnatrz('/a/proj', '/a/proj-2')).toBe(false);
  });
});

describe('zweryfikujProjekt', () => {
  const repo = nowyRepo(baza, 'repo');
  mkdirSync(join(repo, 'src'));

  it('przyjmuje toplevel, także przez symlink (zwraca realpath)', async () => {
    symlinkSync(repo, join(baza, 'link'));
    expect(await zweryfikujProjekt(b, join(baza, 'link'))).toBe(repo);
  });

  it.each([
    ['względny', 'repo', 'zadanie_niepoprawne'],
    ['z NUL', `${repo}\0x`, 'zadanie_niepoprawne'],
    ['za długi', `/${'a'.repeat(2000)}`, 'zadanie_niepoprawne'],
    ['nie string', 42, 'zadanie_niepoprawne'],
    ['nieistniejący', join(baza, 'brak'), 'projekt_nie_istnieje'],
    ['podkatalog repo', join(repo, 'src'), 'projekt_nie_toplevel'],
    ['`..` wychodzące z repo', join(repo, 'src', '..', '..'), 'projekt_nie_git'],
  ])('odrzuca %s', async (_opis, wejscie, kod) => {
    await expect(zweryfikujProjekt(b, wejscie)).rejects.toMatchObject({ kod });
  });
});

describe('parsujOrigin', () => {
  it.each([
    ['http://localhost:3000', true, 3000],
    ['http://127.0.0.1:5173', true, 5173],
    ['http://[::1]:8080', true, 8080],
    ['http://app.localhost:3000', true, 3000],
    ['https://staging.mewitz.pl', false, 443],
    ['http://localhost', true, 80],
  ])('%s → lokalny=%s port=%s', (o, lokalny, port) => {
    expect(parsujOrigin(o)).toMatchObject({ origin: o, lokalny, port });
  });

  it.each(['file:///etc', 'chrome://extensions', 'http://localhost:3000/strona', 'http://a@localhost:3000', 'http://LOCALHOST:3000', 'javascript:alert(1)', '', 'x'.repeat(3000), null])(
    'odrzuca %s',
    o => {
      expect(() => parsujOrigin(o)).toThrow(expect.objectContaining({ kod: 'origin_niepoprawny' }));
    },
  );
});

describe('rozpoznaj + mapuj (reguła H3)', () => {
  const repoA = nowyRepo(baza, 'apka-a');
  const repoB = nowyRepo(baza, 'apka-b');
  mkdirSync(join(repoA, 'apps', 'web'), { recursive: true });

  it('pierwsze użycie localhost: propozycja z lsof, bez projektu; potem mapuj → mapowanie bez pytania', async () => {
    const konf = katalogKonfiguracji();
    const { port } = await serwer(join(repoA, 'apps', 'web'), '127.0.0.1');
    const origin = `http://localhost:${port}`;
    expect(await rozpoznaj(b, konf, origin)).toEqual({ projekt: null, zrodlo: 'lsof', kandydaci: [repoA] });
    await expect(projektDlaOriginu(b, konf, origin)).rejects.toMatchObject({ kod: 'projekt_nieznany' });

    expect(await mapuj(b, konf, origin, repoA)).toBe(repoA);
    expect(await rozpoznaj(b, konf, origin)).toEqual({ projekt: repoA, zrodlo: 'mapowanie', kandydaci: [repoA] });
    expect(await projektDlaOriginu(b, konf, origin)).toBe(repoA);
  });

  it('serwer na porcie zmienił repo → mapowanie nieużyte, znowu propozycja, z konkretnym komunikatem', async () => {
    const konf = katalogKonfiguracji();
    const a = await serwer(repoA, '127.0.0.1');
    const origin = `http://localhost:${a.port}`;
    await mapuj(b, konf, origin, repoA);
    a.proces.kill();
    await new Promise(r => a.proces.once('exit', r));
    await serwer(repoB, '127.0.0.1', a.port);
    expect(await rozpoznaj(b, konf, origin)).toEqual({ projekt: null, zrodlo: 'lsof', kandydaci: [repoB] });
    await expect(projektDlaOriginu(b, konf, origin)).rejects.toMatchObject({ kod: 'projekt_nieznany', message: expect.stringContaining('innego repozytorium') });
  });

  it('serwer zatrzymany, port pusty → mapowanie dalej obowiązuje (W3)', async () => {
    const konf = katalogKonfiguracji();
    const a = await serwer(repoA, '127.0.0.1');
    const origin = `http://localhost:${a.port}`;
    await mapuj(b, konf, origin, repoA);
    a.proces.kill();
    await new Promise(r => a.proces.once('exit', r));
    expect(await rozpoznaj(b, konf, origin)).toEqual({ projekt: repoA, zrodlo: 'mapowanie', kandydaci: [] });
    expect(await projektDlaOriginu(b, konf, origin)).toBe(repoA);
  });

  it('dwa procesy na tym samym porcie (IPv4 + IPv6) z różnych repo → obaj kandydaci, bez zgadywania', async () => {
    const konf = katalogKonfiguracji();
    const { port } = await serwer(repoA, '127.0.0.1');
    await serwer(repoB, '::1', port);
    const origin = `http://localhost:${port}`;
    await mapuj(b, konf, origin, repoA);
    expect(await rozpoznaj(b, konf, origin)).toEqual({ projekt: null, zrodlo: 'lsof', kandydaci: [repoA, repoB].sort() });
  });

  it('mapuj dla localhost odmawia repo, którego serwer nie działa na porcie', async () => {
    const konf = katalogKonfiguracji();
    const { port } = await serwer(repoA, '127.0.0.1');
    await expect(mapuj(b, konf, `http://localhost:${port}`, repoB)).rejects.toMatchObject({ kod: 'projekt_nieznany' });
  });

  it('origin zdalny: brak → mapuj → mapowanie; plik mapowań 0600', async () => {
    const konf = katalogKonfiguracji();
    const origin = 'https://staging.przyklad.pl';
    expect(await rozpoznaj(b, konf, origin)).toEqual({ projekt: null, zrodlo: 'brak', kandydaci: [] });
    await mapuj(b, konf, origin, repoB);
    expect(await projektDlaOriginu(b, konf, origin)).toBe(repoB);
    const { statSync } = await import('node:fs');
    expect(statSync(join(konf, 'mapowania.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(konf, 'mapowania.json'), 'utf8'))).toEqual({ wersja: 1, mapowania: { [origin]: repoB } });
  });

  it('zmapowany projekt, który przestał być repo, nie przechodzi', async () => {
    const konf = katalogKonfiguracji();
    const nieRepo = join(baza, 'kiedys-repo');
    mkdirSync(nieRepo);
    writeFileSync(join(konf, 'mapowania.json'), JSON.stringify({ wersja: 1, mapowania: { 'https://x.pl': nieRepo } }));
    chmodSync(join(konf, 'mapowania.json'), 0o600);
    await expect(projektDlaOriginu(b, konf, 'https://x.pl')).rejects.toMatchObject({ kod: 'projekt_nie_git' });
  });

  it('uszkodzony plik mapowań to błąd, nie cichy reset', async () => {
    const konf = katalogKonfiguracji();
    writeFileSync(join(konf, 'mapowania.json'), '{zepsute');
    await expect(rozpoznaj(b, konf, 'https://x.pl')).rejects.toMatchObject({ kod: 'konfiguracja' });
  });
});

describe('ślepe lsof nie uznaje mapowania (przegląd W3)', () => {
  const repoC = nowyRepo(baza, 'apka-c');
  const repoD = nowyRepo(baza, 'apka-d');

  /** Fałszywy lsof: port zawsze „słucha” na PID 99999, którego cwd nie da się odczytać. */
  function slepyLsof(skrypt: string): string {
    const p = join(baza, `lsof-${Math.random().toString(36).slice(2)}`);
    writeFileSync(p, `#!/bin/sh\n${skrypt}`);
    chmodSync(p, 0o755);
    return p;
  }

  it('kod wyjścia inny niż 0/1: błąd zamiast ufnego przyjęcia mapowania', async () => {
    const konf = katalogKonfiguracji();
    const { port } = await serwer(repoC, '127.0.0.1');
    const origin = `http://localhost:${port}`;
    await mapuj(b, konf, origin, repoC);
    const slepy = { ...b, lsof: slepyLsof('exit 3') };
    await expect(rozpoznaj(slepy, konf, origin)).rejects.toMatchObject({ kod: 'wewnetrzny' });
    await expect(projektDlaOriginu(slepy, konf, origin)).rejects.toMatchObject({ kod: 'wewnetrzny' });
  });

  it('żywy obcy serwer, PID bez czytelnego cwd: kandydaci nieznani, mapowanie nie wystarcza', async () => {
    const konf = katalogKonfiguracji();
    const { port } = await serwer(repoD, '127.0.0.1');
    const origin = `http://localhost:${port}`;
    await zapiszMapowanie(konf, origin, repoC); // stare mapowanie mówi repoC, serwuje repoD
    const slepy = { ...b, lsof: slepyLsof(`
      for a in "$@"; do [ "$a" = "-Fp" ] && { echo p99999; exit 0; }; done
      case "$*" in *"-p 99999"*) exit 1;; esac
      exit 1`) };
    expect(await rozpoznaj(slepy, konf, origin)).toEqual({ projekt: null, zrodlo: 'lsof', kandydaci: [] });
    await expect(projektDlaOriginu(slepy, konf, origin)).rejects.toMatchObject({ kod: 'projekt_nieznany' });
  });

  it('jeden PID czytelny (= mapowanie), drugi bez cwd: mapowanie nie wystarcza', async () => {
    const konf = katalogKonfiguracji();
    const { port, proces } = await serwer(repoC, '127.0.0.1');
    const origin = `http://localhost:${port}`;
    await zapiszMapowanie(konf, origin, repoC);
    const prawdziwy = binarkiPrawdziwe().lsof;
    const slepy = { ...b, lsof: slepyLsof(`
      for a in "$@"; do [ "$a" = "-Fp" ] && { echo p${proces.pid}; echo p99999; exit 0; }; done
      case "$*" in *"-p 99999"*) exit 1;; *) exec ${prawdziwy} "$@";; esac`) };
    expect(await rozpoznaj(slepy, konf, origin)).toEqual({ projekt: null, zrodlo: 'lsof', kandydaci: [repoC] });
    await expect(projektDlaOriginu(slepy, konf, origin)).rejects.toMatchObject({ kod: 'projekt_nieznany' });
  });
});
