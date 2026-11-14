import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agenciHcProjektu, agenciProjektu, agenciWProjekcie, parsujListe, parsujListeHc, parsujRekordHc, wyslijPrompt, zgodnaTozsamosc } from '../../src/host/agenci';
import { binarkiPrawdziwe, katalogTymczasowy } from './pomocnicze';

/** Nagrane z prawdziwego `herdr agent list` / `get` (herdr 0.9.3), 2026-10-09. */
const LISTA = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/herdr-agent-list-2026-10-09.json'), 'utf8')) as {
  result: { agents: Record<string, unknown>[] };
};
const GET = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/herdr-agent-get-2026-10-09.json'), 'utf8')) as {
  result: { agent: Record<string, unknown> };
};

/** Nagrane z PRAWDZIWEGO rdzenia herdr-core (`hc ls/get --json`), 2026-11-05, zanonimizowane. */
const LS_HC = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/hc-ls-2026-11-05.json'), 'utf8')) as { terminals: Record<string, unknown>[] };
const GET_HC = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/hc-get-2026-11-05.json'), 'utf8')) as {
  'claude-done': Record<string, unknown>;
  'claude-idle': Record<string, unknown>;
  'powloka': Record<string, unknown>;
};

const baza = katalogTymczasowy();
const projekt = join(baza, 'proj');
mkdirSync(join(projekt, 'apps', 'web'), { recursive: true });
mkdirSync(join(baza, 'proj-2'));

const claude = LISTA.result.agents.find(a => a.agent === 'claude')!;
const codex = LISTA.result.agents.find(a => a.agent === 'codex')!;

function agent(baz: Record<string, unknown>, zmiany: Record<string, unknown>): Record<string, unknown> {
  return { ...baz, ...zmiany };
}

describe('parsujListe (nagrana lista)', () => {
  it('czyta wszystkich agentów; Codex nie ma sesji, Claude ma', () => {
    const surowi = parsujListe(LISTA);
    expect(surowi).toHaveLength(LISTA.result.agents.length);
    expect(surowi.filter(a => a.agent === 'codex').every(a => a.agent_session === null)).toBe(true);
    expect(surowi.filter(a => a.agent === 'claude').every(a => typeof a.agent_session === 'string')).toBe(true);
  });

  it('odrzuca odpowiedź bez result.agents', () => {
    expect(() => parsujListe({ result: {} })).toThrow(expect.objectContaining({ kod: 'herdr_niedostepny' }));
  });
});

