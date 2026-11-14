import { promises as fsp } from 'node:fs';
import type { Agent, RodzajAgenta, StatusAgenta, TozsamoscAgenta, WynikPromptu } from '../wspolne/protokol';
import { BladHosta } from './bledy';
import type { Binarki } from './konfiguracja';
import { wewnatrz } from './projekt';
import { ocenEkran } from './dialogi';
import { hcAgent, hcEkran, hcLista, hcWyslij, herdrAgent, herdrEkran, herdrListaAgentow, herdrPrompt, LINII_EKRANU } from './uruchom';

/**
 * Agenci z `herdr agent list`. Pola sprawdzone na żywo (host.md §1.5):
 * Codex nie ma `agent_session`, a agenci odpaleni ręcznie nie mają
 * `interactive_ready` — prompt i tak do nich dochodzi, więc nie filtrujemy po nim.
 */

type SurowyAgent = {
  pane_id: string;
  terminal_id: string;
  agent: string;
  agent_status: string;
  cwd: string;
  foreground_cwd: string | null;
  name: string | null;
  terminal_title: string;
  agent_session: string | null;
};

const STATUSY: ReadonlySet<string> = new Set<StatusAgenta>(['idle', 'working', 'blocked', 'done', 'unknown']);

function jakoSurowy(a: unknown): SurowyAgent | null {
  if (typeof a !== 'object' || a === null) return null;
  const r = a as Record<string, unknown>;
  if (typeof r.pane_id !== 'string' || typeof r.terminal_id !== 'string' || typeof r.agent !== 'string' || typeof r.cwd !== 'string') return null;
  const sesja = (r.agent_session as { value?: unknown } | null | undefined)?.value;
  return {
    pane_id: r.pane_id,
    terminal_id: r.terminal_id,
    agent: r.agent,
    agent_status: typeof r.agent_status === 'string' ? r.agent_status : 'unknown',
    cwd: r.cwd,
    foreground_cwd: typeof r.foreground_cwd === 'string' ? r.foreground_cwd : null,
    name: typeof r.name === 'string' ? r.name : null,
    terminal_title: typeof r.terminal_title_stripped === 'string' ? r.terminal_title_stripped : typeof r.terminal_title === 'string' ? r.terminal_title : '',
    agent_session: typeof sesja === 'string' ? sesja : null,
  };
}

export function parsujListe(json: unknown): SurowyAgent[] {
  const agenci = (json as { result?: { agents?: unknown } } | null)?.result?.agents;
  if (!Array.isArray(agenci)) throw new BladHosta('herdr_niedostepny', 'herdr agent list: nieoczekiwany kształt odpowiedzi');
  return agenci.map(jakoSurowy).filter((a): a is SurowyAgent => a !== null);
}

export function parsujAgenta(json: unknown): SurowyAgent | null {
  return jakoSurowy((json as { result?: { agent?: unknown } } | null)?.result?.agent);
}

/** Katalog, w którym agent naprawdę pracuje: proces na pierwszym planie, a gdy go brak — cwd pane (H5). */
async function katalogAgenta(a: SurowyAgent): Promise<string | null> {
  try {
    return await fsp.realpath(a.foreground_cwd ?? a.cwd);
  } catch {
    return null;
  }
}

function rodzaj(surowy: string): RodzajAgenta {
  return surowy === 'claude' || surowy === 'codex' ? surowy : 'inny';
}

function doKontraktu(a: SurowyAgent, katalog: string): Agent {
  return {
    zrodlo: 'tui',
    paneId: a.pane_id,
    terminalId: a.terminal_id,
    sesjaAgenta: a.agent_session,
    program: null,
    nazwa: a.name,
    rodzaj: rodzaj(a.agent),
    rodzajSurowy: a.agent,
    status: (STATUSY.has(a.agent_status) ? a.agent_status : 'unknown') as StatusAgenta,
    tytul: a.terminal_title,
    cwd: katalog,
  };
}

/** Filtr czysty (bez herdr) — testowany na nagranej liście. */
export async function agenciWProjekcie(surowi: SurowyAgent[], projekt: string): Promise<Agent[]> {
  const wynik: Agent[] = [];
  for (const a of surowi) {
    const katalog = await katalogAgenta(a);
    if (katalog !== null && wewnatrz(projekt, katalog)) wynik.push(doKontraktu(a, katalog));
  }
  return wynik;
}

// --- herdr-core (`hc`, agenci w aplikacji Herdr) ---

/**
 * Nazwy aplikacji z `hc ls --json` / `status.app` — to nazwa aplikacji (np.
 * `claude-code`), NIE basename argv[0] (ten to zwykle `zsh`, a foreground.name
 * to numer wersji). Nagrania z prawdziwego rdzenia 2026-11-05; `codex` z listy
 * aplikacji w binarce hc — żywego terminala Codex nie było do potwierdzenia.
 * Nieznana nazwa = nie agent (powłoki, grok-build, omp, hc itd.).
 */
