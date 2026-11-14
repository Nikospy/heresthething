import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { WERSJA_PROTOKOLU } from '../../src/wspolne/protokol';
import { zakodujRamke } from '../../src/host/ramki';
import { binarkiPrawdziwe, katalogTymczasowy, nowyRepo } from './pomocnicze';

/**
 * S-27: prawdziwy proces hosta i prawdziwe ramki. Zapis uwag nie wymaga żadnego
 * agenta ani Herdra: `deliver` bez `agent` zapisuje i nie próbuje nic dostarczać.
 */

const ID = 'hlpoejokkmdlocmplaodddcgcimfmpoi';
const NADAWCA = `chrome-extension://${ID}/`;
const ORIGIN = 'https://staging.przyklad.pl';
const baza = katalogTymczasowy('uwagi-bez-agenta-');
const instalacja = join(baza, 'tryb-uwag');
const repo = nowyRepo(baza, 'apka');
const dziennikHerdr = join(baza, 'herdr-wywolania.txt');

const bezHerdra = (): { git: string; lsof: string } => {
  const { git, lsof } = binarkiPrawdziwe();
  return { git, lsof };
};

function zapiszKonfiguracje(binarki: Record<string, string>): void {
  writeFileSync(join(instalacja, 'config.json'), JSON.stringify({ wersja: 1, idWtyczki: ID, binarki }));
  chmodSync(join(instalacja, 'config.json'), 0o600);
}

/** Herdr działa, ale w tym projekcie nie ma żadnego agenta. Każde wywołanie trafia do dziennika. */
function herdrBezAgentow(): string {
  const sciezka = join(baza, 'herdr-pusty');
  writeFileSync(sciezka, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(dziennikHerdr)}, process.argv.slice(2).join(' ') + '\\n');\nconsole.log(JSON.stringify({ result: { agents: [] } }));\n`);
  chmodSync(sciezka, 0o755);
  return sciezka;
}

beforeAll(async () => {
  mkdirSync(instalacja, { mode: 0o700 });
  await build({
    entryPoints: [join(import.meta.dirname, '../../src/host/host.ts')],
    outfile: join(instalacja, 'host.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    define: { HASH_BUILDY: JSON.stringify('test-hash') },
  });
});

async function wyslij(zadania: unknown[]): Promise<Array<Record<string, unknown>>> {
  const p = spawn(process.execPath, [join(instalacja, 'host.mjs'), NADAWCA], { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME! } });
  const wyjscie: Buffer[] = [];
  p.stdout.on('data', (d: Buffer) => wyjscie.push(d));
  p.stdin.end(Buffer.concat(zadania.map(z => zakodujRamke(z, 64 << 20))));
  await new Promise(r => p.once('exit', r));
  const bufor = Buffer.concat(wyjscie);
  const odpowiedzi: Array<Record<string, unknown>> = [];
  for (let i = 0; i < bufor.length; ) {
    const n = bufor.readUInt32LE(i);
    odpowiedzi.push(JSON.parse(bufor.subarray(i + 4, i + 4 + n).toString('utf8')) as Record<string, unknown>);
    i += 4 + n;
  }
  return odpowiedzi;
}

const z = (typ: string, reszta: Record<string, unknown> = {}) => ({ wersja: WERSJA_PROTOKOLU, idZadania: `t-${typ}-${Math.random().toString(36).slice(2, 8)}`, typ, ...reszta });
const paczka = (id: string) => ({ origin: ORIGIN, idPaczki: id, markdown: '# Uwagi\n\nTRESC-UWAGI', json: '{"uwagi":[{"numer":1}]}', zrzuty: [] });
const uwagiMd = (id: string) => join(repo, '.herestt', id, 'uwagi.md');

async function zmapuj(): Promise<void> {
  expect(await wyslij([z('mapuj', { origin: ORIGIN, projekt: repo })])).toMatchObject([{ ok: true, typ: 'mapuj', projekt: repo }]);
}

describe('deliver bez agenta (S-27)', () => {
  it('tylko git i lsof: lista agentów pusta bez błędu, zapis działa, a ponowienie niczego nie dubluje', async () => {
    zapiszKonfiguracje(bezHerdra());
    await zmapuj();
    expect(await wyslij([z('agents', { origin: ORIGIN })])).toMatchObject([{ ok: true, typ: 'agents', projekt: repo, agenci: [], ostrzezenia: [] }]);

    const id = '2026-11-09-1500-aaaaaa';
    expect(await wyslij([z('deliver', paczka(id))])).toMatchObject([{ ok: true, typ: 'deliver', paczka: 'zapisana', prompt: 'pominiety', sciezkaMd: `.herestt/${id}/uwagi.md` }]);
    expect(existsSync(join(repo, '.scratch'))).toBe(false);
    expect(readFileSync(uwagiMd(id), 'utf8')).toContain('TRESC-UWAGI');
    expect(await wyslij([z('deliver', paczka(id))])).toMatchObject([{ ok: true, typ: 'deliver', paczka: 'istniejaca', prompt: 'pominiety' }]);
  });

  it.each([
    ['null', null],
    ['tekst', 'codex'],
    ['niepełna tożsamość', { paneId: 'w1:p1' }],
    ['zły typ pola', { paneId: 1, terminalId: 't', sesjaAgenta: null }],
  ])('tożsamość podana, ale niepoprawna (%s): odrzucona i nic nie zapisane', async (_opis, agent) => {
    zapiszKonfiguracje(bezHerdra());
    await zmapuj();
    const id = `2026-11-09-1501-b${Math.random().toString(36).slice(2, 7).padEnd(5, '0')}`;
    expect(await wyslij([z('deliver', { ...paczka(id), agent })])).toMatchObject([{ ok: false, kod: 'zadanie_niepoprawne' }]);
    expect(existsSync(uwagiMd(id))).toBe(false);
  });

  it('Herdr jest, ale w projekcie nie ma agenta: ta sama droga i żaden prompt', async () => {
    zapiszKonfiguracje({ ...bezHerdra(), herdr: herdrBezAgentow() });
    await zmapuj();
    expect(await wyslij([z('agents', { origin: ORIGIN })])).toMatchObject([{ ok: true, agenci: [] }]);
    const id = '2026-11-09-1502-cccccc';
    expect(await wyslij([z('deliver', paczka(id))])).toMatchObject([{ ok: true, paczka: 'zapisana', prompt: 'pominiety' }]);
    expect(existsSync(uwagiMd(id))).toBe(true);
    expect(readFileSync(dziennikHerdr, 'utf8')).not.toContain('prompt');
  });
});
