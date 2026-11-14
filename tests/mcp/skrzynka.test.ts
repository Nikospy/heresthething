import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { czytajStatus } from '../../src/host/status';
import { SerwerMcp } from '../../src/mcp/serwer';
import { znajdzProjekt } from '../../src/mcp/projekt';
import { Skrzynka } from '../../src/mcp/skrzynka';
import { katalogTymczasowy, nowyRepo } from '../host/pomocnicze';

const baza = katalogTymczasowy('uwagi-mcp-');
const repo = nowyRepo(baza, 'repo');
const uwagiUi = join(repo, '.scratch/uwagi-ui');
const id = '2026-11-05-1200-abc123';

function paczka(idPaczki: string, tresc: object = { uwagi: [{ numer: 1 }, { numer: 2 }] }): string {
  const k = join(uwagiUi, idPaczki);
  mkdirSync(k, { recursive: true });
  writeFileSync(join(k, 'uwagi.json'), JSON.stringify(tresc));
  writeFileSync(join(k, 'uwagi.md'), `# Uwagi ${idPaczki}\n`);
  return k;
}

const zrobione = { paczka: id, numer: 1, stan: 'done', komentarz: 'Poprawiono kontrast.' };

beforeEach(() => {
  rmSync(join(repo, '.scratch'), { recursive: true, force: true });
  rmSync(join(repo, '.herestt'), { recursive: true, force: true });
});

test('starsza paczka, której uwagi mają tylko typ, czyta się bez zmian', async () => {
  paczka(id, { schemat: 2, uwagi: [{ numer: 1, typ: 'odstęp' }] });
  const s = new Skrzynka(repo);
  expect((await s.lista()).paczki[0]).toMatchObject({ otwarte: [1] });
  await s.ustawStatus(zrobione);
  expect((await s.lista()).paczki).toEqual([]);
});

test('brak katalogu uwag to pusta lista, nie błąd', async () => {
  expect(await new Skrzynka(repo).lista()).toMatchObject({ paczki: [], pominieteStarsze: 0, uszkodzone: [] });
});

test('paczka tylko w .scratch/uwagi-ui jest na liście i da się ją odczytać', async () => {
  paczka(id);
  expect(existsSync(join(repo, '.herestt'))).toBe(false);
  const s = new Skrzynka(repo);
  expect((await s.lista()).paczki.map(p => p.id)).toEqual([id]);
  expect(await s.czytaj(id)).toContain(`# Uwagi ${id}`);
});

test('ten sam id w obu katalogach: lista ma jeden wpis i odczyt bierze .herestt', async () => {
  const stary = paczka(id);
  writeFileSync(join(stary, 'uwagi.md'), '# STARY\n');
  const nowy = join(repo, '.herestt', id);
  mkdirSync(nowy, { recursive: true });
  writeFileSync(join(nowy, 'uwagi.json'), JSON.stringify({ uwagi: [{ numer: 1 }] }));
  writeFileSync(join(nowy, 'uwagi.md'), '# NOWY\n');
  const s = new Skrzynka(repo);
  const lista = await s.lista();
  expect(lista.paczki).toHaveLength(1);
  expect(lista.paczki[0]).toMatchObject({ id, katalog: nowy });
  expect(await s.czytaj(id)).toBe('# NOWY\n');
});

test('id obecne przy starcie w starym albo nowym katalogu nie jest nowe dla czekania', async () => {
  paczka(id);
  const nowyId = '2026-11-05-1500-nowy22';
  const k = join(repo, '.herestt', nowyId);
  mkdirSync(k, { recursive: true });
  writeFileSync(join(k, 'uwagi.json'), JSON.stringify({ uwagi: [{ numer: 1 }] }));
  writeFileSync(join(k, 'uwagi.md'), '# n\n');
  const s = new Skrzynka(repo);
  await s.zapamietajIstniejace();
  expect(await s.czekaj(40, undefined, 5)).toMatchObject({ paczki: [], koniecCzasu: true });
});