const APLIKACJE_HC: Record<string, RodzajAgenta> = { 'claude-code': 'claude', codex: 'codex' };

/** Kompaktowy wpis `hc ls --json`: `agent` to nazwa aplikacji, `cwd` katalog startowy. */
type WpisHc = { address: string; agent: string; cwd: string; name: string | null };

/** Pełny rekord `hc get --json`, przycięty do pól używanych przez parser. */
type RekordHc = {
  address: string;
  state: string;
  cwd: string;
  foreground: { cwd: string } | null;
  status: { state: string; app: string | null } | null;
  name: string | null;
};

/** hc zwraca `idle|working|done|blocked|error`; `error` i brak zgłoszenia = „nie wiemy”. */
const STANY_HC: Record<string, true> = { idle: true, working: true, blocked: true, done: true };

function jakoWpisHc(a: unknown): WpisHc | null {
  if (a === null || typeof a !== 'object') return null;
  if (!('address' in a) || !('agent' in a) || !('cwd' in a)) return null;
  const { address, agent, cwd } = a;
  if (typeof address !== 'string' || typeof agent !== 'string' || typeof cwd !== 'string') return null;
  const name = 'name' in a && typeof a.name === 'string' ? a.name : null;
  return { address, agent, cwd, name };
}

export function parsujListeHc(json: unknown): WpisHc[] {
  if (json === null || typeof json !== 'object' || !('terminals' in json)) {
    throw new BladHosta('herdr_niedostepny', 'hc ls: nieoczekiwany kształt odpowiedzi');
  }
  const terminals: unknown = json.terminals;
  if (!Array.isArray(terminals)) throw new BladHosta('herdr_niedostepny', 'hc ls: nieoczekiwany kształt odpowiedzi');
  return terminals.map(jakoWpisHc).filter((w): w is WpisHc => w !== null);
}

export function parsujRekordHc(json: unknown): RekordHc | null {
  if (
    json === null || typeof json !== 'object' ||
    !('address' in json) || typeof json.address !== 'string' ||
    !('state' in json) || typeof json.state !== 'string' ||
    !('cwd' in json) || typeof json.cwd !== 'string'
  ) {
    return null;
  }
  const foreground =
    'foreground' in json && json.foreground !== null && typeof json.foreground === 'object' && 'cwd' in json.foreground && typeof json.foreground.cwd === 'string'
      ? { cwd: json.foreground.cwd }
      : null;
  const status =
    'status' in json && json.status !== null && typeof json.status === 'object' && 'state' in json.status && typeof json.status.state === 'string'
      ? { state: json.status.state, app: 'app' in json.status && typeof json.status.app === 'string' ? json.status.app : null }
      : null;
  const name = 'name' in json && typeof json.name === 'string' ? json.name : null;
  return { address: json.address, state: json.state, cwd: json.cwd, foreground, status, name };
}

function statusHc(status: RekordHc['status']): StatusAgenta {
  return status !== null && STANY_HC[status.state] === true ? (status.state as StatusAgenta) : 'unknown';
}

/** Katalog, w którym agent naprawdę pracuje: bieżący proces, a gdy go brak — katalog startowy. */
async function katalogHc(r: RekordHc): Promise<string | null> {
  try {
    return await fsp.realpath(r.foreground?.cwd ?? r.cwd);
  } catch {
    return null;
  }
}

/** Agenci hc widoczni dla projektu; tylko znane aplikacje agentów — powłoki i inne programy odpadają. */
export async function agenciHcProjektu(b: Binarki, projekt: string): Promise<Agent[]> {
  const w = await hcLista(b);
  if (!w.ok) throw new BladHosta('herdr_niedostepny', `hc ls: ${w.blad.kod}`);
  const wynik: Agent[] = [];
  for (const wpis of parsujListeHc(w.json)) {
    const rodzajHc = APLIKACJE_HC[wpis.agent];
    if (rodzajHc === undefined) continue;
    const get = await hcAgent(b, wpis.address);
    if (!get.ok) continue; // terminal zniknął między ls a get
    const rekord = parsujRekordHc(get.json);
    if (rekord === null || rekord.state !== 'live') continue;
    const katalog = await katalogHc(rekord);
    if (katalog === null || !wewnatrz(projekt, katalog)) continue;
    wynik.push({
      zrodlo: 'hc',
      paneId: rekord.address,
      terminalId: rekord.address,
      sesjaAgenta: null,
      program: wpis.agent,
      nazwa: rekord.name,
      rodzaj: rodzajHc,
      rodzajSurowy: wpis.agent,
      status: statusHc(rekord.status),
      tytul: '',
      cwd: katalog,
    });
  }
  return wynik;
}

