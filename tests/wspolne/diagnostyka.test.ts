import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { OBJAWY, bezpiecznie, maBlad, maskuj, pierwszeDzialanie, renderuj, wiersz, type Wiersz } from '../../src/wspolne/diagnostyka';

/** S-33 faza 1 (D1–D4): rdzeń raportu. Czysty tekst, bez I/O. */

const KORZEN = join(import.meta.dirname, '../..');
const MASKI = [
  { prefiks: '/home/jan', jako: '~' },
  { prefiks: '/private/var/x/profil', jako: '<profil>' },
  { prefiks: '/private/var/x', jako: '<tmp>' },
];

describe('D1 maskuj', () => {
  test('prefiksy schodzą do ~ i <profil>, dłuższy pierwszy, z granicą nazwy', () => {
    expect(maskuj('/home/jan/.config/herestt/config.json', MASKI)).toBe('~/.config/herestt/config.json');
    expect(maskuj('/private/var/x/profil/herestt', MASKI)).toBe('<profil>/herestt');
    expect(maskuj('/private/var/x/inny', MASKI)).toBe('<tmp>/inny');
    expect(maskuj('/home/janusz/a', MASKI)).toBe('/home/janusz/a');
    expect(maskuj('/home/jan', MASKI)).toBe('~');
  });

  test.each([
    ['sk-abcdefghijklmnop1234', 'sk-'],
    ['ghp_ABCDEFGHIJKLMNOPQRSTU', 'ghp_'],
    ['xoxb-12345678-abcdefgh', 'xoxb-'],
    ['Bearer eyJhbGciOiJIUzI1NiJ9.abc', 'eyJ'],
    ['token=tajnawartosc123', 'tajnawartosc'],
    ['API_KEY: "tajna wartosc"', 'tajna'],
    ['hasło=zaq12wsx', 'zaq12'],
    [`ciag ${'a1B2'.repeat(12)} koniec`, 'a1B2a1B2'],
    // Sklejone w czasie testu: literał w kształcie klucza AWS zatrzymałby skanery sekretów w publicznym repo (S-37).
    [`AKIA${'ABCDEFGHIJKLMNOP'}`, 'AKIA'],
  ])('sekret %s nie przechodzi', (wejscie, kanarek) => {
    const wynik = maskuj(wejscie);
    expect(wynik).not.toContain(kanarek.length > 4 ? kanarek : wejscie);
    expect(wynik).toContain('[ukryte]');
  });

  test('id wtyczki (32 znaki a-p) zostaje', () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    expect(maskuj(`chrome-extension://${id}/`)).toContain(id);
  });

  test('ESC, NUL i nowe linie znikają, wynik to jedna linia', () => {
    const wynik = maskuj('a\u001b[31mb\u0000c\nd\r\ne\tf');
    expect(wynik).toBe('a[31mbc d e f');
    expect(wynik).not.toMatch(/[\u0000-\u001f]/);
  });

  test('1 MB wejścia: ≤ 300 znaków, bez wyjątku i szybko', () => {
    const start = Date.now();
    const wynik = maskuj('x '.repeat(500_000), MASKI);
    expect(wynik.length).toBeLessThanOrEqual(300);
    expect(wynik.endsWith('…')).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('nie-tekst nie rzuca', () => {
    expect(maskuj(undefined)).toBe('undefined');
    expect(maskuj(42)).toBe('42');
    expect(maskuj({ toString() { throw new Error('x'); } })).toBe('');
    expect(maskuj(null)).toBe('null');
  });
});

describe('D2 renderuj', () => {
  test('tekst, działanie, tytuł i nagłówek przechodzą przez maskuj', () => {
    const kanarek = 'token=CANARY12345 /home/jan/tajny';
    const w: Wiersz = { poziom: 'blad', kod: 'x', tekst: kanarek, dzialanie: kanarek };
    const wynik = renderuj([kanarek], [{ tytul: kanarek, wiersze: [w] }], 'pl', MASKI);
    expect(wynik).not.toContain('CANARY12345');
    expect(wynik).not.toContain('/home/jan');
    expect(wynik).toContain('~/tajny');
  });

  test('etykiety i działanie w obu językach', () => {
    const w = wiersz('blad', 'plik_brak:mcp.mjs', 'pl', { szczegol: 'mcp.mjs', polecenie: 'npx heresthething@1.2.3' });
    expect(renderuj([], [{ tytul: 'T', wiersze: [w] }], 'pl')).toMatch(/\[błąd\] {2}plik_brak:mcp\.mjs: .*\(mcp\.mjs\)\n {8}Działanie: .*npx heresthething@1\.2\.3/);
    const e = wiersz('uwaga', 'agent_bez_wpisu', 'en', { polecenie: 'npx heresthething@1.2.3' });
    expect(renderuj([], [{ tytul: 'T', wiersze: [e] }], 'en')).toMatch(/\[warn\] {2}agent_bez_wpisu: .*\n {8}Action: /);
  });

  test('działanie tylko dla uwaga i blad', () => {
    expect(wiersz('info', 'plik_brak', 'pl').dzialanie).toBeUndefined();
    expect(wiersz('ok', 'plik_brak', 'pl').dzialanie).toBeUndefined();
    expect(wiersz('uwaga', 'plik_brak', 'pl').dzialanie).toContain('npx heresthething');
  });

  test('maBlad i pierwszeDzialanie: błąd wygrywa z uwagą', () => {
    const uwaga = wiersz('uwaga', 'agent_bez_wpisu', 'pl', { polecenie: 'A' });
    const blad = wiersz('blad', 'plik_brak', 'pl', { polecenie: 'B' });
    expect(maBlad([{ tytul: 't', wiersze: [uwaga] }])).toBe(false);
    expect(maBlad([{ tytul: 't', wiersze: [uwaga, blad] }])).toBe(true);
    expect(pierwszeDzialanie([{ tytul: 't', wiersze: [uwaga, blad] }])).toContain('B');
    expect(pierwszeDzialanie([{ tytul: 't', wiersze: [uwaga] }])).toContain('A');
    expect(pierwszeDzialanie([{ tytul: 't', wiersze: [wiersz('info', 'system', 'pl')] }])).toBeUndefined();
  });
});

describe('D3 bezpiecznie', () => {
  test.each([
    ['wyjątek', () => { throw new Error('boom'); }],
    ['zły kształt', () => ({ nie: 'wiersz' }) as unknown as Wiersz],
    ['tablica z śmieciem', () => [wiersz('ok', 'system', 'pl'), 42] as unknown as Wiersz[]],
    ['null', () => null as unknown as Wiersz],
    ['string', () => 'x' as unknown as Wiersz],
  ])('%s → jeden wiersz blad kontrola_nieudana', (_nazwa, fn) => {
    const wynik = bezpiecznie('proba', fn, 'pl');
    expect(wynik).toHaveLength(1);
    expect(wynik[0]).toMatchObject({ poziom: 'blad', kod: 'kontrola_nieudana:proba' });
  });

  test('undefined to brak wierszy, poprawny wiersz przechodzi, reszta raportu idzie dalej', () => {
    expect(bezpiecznie('a', () => undefined, 'pl')).toEqual([]);
    const ok = wiersz('ok', 'system', 'pl');
    expect(bezpiecznie('a', () => ok, 'pl')).toEqual([ok]);
    const razem = [
      ...bezpiecznie('a', () => { throw new Error('x'); }, 'pl'),
      ...bezpiecznie('b', () => ok, 'pl'),
    ];
    expect(razem.map(w => w.kod)).toEqual(['kontrola_nieudana:a', 'system']);
  });
});

describe('D4 słownik objawów', () => {
  test('każdy wpis ma pl i en, a działanie jest w obu językach albo w żadnym', () => {
    for (const [kod, o] of Object.entries(OBJAWY)) {
      expect(o.pl.length, kod).toBeGreaterThan(0);
      expect(o.en.length, kod).toBeGreaterThan(0);
      expect(o.dzialaniePl === undefined, kod).toBe(o.dzialanieEn === undefined);
    }
  });

  test('nieznany kod rzuca (błąd programisty), znany z sufiksem działa', () => {
    expect(() => wiersz('ok', 'nie_ma_takiego', 'pl')).toThrow();
    expect(wiersz('ok', 'plik_brak:host.mjs', 'pl').kod).toBe('plik_brak:host.mjs');
  });

  test('wszystkie kody użyte w doctor.ts i raport.ts są w słowniku', () => {
    for (const plik of ['src/host/doctor.ts', 'src/ext/polaczenie/raport.ts']) {
      const sciezka = join(KORZEN, plik);
      if (!existsSync(sciezka)) continue;
      const zrodlo = readFileSync(sciezka, 'utf8');
      const uzyte = [...zrodlo.matchAll(/\bwiersz\(\s*[^,]+,\s*[`'"]([a-z_]+)/g)].map(t => t[1] ?? '');
      for (const kod of uzyte) expect(OBJAWY[kod], `${plik}: ${kod}`).toBeDefined();
    }
  });

  test('ten sam kod daje to samo zdanie niezależnie od wywołującego', () => {
    expect(wiersz('blad', 'host_padl', 'pl', { polecenie: 'X' }).tekst).toBe(wiersz('blad', 'host_padl', 'pl', { polecenie: 'Y' }).tekst);
  });
});