test('znajdzProjekt staje na .git, .herestt albo starym katalogu uwag', () => {
  const korzen = join(baza, 'szukanie-projektu');
  const tylkoStary = join(korzen, 'tylko-stary', 'pod');
  mkdirSync(join(korzen, 'tylko-stary', '.scratch', 'uwagi-ui'), { recursive: true });
  mkdirSync(tylkoStary, { recursive: true });
  expect(znajdzProjekt(tylkoStary)).toBe(resolve(join(korzen, 'tylko-stary')));

  const tylkoNowy = join(korzen, 'tylko-nowy', 'pod');
  mkdirSync(join(korzen, 'tylko-nowy', '.herestt'), { recursive: true });
  mkdirSync(tylkoNowy, { recursive: true });
  expect(znajdzProjekt(tylkoNowy)).toBe(resolve(join(korzen, 'tylko-nowy')));

  const gitowy = join(korzen, 'gitowy', 'pod');
  mkdirSync(join(korzen, 'gitowy', '.git'), { recursive: true });
  mkdirSync(gitowy, { recursive: true });
  expect(znajdzProjekt(gitowy)).toBe(resolve(join(korzen, 'gitowy')));
});

test('lista: najnowsze najpierw, otwarte numery, zamknięta paczka znika, obce nazwy pominięte', async () => {
  paczka(id);
  paczka('2026-11-05-1300-zzz999');
  mkdirSync(join(uwagiUi, 'ui-2026-10-15T10-15-33-523Z-bca489'));
  const s = new Skrzynka(repo);
  expect((await s.lista()).paczki.map(p => p.id)).toEqual(['2026-11-05-1300-zzz999', id]);

  await s.ustawStatus(zrobione);
  await s.ustawStatus({ ...zrobione, numer: 2, stan: 'rejected', komentarz: 'Poza zakresem.' });
  expect((await s.lista()).paczki.map(p => p.id)).toEqual(['2026-11-05-1300-zzz999']);
});

test('pytanie zamyka uwagę dla agenta i zostaje widoczne jako czekające na właściciela', async () => {
  paczka(id);
  const s = new Skrzynka(repo);
  await s.ustawStatus({ ...zrobione, stan: 'question', komentarz: '16 czy 24 px?' });
  expect((await s.lista()).paczki[0]).toMatchObject({ otwarte: [2], pytania: [1] });
});

test('numery rysunków planszy liczą się do otwartych i pytań obok uwag', async () => {
  paczka(id, { uwagi: [{ numer: 1 }], plansza: { rysunki: [{ id: 'r1', numer: 2, komentarz: 'Powiększ przycisk', kreski: [] }, { id: 'r0', numer: null, komentarz: 'cel', kreski: [] }] } });
  const s = new Skrzynka(repo);
  expect((await s.lista()).paczki[0]).toMatchObject({ otwarte: [1, 2], statusPliku: 'brak' });
  // Status rysunku jego numerem działa jak uwadze, a pytanie trafia do `pytania`.
  await s.ustawStatus({ ...zrobione, numer: 2, stan: 'question', komentarz: 'Który przycisk?' });
  expect((await s.lista()).paczki[0]).toMatchObject({ otwarte: [1], pytania: [2] });
  // Rysunek bez numeru (stara plansza) nie jest pozycją do statusowania.
  await expect(s.ustawStatus({ ...zrobione, numer: 3 })).rejects.toThrow('number 3 does not exist in this bundle.');
});

test('status: zapis przechodzi przez walidator hosta, wpis się zastępuje, nie zostają pliki tymczasowe', async () => {
  const k = paczka(id);
  const s = new Skrzynka(repo);
  await s.ustawStatus(zrobione);
  await s.ustawStatus({ ...zrobione, komentarz: 'Druga wersja.' });
  expect(await czytajStatus(repo, id)).toMatchObject({
    plik: 'jest',
    statusy: [{ numer: 1, stan: 'done', komentarz: 'Druga wersja.' }],
    historyjka: [],
  });
  expect(readdirSync(k).filter(n => n.endsWith('.tmp'))).toEqual([]);
});