describe('agenciWProjekcie', () => {
  it('zostawia agentów z katalogiem pracy w projekcie, po realpath i granicy komponentu', async () => {
    // `/var/...` to symlink do `/private/var/...` na macOS — realpath musi to wyrównać.
    const przezSymlink = join(projekt, 'apps', 'web').replace(/^\/private\/var\//, '/var/');
    const surowi = parsujListe({
      result: {
        agents: [
          agent(claude, { pane_id: 'w1:p1', cwd: projekt, foreground_cwd: projekt }),
          agent(codex, { pane_id: 'w1:p2', cwd: przezSymlink, foreground_cwd: przezSymlink }),
          agent(claude, { pane_id: 'w1:p3', cwd: join(baza, 'proj-2'), foreground_cwd: join(baza, 'proj-2') }),
          // pane w projekcie, ale proces na pierwszym planie gdzie indziej (H5)
          agent(claude, { pane_id: 'w1:p4', cwd: projekt, foreground_cwd: join(baza, 'proj-2') }),
          agent(claude, { pane_id: 'w1:p5', cwd: join(baza, 'nie-istnieje'), foreground_cwd: join(baza, 'nie-istnieje') }),
          agent(claude, { pane_id: 'w1:p6', agent: 'gemini', agent_status: 'dziwny', cwd: projekt, foreground_cwd: null }),
        ],
      },
    });
    const wynik = await agenciWProjekcie(surowi, projekt);
    expect(wynik.map(a => a.paneId)).toEqual(['w1:p1', 'w1:p2', 'w1:p6']);
    expect(wynik[1]).toMatchObject({ rodzaj: 'codex', sesjaAgenta: null, cwd: join(projekt, 'apps', 'web') });
    expect(wynik[2]).toMatchObject({ rodzaj: 'inny', rodzajSurowy: 'gemini', status: 'unknown' });
  });
});

describe('zgodnaTozsamosc (H5)', () => {
  const surowy = parsujListe({ result: { agents: [agent(claude, { cwd: projekt, foreground_cwd: projekt })] } })[0]!;
  const tozsamosc = { zrodlo: 'tui' as const, program: null, paneId: surowy.pane_id, terminalId: surowy.terminal_id, sesjaAgenta: surowy.agent_session };

  it('zgodna, gdy pane, terminal, sesja i katalog pasują', async () => {
    expect(await zgodnaTozsamosc(tozsamosc, surowy, projekt)).toBe(true);
  });

  it.each([
    ['inny terminal w tym samym pane', { terminalId: 'term_inny' }],
    ['inna sesja agenta', { sesjaAgenta: 'inna' }],
    ['oczekiwano braku sesji (Codex), a jest sesja', { sesjaAgenta: null }],
  ])('niezgodna: %s', async (_o, zmiana) => {
    expect(await zgodnaTozsamosc({ ...tozsamosc, ...zmiana }, surowy, projekt)).toBe(false);
  });

  it('niezgodna, gdy agent przeszedł do innego katalogu', async () => {
    expect(await zgodnaTozsamosc(tozsamosc, { ...surowy, foreground_cwd: join(baza, 'proj-2') }, projekt)).toBe(false);
  });
});

/**
 * Fałszywy herdr: odtwarza nagrane odpowiedzi z 2026-10-09 i zapisuje, które
 * komendy dostał. Testuje tylko nasze mapowanie kodów i kolejność get→prompt.
 */
const EKRAN_ZWYKLY = readFileSync(join(import.meta.dirname, 'fixtures/ekrany/claude-bez-dialogu.txt'), 'utf8');
const ekranZDialogiem = (plik: string) => readFileSync(join(import.meta.dirname, 'fixtures/ekrany', plik), 'utf8');

function falszywyHerdr(wejscie: { get: [number, string, string]; prompt: [number, string, string]; read?: [number, string, string] }) {
  const odpowiedzi = { read: [0, EKRAN_ZWYKLY, ''] as [number, string, string], ...wejscie };
  const k = join(baza, `herdr-${Math.random().toString(36).slice(2)}`);
  mkdirSync(k);
  const dziennik = join(k, 'wywolania.txt');
  const sciezka = join(k, 'herdr');
  writeFileSync(
    sciezka,
    `#!${process.execPath}\nconst fs=require('fs');const o=${JSON.stringify(odpowiedzi)};const k=process.argv[3];` +
      `fs.appendFileSync(${JSON.stringify(dziennik)}, k+'\\n');const [kod,out,err]=o[k];process.stdout.write(out);process.stderr.write(err);process.exit(kod);\n`,
  );
  chmodSync(sciezka, 0o755);
  return { b: { ...binarkiPrawdziwe(), herdr: sciezka }, wywolania: () => (existsSync(dziennik) ? readFileSync(dziennik, 'utf8').trim().split('\n') : []) };
}

describe('wyslijPrompt (fałszywy herdr: odtwarza nagrane odpowiedzi z 2026-10-09)', () => {
  const agentGet: Record<string, unknown> = { ...GET.result.agent, cwd: projekt, foreground_cwd: projekt };
  const getOk: [number, string, string] = [0, JSON.stringify({ id: 'cli:agent:get', result: { agent: agentGet } }), ''];
  const promptOk: [number, string, string] = [0, '{"id":"cli:agent:prompt","result":{"type":"agent_prompted"}}', ''];
  const tozsamosc = {
    zrodlo: 'tui' as const,
    program: null,
    paneId: agentGet.pane_id as string,
    terminalId: agentGet.terminal_id as string,
    sesjaAgenta: (agentGet.agent_session as { value: string }).value,
  };

  const bezPromptu = (h: { wywolania: () => string[] }) => expect(h.wywolania()).not.toContain('prompt');
  const getZeStatusem = (status: string): [number, string, string] => [0, JSON.stringify({ result: { agent: { ...agentGet, agent_status: status } } }), ''];

  it('zwykły Codex w wąskim pane przyjmuje prompt, nadal po kontroli ekranu', async () => {
    const get: [number, string, string] = [0, JSON.stringify({ result: { agent: { ...agentGet, agent: 'codex', agent_status: 'idle', agent_session: null } } }), ''];
    const h = falszywyHerdr({ get, prompt: promptOk, read: [0, ekranZDialogiem('codex-bez-dialogu-waski.txt'), ''] });
    expect(await wyslijPrompt(h.b, projekt, { ...tozsamosc, sesjaAgenta: null }, 'Uwagi x')).toEqual({ prompt: 'przyjety', ostrzezenia: [] });
    expect(h.wywolania()).toEqual(['get', 'read', 'prompt']);
  });

  it('zgodny agent, zwykły ekran → przyjety; kolejność get → read → prompt', async () => {
    const h = falszywyHerdr({ get: getOk, prompt: promptOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamosc, 'Uwagi x')).toEqual({ prompt: 'przyjety', ostrzezenia: [] });
    expect(h.wywolania()).toEqual(['get', 'read', 'prompt']);
  });

  it('zmieniony terminal → agent_zmieniony i prompt NIE jest wysłany', async () => {
    const h = falszywyHerdr({ get: getOk, prompt: promptOk });
    expect(await wyslijPrompt(h.b, projekt, { ...tozsamosc, terminalId: 'term_stary' }, 'Uwagi x')).toEqual({ prompt: 'agent_zmieniony', ostrzezenia: [] });
    expect(h.wywolania()).toEqual(['get']);
  });

  it.each([
    'claude-akceptacja-planu-auto.txt',
    'claude-akceptacja-planu.txt',
    'claude-zaufanie-folderu.txt',
    'codex-zaufanie-folderu.txt',
    'codex-limit-tygodniowy.txt',
  ])('F1: nagrany dialog %s przy statusie `done` → blocked + dialog_wykryty, prompt NIE wysłany', async plik => {
    const h = falszywyHerdr({ get: getZeStatusem('done'), prompt: promptOk, read: [0, ekranZDialogiem(plik), ''] });
    expect(await wyslijPrompt(h.b, projekt, tozsamosc, 'Uwagi x')).toEqual({ prompt: 'blocked', ostrzezenia: ['dialog_wykryty'] });
    bezPromptu(h);
  });

  it('fail-closed: ekran bez zwykłego pola wejścia (nieznany stan) → blocked + ekran_nierozpoznany', async () => {
    const h = falszywyHerdr({ get: getOk, prompt: promptOk, read: [0, 'cokolwiek, czego nie znamy\n  1. Tak\n  2. Nie\n', ''] });
    expect(await wyslijPrompt(h.b, projekt, tozsamosc, 'Uwagi x')).toEqual({ prompt: 'blocked', ostrzezenia: ['ekran_nierozpoznany'] });
    bezPromptu(h);
  });

  it('fail-closed: błąd odczytu ekranu → blocked + odczyt_ekranu_nieudany, prompt NIE wysłany', async () => {
    const h = falszywyHerdr({ get: getOk, prompt: promptOk, read: [1, '', '{"error":{"code":"server_unavailable","message":"x"}}'] });
    expect(await wyslijPrompt(h.b, projekt, tozsamosc, 'Uwagi x')).toEqual({ prompt: 'blocked', ostrzezenia: ['odczyt_ekranu_nieudany'] });
    bezPromptu(h);
  });

  it('fail-closed: status unknown → blocked + stan_nieznany, bez czytania ekranu i bez promptu', async () => {
    const h = falszywyHerdr({ get: getZeStatusem('unknown'), prompt: promptOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamosc, 'Uwagi x')).toEqual({ prompt: 'blocked', ostrzezenia: ['stan_nieznany'] });
    expect(h.wywolania()).toEqual(['get']);
  });

  it('dialog zaufania Codexa także przy blocked zachowuje powód dialog_wykryty', async () => {
    const h = falszywyHerdr({
      get: getZeStatusem('blocked'), prompt: promptOk,
      read: [0, ekranZDialogiem('codex-zaufanie-folderu.txt'), ''],
    });
    expect(await wyslijPrompt(h.b, projekt, tozsamosc, 'Uwagi x')).toEqual({ prompt: 'blocked', ostrzezenia: ['dialog_wykryty'] });
    expect(h.wywolania()).toEqual(['get', 'read']);
  });

  it('status blocked od herdr → blocked bez promptu', async () => {
    const h = falszywyHerdr({ get: getZeStatusem('blocked'), prompt: promptOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamosc, 'Uwagi x')).toEqual({ prompt: 'blocked', ostrzezenia: [] });
    bezPromptu(h);
  });

  it('nagrany agent_blocked z promptu (wyścig po odczycie ekranu) → blocked', async () => {
    const h = falszywyHerdr({
      get: getOk,
      prompt: [1, '', '{"error":{"code":"agent_blocked","message":"agent uwagi-host-test is blocked and requires interactive input"},"id":"cli:agent:prompt"}'],
    });
    expect(await wyslijPrompt(h.b, projekt, tozsamosc, 'Uwagi x')).toEqual({ prompt: 'blocked', ostrzezenia: [] });
  });

  it('nagrany agent_not_found z get → agent_nie_istnieje bez promptu', async () => {
    const h = falszywyHerdr({ get: [1, '', '{"error":{"code":"agent_not_found","message":"agent target w9Z:p99 not found"},"id":"cli:agent:get"}'], prompt: promptOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamosc, 'Uwagi x')).toEqual({ prompt: 'agent_nie_istnieje', ostrzezenia: [] });
    expect(h.wywolania()).toEqual(['get']);
  });

  it('nieznany błąd herdr przy get → herdr_niedostepny', async () => {
    const h = falszywyHerdr({ get: [1, '', '{"error":{"code":"server_unavailable","message":"x"}}'], prompt: promptOk });
    await expect(wyslijPrompt(h.b, projekt, tozsamosc, 'Uwagi x')).rejects.toMatchObject({ kod: 'herdr_niedostepny' });
  });
});

// --- herdr-core (`hc`, T208; nagrania z PRAWDZIWEGO rdzenia 2026-11-05) ---

/**
 * Fałszywy hc: jak falszywyHerdr, ale kluczem odpowiedzi jest podkomenda
 * (argv[2]), a dla `get` można podać mapę adres → odpowiedź (dziennik trzyma
 * pełne argv — testy pilnują braku `--force`). Ścieżki z nagrań ("/repo",
 * "/inne") podmieniamy na prawdziwe katalogi tymczasowe, bo katalogAgenta
 * robi realpath i musi tam fizycznie być.
 */
function falszywyHc(wejscie: { ls?: [number, string, string]; get: [number, string, string] | Record<string, [number, string, string]>; read?: [number, string, string]; send?: [number, string, string] }) {
  const odpowiedzi = { read: [0, EKRAN_ZWYKLY, ''] as [number, string, string], send: [0, '{"started":true}', ''] as [number, string, string], ...wejscie };
  const k = join(baza, `hc-${Math.random().toString(36).slice(2)}`);
  mkdirSync(k);
  const dziennik = join(k, 'wywolania.txt');
  const sciezka = join(k, 'hc');
  writeFileSync(
    sciezka,
    `#!${process.execPath}\nconst fs=require('fs');const o=${JSON.stringify(odpowiedzi)};const k=process.argv[2];` +
      `let r=o[k]; if (k==='get' && !Array.isArray(r)) r=r[process.argv[3]]; if (!r) r=[1,'','{"error":{"kind":"not_found","message":"brak skryptu"}}'];` +
      `fs.appendFileSync(${JSON.stringify(dziennik)}, process.argv.slice(2).join(' ')+'\\n');const [kod,out,err]=r;process.stdout.write(out);process.stderr.write(err);process.exit(kod);\n`,
  );
  chmodSync(sciezka, 0o755);
  return { b: { ...binarkiPrawdziwe(), hc: sciezka }, wywolania: () => (existsSync(dziennik) ? readFileSync(dziennik, 'utf8').trim().split('\n') : []) };
}

describe('parsujListeHc i parsujRekordHc (nagranie prawdziwego rdzenia 2026-11-05)', () => {
  it('czyta kompaktowe wpisy ls z nazwami aplikacji', () => {
    const lista = parsujListeHc(LS_HC);
    expect(lista).toHaveLength(5);
    expect(lista[0]).toEqual({ address: 'tc1', agent: 'claude-code', cwd: '/home', name: null });
    expect(lista.map(w => w.agent)).toEqual(['claude-code', 'claude-code', 'zsh', 'grok-build', 'omp']);
  });

  it('odrzuca odpowiedź bez terminals i wpisy bez adresu/programu', () => {
    expect(() => parsujListeHc({})).toThrow(expect.objectContaining({ kod: 'herdr_niedostepny' }));
    expect(() => parsujListeHc({ terminals: 'nie-tablica' })).toThrow(expect.objectContaining({ kod: 'herdr_niedostepny' }));
    expect(parsujListeHc({ terminals: [{}, { address: 't9', agent: 'claude-code', cwd: '/x' }, null] })).toEqual([{ address: 't9', agent: 'claude-code', cwd: '/x', name: null }]);
  });

  it('czyta rekord agenta ze status.app; rekord bez adresu → null', () => {
    expect(parsujRekordHc(GET_HC['claude-done'])).toMatchObject({ address: 'tc1', state: 'live', status: { state: 'done', app: 'claude-code' } });
    expect(parsujRekordHc(GET_HC['powloka'])).toMatchObject({ status: null, foreground: { cwd: '/repo' } });
    expect(parsujRekordHc({ address: 'tc1' })).toBeNull();
  });
});

describe('agenciHcProjektu (fałszywy hc, nagrania prawdziwe)', () => {
  const lsOk: [number, string, string] = [0, JSON.stringify(LS_HC), ''];
  const claudeDone = (zmiany: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ ...GET_HC['claude-done'], foreground: { cwd: projekt }, ...zmiany });
  const mapaGet = (zmiany: Record<string, unknown> = {}): Record<string, [number, string, string]> => ({
    tc1: [0, JSON.stringify(claudeDone(zmiany)), ''],
    tc2: [0, JSON.stringify({ ...GET_HC['claude-idle'], foreground: { cwd: projekt }, ...zmiany }), ''],
    ts1: [0, JSON.stringify({ ...GET_HC['powloka'], foreground: { cwd: projekt }, ...zmiany }), ''],
  });

  it('zostawia tylko znane aplikacje w projekcie; zsh/grok-build/omp odpadają bez wołania get', async () => {
    const h = falszywyHc({ ls: lsOk, get: mapaGet() });
    const wynik = await agenciHcProjektu(h.b, projekt);
    expect(wynik.map(a => a.paneId).sort()).toEqual(['tc1', 'tc2']);
    expect(wynik[0]).toMatchObject({ zrodlo: 'hc', program: 'claude-code', rodzaj: 'claude', rodzajSurowy: 'claude-code', status: 'done', cwd: projekt, sesjaAgenta: null });
    expect(h.wywolania()).toEqual(['ls --json', 'get tc1 --json', 'get tc2 --json']);
  });

  it('status error i brak zgłoszenia → unknown', async () => {
    const h = falszywyHc({ ls: lsOk, get: mapaGet({ status: { state: 'error', app: 'claude-code' } }) });
    expect((await agenciHcProjektu(h.b, projekt)).every(a => a.status === 'unknown')).toBe(true);
    const h2 = falszywyHc({ ls: lsOk, get: mapaGet({ status: null }) });
    expect((await agenciHcProjektu(h2.b, projekt)).every(a => a.status === 'unknown')).toBe(true);
  });

  it('finished terminal i agent poza projektem odpadają', async () => {
    const h = falszywyHc({ ls: lsOk, get: mapaGet({ state: 'finished', exit_code: 0 }) });
    expect(await agenciHcProjektu(h.b, projekt)).toEqual([]);
    const h2 = falszywyHc({ ls: lsOk, get: mapaGet({ foreground: { cwd: join(baza, 'proj-2') } }) });
    expect(await agenciHcProjektu(h2.b, projekt)).toEqual([]);
  });
});

