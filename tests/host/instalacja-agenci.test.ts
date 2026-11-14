import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { obsluzZadanie } from '../../src/host/dyspozytor';
import { zarejestrowaniAgenci } from '../../src/host/instalacja-agenci';
import type { Konfiguracja } from '../../src/host/konfiguracja';
import { katalogTymczasowy } from './pomocnicze';

/** S-32 faza 1 (R1–R3): ping niesie tylko zarejestrowanych agentów z dziennika instalacji. */

const baza = katalogTymczasowy();
let licznik = 0;
function katalogZDziennikiem(tresc?: string | object): string {
  const k = join(baza, `k${licznik++}`);
  mkdirSync(k);
  if (tresc !== undefined) writeFileSync(join(k, 'instalacja.json'), typeof tresc === 'string' ? tresc : JSON.stringify(tresc));
  return k;
}
const dziennik = (kroki: unknown, stan = 'zapis') => ({ wersja: 1, idWtyczki: 'a'.repeat(32), wybor: { przegladarki: ['chrome'], agenci: [] }, kroki, stan });
const mcp = (cel: string, ok = true) => ({ rodzaj: 'mcp', cel, ok });

const KONFIG = { wersja: 1, idWtyczki: 'a'.repeat(32), binarki: { git: '/usr/bin/git', lsof: '/usr/sbin/lsof' } } as Konfiguracja;
const ping = (katalog: string) => obsluzZadanie({ katalog, konfiguracja: KONFIG }, { wersja: 2, idZadania: 'p1', typ: 'ping', zakres: { od: 2, do: 2 } });

describe('zarejestrowaniAgenci (R1–R3)', () => {
  it('R1: krok mcp ok daje agenta, w stałej kolejności, bez duplikatów', async () => {
    const k = katalogZDziennikiem(dziennik([mcp('codex'), { rodzaj: 'plik', cel: '/x', ok: true }, mcp('claude'), mcp('claude')]));
    expect(await zarejestrowaniAgenci(k)).toEqual(['claude', 'codex']);
  });

  it('R1: ping niesie pole agenci i żadnej ścieżki z dziennika', async () => {
    const k = katalogZDziennikiem(dziennik([{ rodzaj: 'plik', cel: '/home/ktos/.config/herestt/host.mjs', ok: true }, mcp('claude')]));
    const odp = await ping(k);
    expect(odp).toMatchObject({ ok: true, typ: 'ping', agenci: ['claude'] });
    expect(JSON.stringify(odp)).not.toContain('/home/');
  });

  it('R2: brak dziennika, zły JSON, zły kształt, nie obiekt: null i ping nie pada', async () => {
    const przypadki: Array<string | object | undefined> = [undefined, '{nie json', '[]', '"x"', 'null', { wersja: 1, stan: 'zapis' }, dziennik('nie-tablica')];
    for (const tresc of przypadki) {
      const k = katalogZDziennikiem(tresc);
      expect(await zarejestrowaniAgenci(k)).toBeNull();
      const odp = await ping(k);
      expect(odp).toMatchObject({ ok: true, typ: 'ping' });
      expect(odp).not.toHaveProperty('agenci');
    }
  });

  it('R2: symlink, katalog zamiast pliku i plik ponad 256 KB dają null', async () => {
    const cel = katalogZDziennikiem(dziennik([mcp('claude')]));
    const link = katalogZDziennikiem();
    symlinkSync(join(cel, 'instalacja.json'), join(link, 'instalacja.json'));
    expect(await zarejestrowaniAgenci(link)).toBeNull();
    const katalogJako = katalogZDziennikiem();
    mkdirSync(join(katalogJako, 'instalacja.json'));
    expect(await zarejestrowaniAgenci(katalogJako)).toBeNull();
    const duzy = katalogZDziennikiem(dziennik([mcp('claude'), ...Array.from({ length: 20_000 }, () => ({ rodzaj: 'plik', cel: '/aaaaaaaaaaaaaaaa', ok: true }))]));
    expect(await zarejestrowaniAgenci(duzy)).toBeNull();
  });

  it('R2: nieznany agent, krok nie-ok i śmieciowe kroki są odfiltrowane', async () => {
    const k = katalogZDziennikiem(dziennik([mcp('evil'), mcp('codex', false), null, 5, 'x', { rodzaj: 'mcp', cel: 7, ok: true }, { rodzaj: 'mcp', cel: 'claude', ok: 'tak' }, mcp('claude')]));
    expect(await zarejestrowaniAgenci(k)).toEqual(['claude']);
  });

  it('R3: dziennik bez kroków mcp daje [], a cofnięcie daje [] mimo kroków', async () => {
    expect(await zarejestrowaniAgenci(katalogZDziennikiem(dziennik([{ rodzaj: 'plik', cel: '/x', ok: true }])))).toEqual([]);
    expect(await zarejestrowaniAgenci(katalogZDziennikiem(dziennik([mcp('claude')], 'cofniecie')))).toEqual([]);
    expect(await ping(katalogZDziennikiem(dziennik([], 'czesciowy')))).toMatchObject({ ok: true, agenci: [] });
  });
});