test('status: równoległe wywołania nie gubią wpisów', async () => {
  paczka(id);
  const s = new Skrzynka(repo);
  await Promise.all([s.ustawStatus(zrobione), s.ustawStatus({ ...zrobione, numer: 2 })]);
  expect((await czytajStatus(repo, id)).statusy.map(w => w.numer)).toEqual([1, 2]);
});

test('status historyjki nie miesza się z numerami uwag i nie gubi ich', async () => {
  paczka(id, { uwagi: [{ numer: 1 }], historyjka: { zrzuty: [{ adnotacje: [{ numer: 7 }] }] } });
  const s = new Skrzynka(repo);
  await s.ustawStatus(zrobione);
  await s.ustawStatus({ ...zrobione, numer: 7, historyjka: true });
  const wynik = await czytajStatus(repo, id);
  expect(wynik.statusy.map(w => w.numer)).toEqual([1]);
  expect(wynik.historyjka.map(w => w.numer)).toEqual([7]);
});

test.each([
  ['numer spoza paczki', { numer: 99 }, /does not exist/],
  ['numer ułamkowy', { numer: 1.5 }, /integer/],
  ['nieznany stan', { stan: 'acknowledged' }, /state must/],
  ['pusty komentarz', { komentarz: '  ' }, /empty/],
  ['za długi komentarz', { komentarz: 'x'.repeat(501) }, /500/],
])('status odrzuca: %s, bez tworzenia pliku', async (_n, zmiana, wzor) => {
  const k = paczka(id);
  await expect(new Skrzynka(repo).ustawStatus({ ...zrobione, ...zmiana })).rejects.toThrow(wzor);
  expect(existsSync(join(k, 'status.json'))).toBe(false);
});

test('status nie nadpisuje pliku, którego nie rozumie', async () => {
  const k = paczka(id);
  writeFileSync(join(k, 'status.json'), '{ zepsuty');
  await expect(new Skrzynka(repo).ustawStatus(zrobione)).rejects.toThrow(/invalid/);
  expect(readFileSync(join(k, 'status.json'), 'utf8')).toBe('{ zepsuty');
  expect((await new Skrzynka(repo).lista()).paczki[0]).toMatchObject({ id, statusPliku: 'niepoprawny' });
});

test('ścieżka z .. jest odrzucana przed dotknięciem dysku', async () => {
  paczka(id);
  await expect(new Skrzynka(repo).czytaj('../../obcy')).rejects.toMatchObject({ kod: 'id_niepoprawne' });
  await expect(new Skrzynka(repo).ustawStatus({ ...zrobione, paczka: '../../obcy' })).rejects.toMatchObject({ kod: 'id_niepoprawne' });
});

test('zły .scratch (dowiązanie albo plik) nie wywala listy, gdy paczka jest w .herestt', async () => {
  const idH = '2026-11-05-1500-herest';
  const k = join(repo, '.herestt', idH);
  mkdirSync(k, { recursive: true });
  writeFileSync(join(k, 'uwagi.json'), JSON.stringify({ uwagi: [{ numer: 1 }] }));
  writeFileSync(join(k, 'uwagi.md'), '# x\n');
  symlinkSync(baza, join(repo, '.scratch'));
  await expect(new Skrzynka(repo).lista()).resolves.toMatchObject({ paczki: [expect.objectContaining({ id: idH })] });
  rmSync(join(repo, '.scratch'));
  writeFileSync(join(repo, '.scratch'), 'nie katalog');
  const poPliku = new Skrzynka(repo);
  await expect(poPliku.lista()).resolves.toMatchObject({ paczki: [expect.objectContaining({ id: idH })] });
  await expect(poPliku.czekaj(20, undefined, 5)).resolves.toMatchObject({ paczki: [], koniecCzasu: true });
});

test('błędy zapiszStatus nazywają number, state i comment', async () => {
  paczka(id);
  const s = new Skrzynka(repo);
  await expect(s.ustawStatus({ ...zrobione, numer: 1.5 })).rejects.toThrow(/number/);
  await expect(s.ustawStatus({ ...zrobione, stan: 'acknowledged' })).rejects.toThrow(/state/);
  await expect(s.ustawStatus({ ...zrobione, komentarz: '  ' })).rejects.toThrow(/comment/);
});

