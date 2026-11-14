import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wczytajKonfiguracje } from '../../src/host/konfiguracja';
import { binarkiPrawdziwe, katalogTymczasowy } from './pomocnicze';

const baza = katalogTymczasowy();
let licznik = 0;

function katalogZKonfiguracja(tresc: unknown, tryb = 0o600): string {
  const k = join(baza, `k${licznik++}`);
  mkdirSync(k);
  const plik = join(k, 'config.json');
  writeFileSync(plik, typeof tresc === 'string' ? tresc : JSON.stringify(tresc));
  chmodSync(plik, tryb);
  return k;
}

const dobra = () => ({ wersja: 1, idWtyczki: 'hlpoejokkmdlocmplaodddcgcimfmpoi', binarki: binarkiPrawdziwe('/usr/bin/true') });

describe('wczytajKonfiguracje', () => {
  it('przyjmuje poprawny plik 0600 z istniejącymi binarkami', async () => {
    const k = await wczytajKonfiguracje(katalogZKonfiguracja(dobra()));
    expect(k.binarki.herdr).toBe('/usr/bin/true');
    expect(k.idWtyczki).toBe('hlpoejokkmdlocmplaodddcgcimfmpoi');
  });

  it('odrzuca plik czytelny dla innych (ktoś mógłby podmienić binarkę)', async () => {
    await expect(wczytajKonfiguracje(katalogZKonfiguracja(dobra(), 0o644))).rejects.toMatchObject({ kod: 'konfiguracja' });
  });

  it('odrzuca config.json będący symlinkiem', async () => {
    const zrodlo = katalogZKonfiguracja(dobra());
    const k = join(baza, 'z-symlinkiem');
    mkdirSync(k);
    symlinkSync(join(zrodlo, 'config.json'), join(k, 'config.json'));
    await expect(wczytajKonfiguracje(k)).rejects.toMatchObject({ kod: 'konfiguracja' });
  });

  it('odrzuca binarkę względną i nieistniejącą', async () => {
    await expect(wczytajKonfiguracje(katalogZKonfiguracja({ ...dobra(), binarki: { ...dobra().binarki, git: 'git' } }))).rejects.toMatchObject({ kod: 'konfiguracja' });
    await expect(
      wczytajKonfiguracje(katalogZKonfiguracja({ ...dobra(), binarki: { ...dobra().binarki, herdr: '/nie/ma/herdr' } })),
    ).rejects.toThrow(/install\.sh/);
  });

  it('odrzuca złe ID wtyczki, zły JSON i brak pliku', async () => {
    await expect(wczytajKonfiguracje(katalogZKonfiguracja({ ...dobra(), idWtyczki: 'abc' }))).rejects.toMatchObject({ kod: 'konfiguracja' });
    await expect(wczytajKonfiguracje(katalogZKonfiguracja('{'))).rejects.toMatchObject({ kod: 'konfiguracja' });
    await expect(wczytajKonfiguracje(join(baza, 'nie-ma'))).rejects.toThrow(/install\.sh/);
  });

  it('herdr opcjonalny: konfiguracja bez niego działa, a zapisana zepsuta ścieżka jest błędem (T261)', async () => {
    const bez = dobra() as { binarki: Record<string, unknown> };
    delete bez.binarki.herdr;
    const k = await wczytajKonfiguracje(katalogZKonfiguracja(bez));
    expect(k.binarki.herdr).toBeUndefined();
    await expect(
      wczytajKonfiguracje(katalogZKonfiguracja({ ...dobra(), binarki: { ...dobra().binarki, herdr: '/nie/ma/herdr' } })),
    ).rejects.toMatchObject({ kod: 'konfiguracja' });
  });

  it('hc opcjonalny: starsza konfiguracja bez hc działa, z hc przechodzi do Binarki, zepsuty hc odrzucony (T208)', async () => {
    const bez = dobra() as { binarki: Record<string, unknown> };
    delete bez.binarki.hc;
    const k = await wczytajKonfiguracje(katalogZKonfiguracja(bez));
    expect(k.binarki.hc).toBeUndefined();
    const zHc = await wczytajKonfiguracje(katalogZKonfiguracja({ ...dobra(), binarki: { ...dobra().binarki, hc: '/usr/bin/true' } }));
    expect(zHc.binarki.hc).toBe('/usr/bin/true');
    await expect(wczytajKonfiguracje(katalogZKonfiguracja({ ...dobra(), binarki: { ...dobra().binarki, hc: 'hc' } }))).rejects.toMatchObject({ kod: 'konfiguracja' });
    await expect(wczytajKonfiguracje(katalogZKonfiguracja({ ...dobra(), binarki: { ...dobra().binarki, hc: '/nie/ma/hc' } }))).rejects.toMatchObject({ kod: 'konfiguracja' });
  });
});
