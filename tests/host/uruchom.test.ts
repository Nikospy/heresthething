import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { herdrListaAgentow, gitCzyIgnorowane, gitToplevel, hcAgent, hcEkran, hcLista, hcWyslij, herdrAgent, herdrPrompt, lsofCwd, lsofNasluchujace } from '../../src/host/uruchom';
import { binarkiPrawdziwe, katalogTymczasowy, nowyRepo } from './pomocnicze';

const baza = katalogTymczasowy();

/**
 * Fałszywy herdr: zapisuje argv i env, które dostał, a potem odtwarza nagraną
 * odpowiedź. Sprawdza wyłącznie NASZĄ stronę (argv, env, parsowanie błędów),
 * nie zachowanie herdr — to dowodzi E2E.
 */
function falszywyHerdr(kodWyjscia: number, stdout: string, stderr: string): { sciezka: string; zapis: string } {
  const k = join(baza, `herdr-${Math.random().toString(36).slice(2)}`);
  mkdirSync(k);
  const zapis = join(k, 'wywolanie.json');
  const sciezka = join(k, 'herdr');
  writeFileSync(
    sciezka,
    `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(zapis)}, JSON.stringify({argv: process.argv.slice(2), env: process.env}));\n` +
      `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${kodWyjscia});\n`,
  );
  chmodSync(sciezka, 0o755);
  return { sciezka, zapis };
}

describe('git', () => {
  it('zwraca toplevel z podkatalogu i null poza repo', async () => {
    const repo = nowyRepo(baza, 'repo');
    mkdirSync(join(repo, 'a', 'b'), { recursive: true });
    const b = binarkiPrawdziwe();
    expect(await gitToplevel(b, join(repo, 'a', 'b'))).toBe(repo);
    const obcy = join(baza, 'bez-git');
    mkdirSync(obcy);
    expect(await gitToplevel(b, obcy)).toBeNull();
  });

  it('check-ignore odróżnia ścieżkę ignorowaną od widocznej', async () => {
    const repo = nowyRepo(baza, 'repo-ign');
    writeFileSync(join(repo, '.gitignore'), 'ukryte/\n');
    const b = binarkiPrawdziwe();
    expect(await gitCzyIgnorowane(b, repo, 'ukryte/x.md')).toBe(true);
    expect(await gitCzyIgnorowane(b, repo, 'jawne/x.md')).toBe(false);
  });
});