test('symlinki: katalog paczki, uwagi.md i .scratch nie wyprowadzają poza projekt', async () => {
  const obcy = join(baza, 'obcy');
  mkdirSync(obcy, { recursive: true });
  writeFileSync(join(obcy, 'sekret.md'), 'SEKRET');

  const k = paczka(id);
  rmSync(join(k, 'uwagi.md'));
  symlinkSync(join(obcy, 'sekret.md'), join(k, 'uwagi.md'));
  await expect(new Skrzynka(repo).czytaj(id)).rejects.toThrow();

  rmSync(k, { recursive: true });
  symlinkSync(obcy, k);
  await expect(new Skrzynka(repo).czytaj(id)).rejects.toThrow();
  expect((await new Skrzynka(repo).lista()).paczki).toEqual([]);
  await expect(new Skrzynka(repo).ustawStatus(zrobione)).rejects.toThrow();
  expect(readdirSync(obcy)).toEqual(['sekret.md']);

  rmSync(join(repo, '.scratch'), { recursive: true });
  symlinkSync(obcy, join(repo, '.scratch'));
  await expect(new Skrzynka(repo).lista()).resolves.toMatchObject({ paczki: [] });
  expect(readdirSync(obcy)).toEqual(['sekret.md']);
});

test('czekaj: stara paczka nie wraca, nowa kończy oczekiwanie i wraca tylko raz', async () => {
  paczka(id);
  const s = new Skrzynka(repo);
  await s.zapamietajIstniejace();
  expect(await s.czekaj(20, undefined, 5)).toMatchObject({ paczki: [], koniecCzasu: true });

  const nowy = '2026-11-05-1400-nowa11';
  const oczekiwanie = s.czekaj(2000, undefined, 5);
  paczka(nowy);
  expect(await oczekiwanie).toMatchObject({ koniecCzasu: false, paczki: [{ id: nowy, otwarte: [1, 2] }] });
  expect(await s.czekaj(20, undefined, 5)).toMatchObject({ paczki: [], koniecCzasu: true });
});

test('czekaj: lista zalicza paczkę jako widzianą, a sygnał przerywa', async () => {
  const s = new Skrzynka(repo);
  await s.zapamietajIstniejace();
  paczka(id);
  await s.lista();
  expect(await s.czekaj(20, undefined, 5)).toMatchObject({ paczki: [] });

  const sterownik = new AbortController();
  const oczekiwanie = s.czekaj(60_000, sterownik.signal, 60_000);
  sterownik.abort();
  await expect(oczekiwanie).rejects.toThrow(/anulowane/);
});

function klient() {
  const wyslane: Record<string, any>[] = [];
  const serwer = new SerwerMcp(new Skrzynka(repo), o => wyslane.push(o), 'test');
  return { wyslane, wyslij: (w: object) => serwer.obsluz(JSON.stringify(w)), serwer };
}

