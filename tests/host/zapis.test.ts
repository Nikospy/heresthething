import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BladHosta } from '../../src/host/bledy';
import { KATALOG_UWAG, sciezkaIstniejacejPaczki, zapiszPaczke, zweryfikujPaczke } from '../../src/host/zapis';
import { LIMITY } from '../../src/wspolne/protokol';
import { binarkiPrawdziwe, katalogTymczasowy, nowyRepo } from './pomocnicze';

const baza = katalogTymczasowy();
const b = binarkiPrawdziwe();
const ID = '2026-10-09-1300-abc123';
const PNG1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5f20000000049454e44ae426082',
  'hex',
);
const PNG1_B64 = PNG1.toString('base64');

function paczkaSurowa(nadpisz: Record<string, unknown> = {}): Record<string, unknown> {
  return { idPaczki: ID, markdown: '# Uwagi', json: '{}', zrzuty: [{ nazwa: 'uwaga-1.png', pngBase64: PNG1_B64 }], ...nadpisz };
}

function zweryfikowana(nadpisz?: Record<string, unknown>) {
  return zweryfikujPaczke(paczkaSurowa(nadpisz));
}

function zapisz(repo: string, nadpisz?: Record<string, unknown>) {
  return zapiszPaczke(b, repo, zweryfikowana(nadpisz));
}

/** Zwraca rzucony wyjątek; gdy nic nie rzucono, test pada. */
function zlapBlad(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error('oczekiwano wyjątku, nic nie rzucono');
}

function ofiara(nazwa: string): string {
  const k = join(baza, `ofiara-${nazwa}`);
  mkdirSync(k);
  return k;
}

function katalogUwag(repo: string): string {
  return join(repo, KATALOG_UWAG);
}

/** Poprawny PNG 1×1 dopełniony tEXt-em do dokładnie `n` bajtów (CRC zerowe, walidator go nie sprawdza). */
function dopelnijPng(n: number): Buffer {
  const bezIend = PNG1.subarray(0, PNG1.length - 12);
  const iend = PNG1.subarray(PNG1.length - 12);
  const dlugoscDanych = n - PNG1.length - 12;
  const chunk = Buffer.alloc(12 + dlugoscDanych);
  chunk.writeUInt32BE(dlugoscDanych, 0);
  chunk.write('tEXt', 4, 'latin1');
  return Buffer.concat([bezIend, chunk, iend]);
}