describe('lsof', () => {
  const procesy: ChildProcess[] = [];
  afterAll(() => procesy.forEach(p => p.kill()));

  it('znajduje PID nasłuchującego procesu i jego cwd', async () => {
    const cwd = join(baza, 'serwer');
    mkdirSync(cwd);
    const p = spawn(process.execPath, ['-e', "const s=require('http').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { cwd });
    procesy.push(p);
    const port = await new Promise<number>(r => p.stdout!.once('data', d => r(Number(String(d).trim()))));
    const b = binarkiPrawdziwe();
    const pidy = await lsofNasluchujace(b, port);
    expect(pidy).toEqual([p.pid]);
    expect(await lsofCwd(b, p.pid!)).toBe(cwd);
  });

  it('pusty wynik dla portu bez nasłuchu', async () => {
    expect(await lsofNasluchujace(binarkiPrawdziwe(), 1)).toEqual([]);
  });

  it('kod wyjścia inny niż 0 i 1 to błąd, nie „pusty port”', async () => {
    const slepy = join(baza, `lsof-${Math.random().toString(36).slice(2)}`);
    writeFileSync(slepy, '#!/bin/sh\nexit 3\n');
    chmodSync(slepy, 0o755);
    await expect(lsofNasluchujace({ ...binarkiPrawdziwe(), lsof: slepy }, 3000)).rejects.toMatchObject({ kod: 'wewnetrzny' });
  });
});

describe('herdr (fałszywy herdr: odtwarza nagrane odpowiedzi z 2026-10-09)', () => {
  it('prompt: dokładnie 4 argumenty, tekst ze znakami powłoki dosłownie, bez `--`', async () => {
    const f = falszywyHerdr(0, '{"id":"cli:agent:prompt","result":{"type":"agent_prompted"}}', '');
    const tekst = 'Uwagi: $(whoami) `id` ; | & "x" --wait\nlinia2';
    const w = await herdrPrompt({ ...binarkiPrawdziwe(), herdr: f.sciezka }, 'w4N:p7', tekst);
    expect(w.ok).toBe(true);
    const zapis = JSON.parse(readFileSync(f.zapis, 'utf8')) as { argv: string[]; env: Record<string, string> };
    expect(zapis.argv).toEqual(['agent', 'prompt', 'w4N:p7', tekst]);
  });

  it('dzieci nie dostają HERDR_* ani GIT_* z env hosta', async () => {
    const f = falszywyHerdr(0, '{}', '');
    process.env.HERDR_PANE_ID = 'w9:p9';
    process.env.GIT_DIR = '/zly';
    try {
      await herdrAgent({ ...binarkiPrawdziwe(), herdr: f.sciezka }, 'w1:p1');
    } finally {
      delete process.env.HERDR_PANE_ID;
      delete process.env.GIT_DIR;
    }
    const env = (JSON.parse(readFileSync(f.zapis, 'utf8')) as { env: Record<string, string> }).env;
    expect(Object.keys(env).filter(k => k.startsWith('HERDR_') || k === 'GIT_DIR')).toEqual([]);
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('parsuje błąd JSON ze stderr (nagrany agent_blocked)', async () => {
    const f = falszywyHerdr(
      1,
      '',
      '{"error":{"code":"agent_blocked","message":"agent uwagi-host-test is blocked and requires interactive input"},"id":"cli:agent:prompt"}',
    );
    const w = await herdrPrompt({ ...binarkiPrawdziwe(), herdr: f.sciezka }, 'w4N:p7', 'Uwagi x');
    expect(w).toEqual({ ok: false, blad: { kod: 'agent_blocked', wiadomosc: 'agent uwagi-host-test is blocked and requires interactive input' } });
  });

  it('odrzuca paneId udający flagę i tekst zaczynający się od myślnika, zanim cokolwiek uruchomi', async () => {
    const f = falszywyHerdr(0, '{}', '');
    const b = { ...binarkiPrawdziwe(), herdr: f.sciezka };
    await expect(herdrPrompt(b, '--help', 'Uwagi')).rejects.toMatchObject({ kod: 'zadanie_niepoprawne' });
    await expect(herdrPrompt(b, 'w1:p1', '-x')).rejects.toMatchObject({ kod: 'wewnetrzny' });
    expect(() => readFileSync(f.zapis)).toThrow();
  });

  it('brak binarki herdr → błąd konfiguracji z podpowiedzią', async () => {
    await expect(herdrAgent({ ...binarkiPrawdziwe(), herdr: join(baza, 'nie-ma-herdr') }, 'w1:p1')).rejects.toMatchObject({ kod: 'konfiguracja' });
  });
});

describe('hc (fałszywy hc: argv i env, T208)', () => {
  function falszywyHc(kod: number, stdout: string, stderr: string): { sciezka: string; zapis: string } {
    const k = join(baza, `hc-${Math.random().toString(36).slice(2)}`);
    mkdirSync(k);
    const zapis = join(k, 'wywolanie.json');
    const sciezka = join(k, 'hc');
    writeFileSync(
      sciezka,
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(zapis)}, JSON.stringify({argv: process.argv.slice(2), env: process.env}));\n` +
        `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${kod});\n`,
    );
    chmodSync(sciezka, 0o755);
    return { sciezka, zapis };
  }

  it('hcLista woła `hc ls --json` i parsuje odpowiedź', async () => {
    const f = falszywyHc(0, '{"terminals":[]}', '');
    const w = await hcLista({ ...binarkiPrawdziwe(), hc: f.sciezka });
    expect(w.ok).toBe(true);
    expect((JSON.parse(readFileSync(f.zapis, 'utf8')) as { argv: string[] }).argv).toEqual(['ls', '--json']);
  });

  it('dzieci hc nie dostają HC_* ani GIT_* z env hosta', async () => {
    const f = falszywyHc(0, '{}', '');
    process.env.HC_SESSION = 'obcy';
    process.env.HC_TERMINAL_ID = 't9';
    process.env.GIT_DIR = '/zly';
    try {
      await hcAgent({ ...binarkiPrawdziwe(), hc: f.sciezka }, 't1');
    } finally {
      delete process.env.HC_SESSION;
      delete process.env.HC_TERMINAL_ID;
      delete process.env.GIT_DIR;
    }
    const env = (JSON.parse(readFileSync(f.zapis, 'utf8')) as { env: Record<string, string> }).env;
    expect(Object.keys(env).filter(k => k.startsWith('HC_') || k === 'GIT_DIR')).toEqual([]);
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('hcAgent odmawia adresu z poza wzoru hc, zanim cokolwiek uruchomi', async () => {
    const f = falszywyHc(0, '{}', '');
    const b = { ...binarkiPrawdziwe(), hc: f.sciezka };
    for (const adres of ['w1:p1', '--help', '../t1', 't'.repeat(40), 'T1']) {
      await expect(hcAgent(b, adres)).rejects.toMatchObject({ kod: 'zadanie_niepoprawne' });
    }
    expect(() => readFileSync(f.zapis)).toThrow();
  });

  it('hcEkran zwraca tekst ekranu z `hc read --lines 0`', async () => {
    const f = falszywyHc(0, 'ekran\nagenta\n', '');
    const w = await hcEkran({ ...binarkiPrawdziwe(), hc: f.sciezka }, 't2');
    expect(w).toEqual({ ok: true, tekst: 'ekran\nagenta\n' });
    expect((JSON.parse(readFileSync(f.zapis, 'utf8')) as { argv: string[] }).argv).toEqual(['read', 't2', '--lines', '0']);
  });

  it('hcWyslij: dokładne argv, bez --force; tekst zaczynający się od myślnika odrzucony', async () => {
    const f = falszywyHc(0, '{"started":true}', '');
    const w = await hcWyslij({ ...binarkiPrawdziwe(), hc: f.sciezka }, 't3', 'Uwagi: X --force');
    expect(w.ok).toBe(true);
    expect((JSON.parse(readFileSync(f.zapis, 'utf8')) as { argv: string[] }).argv).toEqual(['send', 't3', 'Uwagi: X --force']);
    await expect(hcWyslij({ ...binarkiPrawdziwe(), hc: f.sciezka }, 't3', '-force')).rejects.toMatchObject({ kod: 'wewnetrzny' });
  });

  it('błąd hc: error.kind na stderr (nagrany not_found, kod 3)', async () => {
    const f = falszywyHc(3, '', '{"error":{"kind":"not_found","hint":"see `hc ls --all`","message":"no terminal \\"t99\\""}}');
    const w = await hcAgent({ ...binarkiPrawdziwe(), hc: f.sciezka }, 't99');
    expect(w).toEqual({ ok: false, blad: { kod: 'not_found', wiadomosc: 'no terminal "t99"' } });
  });

  it('błąd hc bez JSON na stderr → kod wyjścia jako kod błędu', async () => {
    const f = falszywyHc(10, '', 'czysty tekst');
    const w = await hcLista({ ...binarkiPrawdziwe(), hc: f.sciezka });
    expect(w).toEqual({ ok: false, blad: { kod: 'wyjscie_10', wiadomosc: 'czysty tekst' } });
  });

  it('brak herdr w konfiguracji → herdr_niedostepny, bez uruchamiania czegokolwiek (T261)', async () => {
    const { herdr: _herdr, ...bezHerdra } = binarkiPrawdziwe();
    await expect(herdrListaAgentow(bezHerdra)).rejects.toMatchObject({ kod: 'herdr_niedostepny' });
  });

  it('brak hc w konfiguracji → herdr_niedostepny', async () => {
    await expect(hcLista(binarkiPrawdziwe())).rejects.toMatchObject({ kod: 'herdr_niedostepny' });
  });
});