describe('agenciProjektu: scalanie źródeł (T208)', () => {
  const listaTuiWProjekcie: [number, string, string] = [0, JSON.stringify({ result: { agents: [agent(claude, { cwd: projekt, foreground_cwd: projekt })] } }), ''];

  function falszywyHerdrZListą(klucz: string, odpowiedz: string, kod = 0, stderr = ''): string {
    const k = join(baza, `herdr-${klucz}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(k);
    const sciezka = join(k, 'herdr');
    writeFileSync(
      sciezka,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(kod === 0 ? odpowiedz : '')});process.stderr.write(${JSON.stringify(kod === 0 ? '' : stderr)});process.exit(${kod});\n`,
    );
    chmodSync(sciezka, 0o755);
    return sciezka;
  }

  it('herdr pada → agenci z hc + ostrzezenie herdr_niedostepny', async () => {
    const hcPusty = falszywyHerdrZListą('hc-pusty', '{"terminals":[]}');
    const wynik = await agenciProjektu({ ...binarkiPrawdziwe('/usr/bin/false'), hc: hcPusty }, projekt);
    expect(wynik.ostrzezenia).toEqual(['herdr_niedostepny']);
    expect(wynik.agenci).toEqual([]);
  });

  it('hc brak w konfiguracji → agenci tylko z TUI, bez ostrzeżeń', async () => {
    const herdr = falszywyHerdrZListą('list', listaTuiWProjekcie[1]);
    const wynik = await agenciProjektu({ ...binarkiPrawdziwe(), herdr }, projekt);
    expect(wynik.agenci).toHaveLength(1);
    expect(wynik.agenci[0]).toMatchObject({ zrodlo: 'tui' });
    expect(wynik.ostrzezenia).toEqual([]);
  });

  it('hc ls pada → agenci z TUI + ostrzezenie hc_niedostepny', async () => {
    const herdr = falszywyHerdrZListą('list2', listaTuiWProjekcie[1]);
    const hcPadajacy = falszywyHerdrZListą('hc-pad', '', 1, '{"error":{"kind":"conn_refused","message":"x"}}');
    const wynik = await agenciProjektu({ ...binarkiPrawdziwe(), herdr, hc: hcPadajacy }, projekt);
    expect(wynik.agenci).toHaveLength(1);
    expect(wynik.ostrzezenia).toEqual(['hc_niedostepny']);
  });

  it('bez Herdra i hc → pusta lista bez ostrzeżeń, bo niezainstalowane źródło to nie awaria (T261)', async () => {
    const { herdr: _herdr, ...bezHerdra } = binarkiPrawdziwe();
    await expect(agenciProjektu(bezHerdra, projekt)).resolves.toEqual({ agenci: [], ostrzezenia: [] });
  });

  it('sam hc, bez herdr → lista z hc bez ostrzeżenia o Herdrze (T261)', async () => {
    const hcPusty = falszywyHerdrZListą('hc-sam', '{"terminals":[]}');
    const { herdr: _herdr, ...bezHerdra } = binarkiPrawdziwe();
    await expect(agenciProjektu({ ...bezHerdra, hc: hcPusty }, projekt)).resolves.toEqual({ agenci: [], ostrzezenia: [] });
  });

  it('oba źródła padły → herdr_niedostepny', async () => {
    const b = binarkiPrawdziwe('/usr/bin/false');
    await expect(agenciProjektu(b, projekt)).rejects.toMatchObject({ kod: 'herdr_niedostepny' });
  });
});