describe('zweryfikujPaczke: walidacja przed zapisem', () => {
  it.each(['../x.png', '/etc/x.png', 'uwaga-1.png/../../x.png', 'uwaga-1.PNG', 'uwaga-1.png\0', '.uwaga-1.png', 'uwagi.md', 'uwaga-1.png '])(
    'odrzuca niedozwoloną nazwę zrzutu %j',
    nazwa => {
      expect(zlapBlad(() => zweryfikowana({ zrzuty: [{ nazwa, pngBase64: PNG1_B64 }] }))).toMatchObject({ kod: 'nazwa_niepoprawna' });
    },
  );

  it('odrzuca duplikat nazwy zrzutu', () => {
    const zrzuty = [
      { nazwa: 'uwaga-1.png', pngBase64: PNG1_B64 },
      { nazwa: 'uwaga-1.png', pngBase64: PNG1_B64 },
    ];
    expect(zlapBlad(() => zweryfikowana({ zrzuty }))).toMatchObject({ kod: 'nazwa_niepoprawna' });
  });

  it.each(['../../x', '2026-10-09-1300', '2026-10-09-1300-ABC123', '2026-10-09-1300-abc123/..'])('odrzuca idPaczki %j', idPaczki => {
    expect(zlapBlad(() => zweryfikowana({ idPaczki }))).toMatchObject({ kod: 'id_niepoprawne' });
  });

  it('odrzuca zrzut, który nie jest PNG', () => {
    const pngBase64 = Buffer.from('<svg/>xx').toString('base64');
    expect(zlapBlad(() => zweryfikowana({ zrzuty: [{ nazwa: 'uwaga-1.png', pngBase64 }] }))).toMatchObject({ kod: 'zrzut_niepoprawny' });
  });

  it('odrzuca base64 ze śmieciami na końcu', () => {
    const pngBase64 = PNG1_B64 + '!!!!';
    expect(zlapBlad(() => zweryfikowana({ zrzuty: [{ nazwa: 'uwaga-1.png', pngBase64 }] }))).toMatchObject({ kod: 'zrzut_niepoprawny' });
  });

  it('odrzuca zrzut dłuższy niż limit już na etapie długości tekstu base64', () => {
    const pngBase64 = 'A'.repeat(Math.ceil(LIMITY.zrzutBajty / 3) * 4 + 8);
    expect(zlapBlad(() => zweryfikowana({ zrzuty: [{ nazwa: 'uwaga-1.png', pngBase64 }] }))).toMatchObject({ kod: 'za_duzy' });
  });

  it('odrzuca zrzut o jeden bajt większy niż LIMITY.zrzutBajty (limit po dekodowaniu)', () => {
    const pngBase64 = dopelnijPng(LIMITY.zrzutBajty + 1).toString('base64');
    expect(zlapBlad(() => zweryfikowana({ zrzuty: [{ nazwa: 'uwaga-1.png', pngBase64 }] }))).toMatchObject({ kod: 'za_duzy' });
  });

  it('przyjmuje zrzut dokładnie LIMITY.zrzutBajty bajtów', () => {
    const pngBase64 = dopelnijPng(LIMITY.zrzutBajty).toString('base64');
    expect(() => zweryfikowana({ zrzuty: [{ nazwa: 'uwaga-1.png', pngBase64 }] })).not.toThrow();
  });

  it('odrzuca markdown większy niż limit', () => {
    expect(zlapBlad(() => zweryfikowana({ markdown: 'x'.repeat(LIMITY.markdownBajty + 1) }))).toMatchObject({ kod: 'za_duzy' });
  });

  it('odrzuca więcej zrzutów niż limit', () => {
    const zrzuty = Array.from({ length: LIMITY.zrzutow + 1 }, (_, i) => ({ nazwa: `uwaga-${i + 1}.png`, pngBase64: PNG1_B64 }));
    expect(zlapBlad(() => zweryfikowana({ zrzuty }))).toMatchObject({ kod: 'za_duzo_zrzutow' });
  });

  it('przyjmuje 50 wycinków i szkic, ale nie 51 wycinków: szkic ma własne miejsce, a limit wycinków się nie zmienia', () => {
    const wycinki = (ile: number) => Array.from({ length: ile }, (_, i) => ({ nazwa: `uwaga-${i + 1}.png`, pngBase64: PNG1_B64 }));
    const zSzkicem = JSON.stringify({ plansza: { obraz: { plik: 'plansza.png', tlo: 'strona' } } });
    expect(() => zweryfikowana({ json: zSzkicem, zrzuty: [...wycinki(LIMITY.zrzutowBezPlanszy), { nazwa: 'plansza.png', pngBase64: PNG1_B64 }] })).not.toThrow();
    expect(zlapBlad(() => zweryfikowana({ zrzuty: wycinki(LIMITY.zrzutowBezPlanszy + 1) }))).toMatchObject({ kod: 'za_duzo_zrzutow' });
  });

  it('obraz planszy musi zgadzać się z uwagi.json w obie strony', () => {
    const plik = { nazwa: 'plansza.png', pngBase64: PNG1_B64 };
    const opis = (obraz: unknown) => JSON.stringify({ plansza: { obraz } });
    expect(() => zweryfikowana({ json: opis({ plik: 'plansza.png', tlo: 'czyste' }), zrzuty: [plik] })).not.toThrow();
    expect(() => zweryfikowana({ json: opis({ plik: null, tlo: 'czyste' }), zrzuty: [] })).not.toThrow();
    expect(zlapBlad(() => zweryfikowana({ json: '{}', zrzuty: [plik] }))).toMatchObject({ kod: 'zrzut_niepoprawny' });
    expect(zlapBlad(() => zweryfikowana({ json: opis({ plik: 'plansza.png', tlo: 'czyste' }), zrzuty: [] }))).toMatchObject({ kod: 'zrzut_niepoprawny' });
    expect(zlapBlad(() => zweryfikowana({ json: opis({ plik: '../x.png', tlo: 'czyste' }), zrzuty: [] }))).toMatchObject({ kod: 'zrzut_niepoprawny' });
  });

  it('R9: przyjmuje plansza-N.png z deklaracji i odrzuca plik spoza niej', () => {
    const opis = JSON.stringify({ plansza: { obraz: { plik: null, tlo: 'strona', rysunki: [{ numer: 2, plik: 'plansza-2.png' }] } } });
    const plik = { nazwa: 'plansza-2.png', pngBase64: PNG1_B64 };
    expect(() => zweryfikowana({ json: opis, zrzuty: [plik] })).not.toThrow();
    expect(zlapBlad(() => zweryfikowana({ json: opis, zrzuty: [plik, { nazwa: 'plansza-9.png', pngBase64: PNG1_B64 }] }))).toMatchObject({ kod: 'zrzut_niepoprawny' });
    expect(zlapBlad(() => zweryfikowana({ json: opis, zrzuty: [] }))).toMatchObject({ kod: 'zrzut_niepoprawny' });
    expect(zlapBlad(() => zweryfikowana({
      json: JSON.stringify({ plansza: { obraz: { plik: null, tlo: 'strona', rysunki: [{ numer: 2, plik: 'plansza-3.png' }] } } }),
      zrzuty: [{ nazwa: 'plansza-3.png', pngBase64: PNG1_B64 }],
    }))).toMatchObject({ kod: 'zrzut_niepoprawny' });
  });

  it('przyjmuje uwagę bez typu: host nie wymaga pola typ (FR-025)', () => {
    expect(() => zweryfikowana({ json: JSON.stringify({ uwagi: [{ numer: 1, typ: null }] }) })).not.toThrow();
  });

  it('odrzuca json, który nie parsuje się', () => {
    expect(zlapBlad(() => zweryfikowana({ json: '{' }))).toMatchObject({ kod: 'json_niepoprawny' });
  });

  it.each(['null', '123', '[]', '"x"'])('odrzuca json %s, bo paczka uwag musi być obiektem', json => {
    expect(zlapBlad(() => zweryfikowana({ json }))).toMatchObject({ kod: 'json_niepoprawny' });
  });

  it('odrzuca paczkę null kodem zadanie_niepoprawne, a nie TypeError', () => {
    const blad = zlapBlad(() => zweryfikujPaczke(null));
    expect(blad).toBeInstanceOf(BladHosta);
    expect(blad).toMatchObject({ kod: 'zadanie_niepoprawne' });
  });

  it('odrzuca PNG z poprawnym nagłówkiem i śmieciami zamiast IEND', () => {
    const smieci = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 0x41)]);
    expect(zlapBlad(() => zweryfikowana({ zrzuty: [{ nazwa: 'uwaga-1.png', pngBase64: smieci.toString('base64') }] }))).toMatchObject({
      kod: 'zrzut_niepoprawny',
    });
  });

  it('odrzuca sam 8-bajtowy nagłówek PNG', () => {
    const sam = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(zlapBlad(() => zweryfikowana({ zrzuty: [{ nazwa: 'uwaga-1.png', pngBase64: sam.toString('base64') }] }))).toMatchObject({
      kod: 'zrzut_niepoprawny',
    });
  });
});