/**
 * Porównanie tożsamości hc przed wysyłką: żywy terminal, ten sam program wg
 * `status.app` (brak zgłoszenia = nie da się potwierdzić → niezgodne),
 * katalog pracy w projekcie.
 */
async function zgodnaTozsamoscHc(oczekiwana: TozsamoscAgenta, aktualny: RekordHc, projekt: string): Promise<boolean> {
  if (aktualny.address !== oczekiwana.paneId || aktualny.state !== 'live') return false;
  if (oczekiwana.program === null || aktualny.status === null || aktualny.status.app !== oczekiwana.program) return false;
  const katalog = await katalogHc(aktualny);
  return katalog !== null && wewnatrz(projekt, katalog);
}

/**
 * Okno detekcji jak w herdr (`--source detection --lines 15`): dialogi wyżej na
 * ekranie zostały już obsłużone i nie mogą blokować świeżej wysyłki.
 */
function ostatnieLinie(ekran: string): string[] {
  return ekran.replace(/\s+$/, '').split('\n').slice(-LINII_EKRANU);
}

/** Ta sama ścieżka fail-closed co w TUI, tylko komendami hc (T208). */
async function wyslijPromptHc(b: Binarki, projekt: string, oczekiwana: TozsamoscAgenta, tekst: string): Promise<WynikWysylki> {
  if (oczekiwana.program === null) return { prompt: 'agent_zmieniony', ostrzezenia: [] };
  const get = await hcAgent(b, oczekiwana.paneId);
  if (!get.ok) {
    if (get.blad.kod === 'not_found') return { prompt: 'agent_nie_istnieje', ostrzezenia: [] };
    throw new BladHosta('herdr_niedostepny', `hc get: ${get.blad.kod}`);
  }
  const aktualny = parsujRekordHc(get.json);
  if (aktualny === null || !(await zgodnaTozsamoscHc(oczekiwana, aktualny, projekt))) return { prompt: 'agent_zmieniony', ostrzezenia: [] };

  // hc sam wpisuje w programy bez statusu (sprawdzone na izolowanym rdzeniu), więc „nie wiemy” = nie wysyłamy.
  const stan = statusHc(aktualny.status);
  if (stan === 'unknown') return { prompt: 'blocked', ostrzezenia: ['stan_nieznany'] };
  if (stan === 'blocked') return { prompt: 'blocked', ostrzezenia: [] };

  const ekran = await hcEkran(b, oczekiwana.paneId);
  if (!ekran.ok) return { prompt: 'blocked', ostrzezenia: ['odczyt_ekranu_nieudany'] };
  // Ta sama reguła dialogów co w TUI (dialogi.ts): czarna lista + biała lista pola wejścia.
  const ocena = ocenEkran(APLIKACJE_HC[oczekiwana.program] ?? 'inny', ostatnieLinie(ekran.tekst).join('\n'));
  if (!ocena.gotowy) return { prompt: 'blocked', ostrzezenia: [ocena.powod] };

  const w = await hcWyslij(b, oczekiwana.paneId, tekst);
  if (w.ok) return { prompt: 'przyjety', ostrzezenia: [] };
  // Bez `--force`: odmowa zapisu (blocked, status_mismatch) = program nie przyjmuje tekstu.
  if (w.blad.kod === 'not_found') return { prompt: 'agent_nie_istnieje', ostrzezenia: [] };
  return { prompt: 'blocked', ostrzezenia: [] };
}

export async function agenciProjektu(b: Binarki, projekt: string): Promise<ZrodlaAgentow> {
  // Awaria jednego źródła nie zamyka drugiego (T208); dopiero gdy nic nie odpowiedziało, to błąd.
  // Niezainstalowane źródło to nie awaria: bez Herdra lista jest po prostu pusta (T261).
  const ostrzezenia: string[] = [];
  const czesci: Agent[][] = [];
  if (b.herdr !== undefined) {
    try {
      const w = await herdrListaAgentow(b);
      if (!w.ok) throw new BladHosta('herdr_niedostepny', `herdr agent list: ${w.blad.kod}`);
      czesci.push(await agenciWProjekcie(parsujListe(w.json), projekt));
    } catch {
      ostrzezenia.push('herdr_niedostepny');
    }
  }
  if (b.hc !== undefined) {
    try {
      czesci.push(await agenciHcProjektu(b, projekt));
    } catch {
      ostrzezenia.push('hc_niedostepny');
    }
  }
  if (czesci.length === 0 && ostrzezenia.length > 0) throw new BladHosta('herdr_niedostepny', 'żadne ze źródeł agentów nie odpowiada (herdr, hc)');
  return { agenci: czesci.flat(), ostrzezenia };
}