test('protokół: initialize uzgadnia wersję, tools/list zwraca cztery narzędzia, powiadomienie bez odpowiedzi', async () => {
  const { wyslane, wyslij } = klient();
  await wyslij({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await wyslij({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await wyslij({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  await wyslij({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  await wyslij({ jsonrpc: '2.0', id: 4, method: 'ping' });
  expect(wyslane.map(o => o.id)).toEqual([1, 2, 3, 4]);
  expect(wyslane[0]!.result.protocolVersion).toBe('2025-06-18');
  expect(wyslane[0]!.result.serverInfo).toEqual({ name: 'herestt', version: 'test' });
  expect(wyslane[1]!.result.protocolVersion).toBe('2025-11-25');
  const narzedzia = wyslane[2]!.result.tools as { name: string; description: string }[];
  expect(narzedzia.map(t => t.name)).toEqual(['notes_list', 'notes_read', 'notes_wait', 'notes_status']);
  const opisy = [wyslane[0]!.result.instructions, ...narzedzia.map(t => t.description)].join('\n');
  expect(opisy).toContain("Here's the Thing extension");
  expect(opisy).not.toContain('Tryb uwag extension');
  expect(opisy).not.toContain('uwagi_');
  expect(opisy).not.toContain('zrobione');
  expect(opisy).toContain('bundles');
  expect(opisy).toContain('timedOut');
  expect(opisy).toContain('board.image');
  expect(opisy).toContain('board.drawings');
  expect(wyslane[3]!.result).toEqual({});
});

test('protokół: błędy JSON-RPC, a błąd narzędzia wraca jako isError', async () => {
  const { wyslane, wyslij, serwer } = klient();
  await serwer.obsluz('{zepsuty');
  await wyslij({ jsonrpc: '2.0', id: 1, method: 'nieznana' });
  await wyslij({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nieznane' } });
  await wyslij({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'notes_read', arguments: { bundle: '../x' } } });
  await wyslij({ jsonrpc: '2.0', id: 9, result: {} });
  await wyslij({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'uwagi_status', arguments: { bundle: id, number: 1, state: 'done', comment: 'x' } } });
  expect(wyslane.map(o => o.error?.code)).toEqual([-32700, -32601, -32602, undefined, -32602]);
  expect(wyslane[3]!.result.isError).toBe(true);
});

test('notes_status wraca number, state i comment, a opis board każe podać 1', async () => {
  paczka(id);
  const { wyslane, wyslij } = klient();
  await wyslij({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const narzedzie = (wyslane[0]!.result.tools as { name: string; inputSchema: { properties: { board: { description: string } } } }[]).find(t => t.name === 'notes_status');
  expect(narzedzie!.inputSchema.properties.board.description).not.toContain('pass 0');
  expect(narzedzie!.inputSchema.properties.board.description).toContain('pass 1');
  await wyslij({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'notes_status', arguments: { bundle: id, number: 1, state: 'done', comment: 'Gotowe.' } } });
  expect(JSON.parse(wyslane[1]!.result.content[0].text)).toEqual({ number: 1, state: 'done', comment: 'Gotowe.' });
});

test('protokół: cały przebieg lista, czytaj, status', async () => {
  paczka(id);
  const { wyslane, wyslij } = klient();
  const zawolaj = (nr: number, name: string, args: object = {}) => wyslij({ jsonrpc: '2.0', id: nr, method: 'tools/call', params: { name, arguments: args } });
  await zawolaj(1, 'notes_list');
  await zawolaj(2, 'notes_read', { bundle: id });
  await zawolaj(3, 'notes_status', { bundle: id, number: 1, state: 'done', comment: 'Poprawiono kontrast.' });
  expect(JSON.parse(wyslane[0]!.result.content[0].text).bundles[0].id).toBe(id);
  expect(wyslane[1]!.result.content[0].text).toContain(`# Uwagi ${id}`);
  expect(wyslane[2]!.result.isError).toBeUndefined();
  expect((await czytajStatus(repo, id)).statusy).toHaveLength(1);
});

test('protokół: plik ze stanem pytanie wraca w questions, notes_status zapisuje done i odrzuca zrobione', async () => {
  const k = paczka(id);
  writeFileSync(join(k, 'status.json'), JSON.stringify({ uwagi: [{ numer: 1, stan: 'pytanie', komentarz: '16 czy 24?' }] }));
  const { wyslane, wyslij } = klient();
  const zawolaj = (nr: number, name: string, args: object = {}) => wyslij({ jsonrpc: '2.0', id: nr, method: 'tools/call', params: { name, arguments: args } });
  await zawolaj(1, 'notes_list');
  const lista = JSON.parse(wyslane[0]!.result.content[0].text) as { bundles: { questions: number[]; open: number[] }[] };
  expect(lista.bundles[0]!.questions).toEqual([1]);
  expect(lista.bundles[0]!.open).toEqual([2]);
  await zawolaj(2, 'notes_status', { bundle: id, number: 2, state: 'done', comment: 'Druga zamknięta.' });
  expect(wyslane[1]!.result.isError).toBeUndefined();
  expect(JSON.parse(readFileSync(join(k, 'status.json'), 'utf8'))).toEqual({
    uwagi: [
      { numer: 1, stan: 'question', komentarz: '16 czy 24?' },
      { numer: 2, stan: 'done', komentarz: 'Druga zamknięta.' },
    ],
  });
  const przedOdmowa = readFileSync(join(k, 'status.json'), 'utf8');
  await zawolaj(3, 'notes_status', { bundle: id, number: 2, state: 'zrobione', comment: 'Nie wolno.' });
  expect(wyslane[2]!.result.isError).toBe(true);
  expect(readFileSync(join(k, 'status.json'), 'utf8')).toBe(przedOdmowa);
});

test('protokół: anulowane czekanie nie wysyła odpowiedzi i nie blokuje innych wywołań', async () => {
  const { wyslane, wyslij } = klient();
  const czekanie = wyslij({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes_wait', arguments: { seconds: 60 } } });
  await wyslij({ jsonrpc: '2.0', id: 2, method: 'ping' });
  expect(wyslane.map(o => o.id)).toEqual([2]);
  await wyslij({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  await czekanie;
  expect(wyslane.map(o => o.id)).toEqual([2]);
});

test('paczka z samą planszą jest na liście, ze ścieżką szkicu, a status planszy ją zamyka i nie rusza statusów uwag', async () => {
  const k = paczka(id, { uwagi: [{ numer: 1 }], plansza: { id: 'p', obraz: { plik: 'plansza.png', tlo: 'strona' } } });
  const s = new Skrzynka(repo);
  let lista = await s.lista();
  expect(lista.paczki[0]?.plansza).toEqual({ otwarta: true, obraz: join(k, 'plansza.png') });

  await s.ustawStatus(zrobione);
  lista = await s.lista();
  // Uwaga zamknięta, plansza jeszcze nie: praca dalej jest otwarta.
  expect(lista.paczki[0]?.otwarte).toEqual([]);
  expect(lista.paczki[0]?.plansza?.otwarta).toBe(true);

  await s.ustawStatus({ paczka: id, numer: 0, stan: 'done', komentarz: 'Szkic przejrzany.', plansza: true });
  expect((await s.lista()).paczki).toEqual([]);
  expect((await czytajStatus(repo, id)).statusy.map(w => w.numer)).toEqual([1]);

  // Kolejny status uwagi nie gubi statusu planszy.
  await s.ustawStatus({ ...zrobione, komentarz: 'Poprawiono jeszcze raz.' });
  expect((await s.lista()).paczki).toEqual([]);
});

test('sama plansza bez kresek też jest pracą; obraz wtedy null. Status planszy w paczce bez planszy to błąd', async () => {
  paczka(id, { uwagi: [], plansza: { id: 'p' } });
  const s = new Skrzynka(repo);
  expect((await s.lista()).paczki[0]?.plansza).toEqual({ otwarta: true, obraz: null });
  paczka('2026-11-05-1300-abc123', { uwagi: [{ numer: 1 }] });
  await expect(s.ustawStatus({ paczka: '2026-11-05-1300-abc123', numer: 0, stan: 'done', komentarz: 'x', plansza: true })).rejects.toThrow('This bundle has no board.');
});

test('paczka bez planszy nie ma pola plansza: opis jest taki jak wcześniej', async () => {
  paczka(id);
  expect((await new Skrzynka(repo).lista()).paczki[0]).not.toHaveProperty('plansza');
});

const czeka = join(repo, '.herestt', '.agent-czeka');

test('R5: czekaj odświeża znacznik czekania najwyżej co 3 s', async () => {
  const s = new Skrzynka(repo);
  await s.czekaj(10, undefined, 1);
  expect(existsSync(czeka)).toBe(true);
  expect(existsSync(join(repo, '.scratch'))).toBe(false);
  const stary = new Date(Date.now() - 60_000);
  utimesSync(czeka, stary, stary);
  await s.czekaj(10, undefined, 1);
  // drugi `czekaj` tej samej skrzynki w oknie 3 s nie dotyka znacznika
  expect(statSync(czeka).mtimeMs).toBeLessThan(Date.now() - 30_000);
  await new Skrzynka(repo).czekaj(10, undefined, 1);
  expect(statSync(czeka).mtimeMs).toBeGreaterThan(Date.now() - 5_000);
});

test('R5: czekaj przed pierwszym zapisem zakłada .herestt z .gitignore i nie idzie za dowiązaniem tego liścia', async () => {
  await new Skrzynka(repo).czekaj(10, undefined, 1);
  expect(existsSync(czeka)).toBe(true);
  expect(readFileSync(join(repo, '.herestt', '.gitignore'), 'utf8')).toContain('*');
  expect(existsSync(join(repo, '.scratch'))).toBe(false);
  rmSync(join(repo, '.herestt'), { recursive: true, force: true });
  const obcy = join(baza, 'obcy-czekanie');
  mkdirSync(obcy, { recursive: true });
  symlinkSync(obcy, join(repo, '.herestt'));
  await new Skrzynka(repo).czekaj(10, undefined, 1).catch(() => undefined);
  expect(readdirSync(obcy)).toEqual([]);
  rmSync(join(repo, '.herestt'));
});

test('R5: czekaj nie pada, gdy znacznika nie da się zapisać', async () => {
  const katalog = join(repo, '.herestt');
  mkdirSync(katalog, { recursive: true });
  chmodSync(katalog, 0o500);
  try {
    expect(await new Skrzynka(repo).czekaj(10, undefined, 1)).toMatchObject({ koniecCzasu: true });
  } finally {
    chmodSync(katalog, 0o700);
  }
  expect(existsSync(czeka)).toBe(false);
});

test('R6: czekaj, lista i czytaj zapisują odebrane.json; lista nie oznacza paczek, których nie zwraca', async () => {
  const s = new Skrzynka(repo);
  mkdirSync(uwagiUi, { recursive: true });
  const nowa = '2026-11-05-1300-nowa11';
  const czekanie = s.czekaj(5_000, undefined, 10);
  const k = paczka(nowa);
  expect(await czekanie).toMatchObject({ koniecCzasu: false });
  const odebrane = JSON.parse(readFileSync(join(k, 'odebrane.json'), 'utf8')) as { czas: string };
  expect(Number.isNaN(Date.parse(odebrane.czas))).toBe(false);

  const k1 = paczka(id);
  const zamknieta = '2026-11-05-1100-zamkn1';
  const kz = paczka(zamknieta, { uwagi: [{ numer: 1 }] });
  await new Skrzynka(repo).ustawStatus({ ...zrobione, paczka: zamknieta });
  await new Skrzynka(repo).lista();
  expect(existsSync(join(k1, 'odebrane.json'))).toBe(true);
  expect(existsSync(join(kz, 'odebrane.json'))).toBe(false);

  const k3 = paczka('2026-11-05-1400-czyt11');
  await new Skrzynka(repo).czytaj('2026-11-05-1400-czyt11');
  expect(existsSync(join(k3, 'odebrane.json'))).toBe(true);
});

test('R6: istniejący odebrane.json nie jest nadpisywany, a symlink nie jest śledzony', async () => {
  const k = paczka(id);
  writeFileSync(join(k, 'odebrane.json'), '{"czas":"2020-01-01T00:00:00.000Z"}');
  await new Skrzynka(repo).czytaj(id);
  expect(readFileSync(join(k, 'odebrane.json'), 'utf8')).toBe('{"czas":"2020-01-01T00:00:00.000Z"}');
  const k2 = paczka('2026-11-05-1500-symlk1');
  const obcy = join(baza, 'obcy-odbior.json');
  writeFileSync(obcy, 'obcy');
  symlinkSync(obcy, join(k2, 'odebrane.json'));
  await new Skrzynka(repo).czytaj('2026-11-05-1500-symlk1');
  expect(readFileSync(obcy, 'utf8')).toBe('obcy');
});