describe('zapiszPaczke: symlinki w złośliwym repo', () => {
  it('.herestt jest symlinkiem poza projekt → sciezka_symlink, ofiara pusta', async () => {
    const repo = nowyRepo(baza, 'symlink-herestt');
    const of = ofiara('herestt');
    symlinkSync(of, join(repo, '.herestt'));
    await expect(zapisz(repo)).rejects.toMatchObject({ kod: 'sciezka_symlink' });
    expect(readdirSync(of)).toEqual([]);
  });

  it('stary uwagi-ui jako symlink nie dostaje zapisu', async () => {
    const repo = nowyRepo(baza, 'symlink-uwagi');
    const of = ofiara('uwagi');
    mkdirSync(join(repo, '.scratch'));
    symlinkSync(of, join(repo, '.scratch', 'uwagi-ui'));
    const wynik = await zapisz(repo);
    expect(wynik.sciezkaMdWzgledna).toBe(join('.herestt', ID, 'uwagi.md'));
    expect(readdirSync(of)).toEqual([]);
    expect(existsSync(join(repo, '.herestt', ID, 'uwagi.md'))).toBe(true);
  });

  it('katalog paczki jest symlinkiem → sciezka_symlink, cel nietknięty', async () => {
    const repo = nowyRepo(baza, 'symlink-cel');
    const of = ofiara('cel');
    mkdirSync(katalogUwag(repo), { recursive: true });
    symlinkSync(of, join(katalogUwag(repo), ID));
    await expect(zapisz(repo)).rejects.toMatchObject({ kod: 'sciezka_symlink' });
    expect(readdirSync(of)).toEqual([]);
  });

  it('.herestt jest zwykłym plikiem → sciezka_symlink', async () => {
    const repo = nowyRepo(baza, 'herestt-plik');
    writeFileSync(join(repo, '.herestt'), 'x');
    await expect(zapisz(repo)).rejects.toMatchObject({ kod: 'sciezka_symlink' });
  });

  it('.gitignore w uwagi-ui jest symlinkiem do pliku ofiary → sciezka_symlink, plik ofiary nietknięty', async () => {
    const repo = nowyRepo(baza, 'symlink-gitignore');
    const of = ofiara('gitignore');
    mkdirSync(katalogUwag(repo), { recursive: true });
    writeFileSync(join(of, 'zshrc'), 'orig');
    symlinkSync(join(of, 'zshrc'), join(katalogUwag(repo), '.gitignore'));
    await expect(zapisz(repo)).rejects.toMatchObject({ kod: 'sciezka_symlink' });
    expect(readFileSync(join(of, 'zshrc'), 'utf8')).toBe('orig');
    expect(readdirSync(of)).toEqual(['zshrc']);
  });
});