/** Porównanie tożsamości (H5): pane + terminal + sesja (null↔null też), a katalog pracy w projekcie. */
export async function zgodnaTozsamosc(oczekiwana: TozsamoscAgenta, aktualny: SurowyAgent, projekt: string): Promise<boolean> {
  if (aktualny.pane_id !== oczekiwana.paneId || aktualny.terminal_id !== oczekiwana.terminalId) return false;
  if (aktualny.agent_session !== oczekiwana.sesjaAgenta) return false;
  const katalog = await katalogAgenta(aktualny);
  return katalog !== null && wewnatrz(projekt, katalog);
}

export type WynikWysylki = { prompt: WynikPromptu; ostrzezenia: string[] };

export type ZrodlaAgentow = {
  agenci: Agent[];
  /** Źródła, których nie udało się odpytać w tym wywołaniu: `herdr_niedostepny`, `hc_niedostepny`. */
  ostrzezenia: string[];
};

/**
 * Ścieżka zależna od źródła (T208): stare TUI przez `herdr agent prompt`,
 * agenci w aplikacji Herdr przez `hc send`. Obie fail-closed.
 */
export async function wyslijPrompt(b: Binarki, projekt: string, oczekiwana: TozsamoscAgenta, tekst: string): Promise<WynikWysylki> {
  return oczekiwana.zrodlo === 'hc' ? wyslijPromptHc(b, projekt, oczekiwana, tekst) : wyslijPromptTui(b, projekt, oczekiwana, tekst);
}

/**
 * Rewalidacja tuż przed promptem, potem jeden `execFile`. herdr nie ma
 * „prompt, jeśli tożsamość się zgadza”, więc okno TOCTOU = te kroki.
 *
 * Fail-closed (F1): herdr bywa ślepy na dialogi (akceptacja planu Claude,
 * zaufanie folderu i limit Codexa widział jako `done`/`idle`), a Enter
 * z promptu wybiera w nich domyślną opcję. Dlatego wysyłamy tylko wtedy, gdy
 * status jest znany, ekran dało się przeczytać, nie ma na nim znanego dialogu
 * i wygląda jak zwykłe pole wejścia Claude/Codexa. Inny rodzaj agenta = nie
 * wiemy, jak wygląda jego pole, więc nie wysyłamy.
 * `agent_blocked` z samego herdr zostaje jako druga linia obrony.
 */
async function wyslijPromptTui(b: Binarki, projekt: string, oczekiwana: TozsamoscAgenta, tekst: string): Promise<WynikWysylki> {
  const get = await herdrAgent(b, oczekiwana.paneId);
  if (!get.ok) {
    if (get.blad.kod === 'agent_not_found') return { prompt: 'agent_nie_istnieje', ostrzezenia: [] };
    throw new BladHosta('herdr_niedostepny', `herdr agent get: ${get.blad.kod}`);
  }
  const aktualny = parsujAgenta(get.json);
  if (aktualny === null) return { prompt: 'agent_nie_istnieje', ostrzezenia: [] };
  if (!(await zgodnaTozsamosc(oczekiwana, aktualny, projekt))) return { prompt: 'agent_zmieniony', ostrzezenia: [] };

  if (!STATUSY.has(aktualny.agent_status) || aktualny.agent_status === 'unknown') return { prompt: 'blocked', ostrzezenia: ['stan_nieznany'] };

  const ekran = await herdrEkran(b, oczekiwana.paneId);
  if (!ekran.ok) return { prompt: 'blocked', ostrzezenia: ['odczyt_ekranu_nieudany'] };
  // Czarna lista znanych dialogów + biała lista zwykłego pola wejścia (recenzja Codexa nr 1).
  const ocena = ocenEkran(aktualny.agent, ekran.tekst);
  if (!ocena.gotowy) return { prompt: 'blocked', ostrzezenia: [ocena.powod] };
  // Odczyt dodaje powód blokady; zwykły ekran nigdy nie unieważnia blocked z herdr.
  if (aktualny.agent_status === 'blocked') return { prompt: 'blocked', ostrzezenia: [] };

  const w = await herdrPrompt(b, oczekiwana.paneId, tekst);
  if (w.ok) return { prompt: 'przyjety', ostrzezenia: [] };
  switch (w.blad.kod) {
    case 'agent_blocked':
      return { prompt: 'blocked', ostrzezenia: [] };
    case 'agent_not_found':
      return { prompt: 'agent_nie_istnieje', ostrzezenia: [] };
    default:
      return { prompt: 'blad', ostrzezenia: [] };
  }
}