describe('wyslijPrompt: ścieżka hc (T208, bez --force)', () => {
  // program = nazwa aplikacji z `hc ls`/`status.app`, nie basename argv[0].
  const tozsamoscHc = { zrodlo: 'hc' as const, program: 'claude-code', paneId: 'tc1', terminalId: 'tc1', sesjaAgenta: null };
  const lsOk: [number, string, string] = [0, JSON.stringify(LS_HC), ''];
  const getZ = (zmiany: Record<string, unknown> = {}): [number, string, string] =>
    [0, JSON.stringify({ ...GET_HC['claude-done'], foreground: { cwd: projekt }, ...zmiany }), ''];
  const sendOk: [number, string, string] = [0, '{"started":true,"status":"idle","turn":0}', ''];
  const bezPromptu = (h: { wywolania: () => string[] }) => expect(h.wywolania().some(a => a.startsWith('send'))).toBe(false);

  it('zwykły ekran → przyjety; kolejność get → read → send, bez --force', async () => {
    const h = falszywyHc({ ls: lsOk, get: getZ(), send: sendOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamoscHc, 'Uwagi: X')).toEqual({ prompt: 'przyjety', ostrzezenia: [] });
    expect(h.wywolania()).toEqual(['get tc1 --json', 'read tc1 --lines 0', 'send tc1 Uwagi: X']);
  });

  it('program bez zgłoszenia statusu → nie da się potwierdzić tożsamości: agent_zmieniony', async () => {
    const h = falszywyHc({ ls: lsOk, get: getZ({ status: null }), send: sendOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamoscHc, 'Uwagi: X')).toEqual({ prompt: 'agent_zmieniony', ostrzezenia: [] });
    expect(h.wywolania()).toEqual(['get tc1 --json']);
  });

  it('inna aplikacja pod tym samym adresem (status.app=omp) → agent_zmieniony, bez send', async () => {
    const h = falszywyHc({ ls: lsOk, get: getZ({ status: { state: 'idle', app: 'omp' } }), send: sendOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamoscHc, 'Uwagi: X')).toEqual({ prompt: 'agent_zmieniony', ostrzezenia: [] });
    bezPromptu(h);
  });

  it('status error → unknown → blocked + stan_nieznany, bez read i send', async () => {
    const h = falszywyHc({ ls: lsOk, get: getZ({ status: { state: 'error', app: 'claude-code' } }), send: sendOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamoscHc, 'Uwagi: X')).toEqual({ prompt: 'blocked', ostrzezenia: ['stan_nieznany'] });
    expect(h.wywolania()).toEqual(['get tc1 --json']);
  });

  it('status blocked → blocked bez send i bez read', async () => {
    const h = falszywyHc({ ls: lsOk, get: getZ({ status: { state: 'blocked', app: 'claude-code' } }), send: sendOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamoscHc, 'Uwagi: X')).toEqual({ prompt: 'blocked', ostrzezenia: [] });
    expect(h.wywolania()).toEqual(['get tc1 --json']);
  });

  it.each(['claude-akceptacja-planu-auto.txt', 'codex-zaufanie-folderu.txt'])('nagrany dialog %s na ekranie → blocked + dialog_wykryty', async plik => {
    const h = falszywyHc({ ls: lsOk, get: getZ(), read: [0, ekranZDialogiem(plik), ''], send: sendOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamoscHc, 'Uwagi: X')).toEqual({ prompt: 'blocked', ostrzezenia: ['dialog_wykryty'] });
    bezPromptu(h);
  });

  it('ekran bez pola wejścia → blocked + ekran_nierozpoznany', async () => {
    const h = falszywyHc({ ls: lsOk, get: getZ(), read: [0, 'cokolwiek, czego nie znamy\n  1. Tak\n  2. Nie\n', ''], send: sendOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamoscHc, 'Uwagi: X')).toEqual({ prompt: 'blocked', ostrzezenia: ['ekran_nierozpoznany'] });
    bezPromptu(h);
  });

  it('odmowa send (status_mismatch, kod 10) → blocked', async () => {
    const h = falszywyHc({ ls: lsOk, get: getZ(), send: [10, '', '{"error":{"kind":"status_mismatch","hint":"nothing was typed","message":"tc1 is silent, not working"}}'] });
    expect(await wyslijPrompt(h.b, projekt, tozsamoscHc, 'Uwagi: X')).toEqual({ prompt: 'blocked', ostrzezenia: [] });
  });

  it('not_found z get (kod 3, error.kind) → agent_nie_istnieje', async () => {
    const h = falszywyHc({ ls: lsOk, get: [3, '', '{"error":{"kind":"not_found","hint":"see `hc ls --all`","message":"no terminal \\"tc1\\""}}'], send: sendOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamoscHc, 'Uwagi: X')).toEqual({ prompt: 'agent_nie_istnieje', ostrzezenia: [] });
    expect(h.wywolania()).toEqual(['get tc1 --json']);
  });

  it('agent przeszedł do innego katalogu → agent_zmieniony', async () => {
    const h = falszywyHc({ ls: lsOk, get: getZ({ foreground: { cwd: join(baza, 'proj-2') } }), send: sendOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamoscHc, 'Uwagi: X')).toEqual({ prompt: 'agent_zmieniony', ostrzezenia: [] });
  });

  it('finished terminal → agent_zmieniony', async () => {
    const h = falszywyHc({ ls: lsOk, get: getZ({ state: 'finished', exit_code: 0 }), send: sendOk });
    expect(await wyslijPrompt(h.b, projekt, tozsamoscHc, 'Uwagi: X')).toEqual({ prompt: 'agent_zmieniony', ostrzezenia: [] });
  });

  it('identyfikator z adresem TUI (w1:p1) nie przechodzi walidacji adresu hc', async () => {
    const h = falszywyHc({ ls: lsOk, get: getZ(), send: sendOk });
    await expect(wyslijPrompt(h.b, projekt, { ...tozsamoscHc, paneId: 'w1:p1', terminalId: 'w1:p1' }, 'Uwagi: X')).rejects.toMatchObject({ kod: 'zadanie_niepoprawne' });
  });

  it('tożsamość bez programu (hc) → agent_zmieniony bez wołania hc', async () => {
    const h = falszywyHc({ ls: lsOk, get: getZ(), send: sendOk });
    expect(await wyslijPrompt(h.b, projekt, { ...tozsamoscHc, program: null }, 'Uwagi: X')).toEqual({ prompt: 'agent_zmieniony', ostrzezenia: [] });
    expect(h.wywolania()).toEqual([]);
  });
});