describe('zapiszPaczke: zapis, idempotencja i git', () => {
  it('zapisuje uwaga-1.png, uwagi.json i uwagi.md w .herestt/<id>/ i zwraca ścieżki', async () => {
    const repo = nowyRepo(baza, 'szczesliwa');
    const wynik = await zapisz(repo);
    expect(wynik).toEqual({
      paczka: 'zapisana',
      sciezkaMdWzgledna: join(KATALOG_UWAG, ID, 'uwagi.md'),
      sciezkaMdAbsolutna: join(repo, KATALOG_UWAG, ID, 'uwagi.md'),
      ostrzezenia: [],
    });
    const dok = join(katalogUwag(repo), ID);
    expect(readdirSync(dok).sort()).toEqual(['uwaga-1.png', 'uwagi.json', 'uwagi.md']);
    expect(readFileSync(join(dok, 'uwaga-1.png')).equals(PNG1)).toBe(true);
    expect(readFileSync(join(dok, 'uwagi.json'), 'utf8')).toBe('{}');
    expect(readFileSync(join(dok, 'uwagi.md'), 'utf8')).toBe('# Uwagi');
  });

  it('ponowienie paczki tylko ze starego katalogu nie zakłada kopii w .herestt', async () => {
    const repo = nowyRepo(baza, 'stara-ponow');
    const k = join(repo, '.scratch', 'uwagi-ui', ID);
    mkdirSync(k, { recursive: true });
    writeFileSync(join(k, 'uwagi.md'), '# stara');
    writeFileSync(join(k, 'uwagi.json'), JSON.stringify({ uwagi: [{ numer: 1 }] }));
    writeFileSync(join(k, 'status.json'), JSON.stringify({ uwagi: [{ numer: 1, stan: 'zrobione', komentarz: 'było' }] }));
    const wynik = await zapisz(repo);
    expect(wynik.paczka).toBe('istniejaca');
    expect(wynik.sciezkaMdWzgledna).toBe(join('.scratch', 'uwagi-ui', ID, 'uwagi.md'));
    expect(existsSync(join(repo, '.herestt', ID))).toBe(false);
    const { czytajStatus } = await import('../../src/host/status');
    expect(await czytajStatus(repo, ID)).toMatchObject({ plik: 'jest', statusy: [{ numer: 1, stan: 'done', komentarz: 'było' }] });
  });

  it('ponowny zapis tego samego id z inną treścią → istniejaca, treść pierwszego zapisu zachowana', async () => {
    const repo = nowyRepo(baza, 'idempotencja');
    await zapisz(repo, { markdown: '# PIERWSZY', json: '{}' });
    const drugi = await zapisz(repo, { markdown: '# DRUGI', json: '{"x":1}' });
    expect(drugi.paczka).toBe('istniejaca');
    const dok = join(katalogUwag(repo), ID);
    expect(readFileSync(join(dok, 'uwagi.md'), 'utf8')).toBe('# PIERWSZY');
    expect(readFileSync(join(dok, 'uwagi.json'), 'utf8')).toBe('{}');
  });

  it('git status --porcelain --untracked-files=all nie pokazuje .herestt po zapisie', async () => {
    const repo = nowyRepo(baza, 'git-widzi');
    await zapisz(repo);
    const status = execFileSync(b.git, ['-C', repo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
    expect(status).not.toContain('.herestt');
    expect(existsSync(join(repo, '.scratch'))).toBe(false);
  });

  it('pliki paczki mają tryb 0600, a katalogi 0700', async () => {
    const repo = nowyRepo(baza, 'uprawnienia');
    await zapisz(repo);
    const dok = join(katalogUwag(repo), ID);
    for (const plik of [join(dok, 'uwaga-1.png'), join(dok, 'uwagi.json'), join(dok, 'uwagi.md'), join(katalogUwag(repo), '.gitignore')]) {
      expect(statSync(plik).mode & 0o777).toBe(0o600);
    }
    for (const katalog of [katalogUwag(repo), dok]) {
      expect(statSync(katalog).mode & 0o777).toBe(0o700);
    }
  });
});

describe('zapiszPaczke: regresje red-teamu', () => {
  it('zacommitowany .herestt/.gitignore z "!*" → zapis się udaje, ostrzezenia zawiera nie_ignorowane, plik nietknięty', async () => {
    const repo = nowyRepo(baza, 'gitignore-zlosliwy');
    mkdirSync(katalogUwag(repo), { recursive: true });
    writeFileSync(join(katalogUwag(repo), '.gitignore'), '!*\n');
    const wynik = await zapisz(repo);
    expect(wynik.paczka).toBe('zapisana');
    expect(wynik.ostrzezenia).toContain('nie_ignorowane');
    expect(readFileSync(join(katalogUwag(repo), '.gitignore'), 'utf8')).toBe('!*\n');
  });

  it('katalog .tmp-* starszy niż 1 h znika po udanym zapisie; świeży .tmp-* zostaje', async () => {
    const repo = nowyRepo(baza, 'sprzatanie-tmp');
    const uwagi = katalogUwag(repo);
    mkdirSync(uwagi, { recursive: true });
    const stary = join(uwagi, '.tmp-stary');
    mkdirSync(stary);
    writeFileSync(join(stary, 'resztka.png'), 'x');
    const dwieGodziny = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(stary, dwieGodziny, dwieGodziny);
    const swiezy = join(uwagi, '.tmp-swiezy');
    mkdirSync(swiezy);

    await zapisz(repo);

    expect(existsSync(stary)).toBe(false);
    expect(existsSync(swiezy)).toBe(true);
  });

  it('3 równoległe zapiszPaczke z tym samym id: wszystkie się udają, dokładnie jedno zapisana, reszta istniejaca, brak .tmp-*', async () => {
    const repo = nowyRepo(baza, 'wspolbieznosc');
    const zw = zweryfikowana();
    const wyniki = await Promise.all([zapiszPaczke(b, repo, zw), zapiszPaczke(b, repo, zw), zapiszPaczke(b, repo, zw)]);
    expect(wyniki.filter(w => w.paczka === 'zapisana')).toHaveLength(1);
    expect(wyniki.filter(w => w.paczka === 'istniejaca')).toHaveLength(2);
    const uwagi = katalogUwag(repo);
    expect(readdirSync(uwagi).filter(n => n.startsWith('.tmp-'))).toEqual([]);
    expect(readFileSync(join(uwagi, ID, 'uwagi.md'), 'utf8')).toBe('# Uwagi');
  });

  it('pusty istniejący katalog paczki (bez uwagi.md) → wyjątek wewnetrzny, a nie istniejaca', async () => {
    const repo = nowyRepo(baza, 'pusta-paczka');
    mkdirSync(join(katalogUwag(repo), ID), { recursive: true });
    await expect(zapisz(repo)).rejects.toMatchObject({ kod: 'wewnetrzny' });
    expect(readdirSync(join(katalogUwag(repo), ID))).toEqual([]);
  });

  it('bardzo długa ścieżka projektu (~980 B) → za_duzy, bez surowego ENAMETOOLONG', async () => {
    const segment = 'd'.repeat(200);
    const nazwaRepo = 'dlugi';
    const koniec = `/${nazwaRepo}`;
    const docelowa = 980;
    let p = baza;
    while (Buffer.byteLength(p) + segment.length + 1 + koniec.length <= docelowa) {
      p = join(p, segment);
      mkdirSync(p);
    }
    const brak = docelowa - Buffer.byteLength(p) - koniec.length;
    if (brak > 1) {
      p = join(p, 'e'.repeat(brak - 1));
      mkdirSync(p);
    }
    const repo = nowyRepo(p, nazwaRepo);
    expect(Buffer.byteLength(repo)).toBeGreaterThan(950);
    await expect(zapisz(repo)).rejects.toMatchObject({ kod: 'za_duzy' });
  });
});

describe('sciezkaIstniejacejPaczki', () => {
  it('zwraca ścieżkę dla istniejącej paczki', async () => {
    const repo = nowyRepo(baza, 'istniejaca-sciezka');
    await zapisz(repo);
    expect(await sciezkaIstniejacejPaczki(repo, ID)).toEqual({
      paczka: 'istniejaca',
      sciezkaMdWzgledna: join(KATALOG_UWAG, ID, 'uwagi.md'),
      sciezkaMdAbsolutna: join(repo, KATALOG_UWAG, ID, 'uwagi.md'),
      ostrzezenia: [],
    });
  });

  it('rzuca id_niepoprawne dla nieistniejącej paczki', async () => {
    const repo = nowyRepo(baza, 'brak-paczki');
    await zapisz(repo);
    await expect(sciezkaIstniejacejPaczki(repo, '2026-10-09-1300-zzzzzz')).rejects.toMatchObject({ kod: 'id_niepoprawne' });
  });

  it('stara paczka bez .herestt nadal ma ścieżkę w .scratch/uwagi-ui', async () => {
    const repo = nowyRepo(baza, 'stara-sciezka');
    const k = join(repo, '.scratch', 'uwagi-ui', ID);
    mkdirSync(k, { recursive: true });
    writeFileSync(join(k, 'uwagi.md'), '# stara');
    expect(await sciezkaIstniejacejPaczki(repo, ID)).toMatchObject({
      paczka: 'istniejaca',
      sciezkaMdWzgledna: join('.scratch', 'uwagi-ui', ID, 'uwagi.md'),
    });
  });

  it('rzuca id_niepoprawne, gdy nie ma ani .herestt, ani .scratch', async () => {
    const repo = nowyRepo(baza, 'brak-scratch');
    await expect(sciezkaIstniejacejPaczki(repo, ID)).rejects.toMatchObject({ kod: 'id_niepoprawne' });
  });

  it('brak paczki, gdy .scratch jest symlinkiem: id_niepoprawne, cel nietknięty', async () => {
    const repo = nowyRepo(baza, 'scratch-symlink-odczyt');
    const cel = ofiara('odczyt');
    symlinkSync(cel, join(repo, '.scratch'));
    await expect(sciezkaIstniejacejPaczki(repo, ID)).rejects.toMatchObject({ kod: 'id_niepoprawne' });
    expect(readdirSync(cel)).toEqual([]);
  });
});

describe('PNG obcięty w połowie', () => {
  it('poprawny nagłówek i IHDR, ale bez IEND na końcu → zrzut_niepoprawny', () => {
    const obciety = PNG1.subarray(0, PNG1.length - 12).toString('base64').padEnd(Math.ceil((PNG1.length - 12) / 3) * 4, '=');
    expect(() => zweryfikujPaczke(paczkaSurowa({ zrzuty: [{ nazwa: 'uwaga-1.png', pngBase64: obciety }] }))).toThrow(
      expect.objectContaining({ kod: 'zrzut_niepoprawny' }),
    );
  });
});

describe('recenzja Codexa (codex-host.md)', () => {
  /** PNG 1×1 z podmienionymi wymiarami w IHDR — mały plik, ogromny obraz po dekodowaniu. */
  function pngOWymiarach(szer: number, wys: number): string {
    const buf = Buffer.from(PNG1);
    buf.writeUInt32BE(szer, 16);
    buf.writeUInt32BE(wys, 20);
    return buf.toString('base64');
  }

  it('nr 7: 16384×16384 (268 mln pikseli) w 70 bajtach → zrzut_niepoprawny; 8000×5000 przechodzi', () => {
    expect(() => zweryfikujPaczke(paczkaSurowa({ zrzuty: [{ nazwa: 'uwaga-1.png', pngBase64: pngOWymiarach(16384, 16384) }] }))).toThrow(
      expect.objectContaining({ kod: 'zrzut_niepoprawny' }),
    );
    expect(() => zweryfikujPaczke(paczkaSurowa({ zrzuty: [{ nazwa: 'uwaga-1.png', pngBase64: pngOWymiarach(8000, 5000) }] }))).not.toThrow();
  });

  it('nr 9: retry po zgubionej odpowiedzi nadal ostrzega, że paczka nie jest ignorowana', async () => {
    const repo = nowyRepo(baza, 'retry-ostrzezenie');
    mkdirSync(katalogUwag(repo), { recursive: true });
    writeFileSync(join(katalogUwag(repo), '.gitignore'), '!*\n');
    expect((await zapisz(repo)).ostrzezenia).toEqual(['nie_ignorowane']);
    const retry = await zapisz(repo);
    expect(retry).toMatchObject({ paczka: 'istniejaca', ostrzezenia: ['nie_ignorowane'] });
  });
});

describe('historyjka v2', () => {
  const h = { id: 'h', zrzuty: [{ id: 'z', szerokosc: 1, wysokosc: 1, kontekstStrony: { url: 'https://a/', czas: 'teraz' }, plik: 'zrzut-1.png', oryginal: 'zrzut-1-oryginal.png', adnotacje: [{ id: 'a', numer: 1, narzedzie: 'tekst', punkty: [{ x: .5, y: .5 }], kolor: '#ff0000', etykieta: 'Tu', komentarz: 'Popraw' }] }] };
  const obrazy = ['zrzut-1.png','zrzut-1-oryginal.png'].map(nazwa=>({nazwa,pngBase64:PNG1_B64}));
  it('przyjmuje kompletną parę, odrzuca brak oryginału, zły numer i nadmiarowy PNG', () => {
    expect(zweryfikowana({json:JSON.stringify({uwagi:[],historyjka:h}),zrzuty:obrazy}).pliki).toHaveLength(2);
    expect(()=>zweryfikowana({json:JSON.stringify({uwagi:[],historyjka:h}),zrzuty:obrazy.slice(0,1)})).toThrow('Brak pary');
    const zla = structuredClone(h); zla.zrzuty[0]!.adnotacje[0]!.numer = 2;
    expect(()=>zweryfikowana({json:JSON.stringify({uwagi:[],historyjka:zla}),zrzuty:obrazy})).toThrow('numeracja');
    expect(()=>zweryfikowana({json:JSON.stringify({uwagi:[],historyjka:h}),zrzuty:[...obrazy,{nazwa:'zrzut-9.png',pngBase64:PNG1_B64}]})).toThrow();
    expect(()=>zweryfikowana({zrzuty:obrazy})).toThrow('bez manifestu');
  });
});
