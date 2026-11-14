/**
 * Dialogi, w które prompt NIE może trafić (F1, host.md „Raport po krokach 1–9”).
 *
 * Dlaczego sami czytamy ekran: herdr 0.9.3 klasyfikuje część dialogów jako
 * `done`/`idle`, nie `blocked`, więc jego `agent_blocked` ich nie zatrzyma.
 * Enter z `herdr agent prompt` wybiera wtedy domyślną opcję — na żywo
 * zatwierdził plan Claude i włączył auto mode (2026-10-09 11:49:58Z).
 *
 * Każdy wzorzec ma źródło: nagrany ekran w `tests/host/fixtures/ekrany/`.
 * Dopasowanie idzie po tekście ze złączonymi białymi znakami, bo terminal
 * zawija linie w dowolnym miejscu („Would you⏎ like to proceed?”).
 */

export type WzorDialogu = { nazwa: string; wzor: RegExp; zrodlo: string };

export const DIALOGI: readonly WzorDialogu[] = [
  {
    nazwa: 'claude_akceptacja_planu',
    wzor: /Would you like to proceed\?/,
    zrodlo: 'claude-akceptacja-planu-auto.txt — Claude Code 2.1.295, 2026-10-09 11:49Z; herdr: done; Enter = „Yes, and use auto mode”',
  },
  {
    nazwa: 'claude_wyjscie_z_planu',
    wzor: /Exit plan mode\?/,
    zrodlo: 'claude-akceptacja-planu.txt — Claude Code 2.1.295 z --disallowedTools Write, 2026-10-09 12:02Z; herdr: done',
  },
  {
    nazwa: 'claude_zaufanie_folderu',
    wzor: /Quick safety check: Is this a project you created/,
    zrodlo: 'claude-zaufanie-folderu.txt — Claude Code 2.1.295, 2026-10-09 12:02Z; herdr: blocked',
  },
  {
    nazwa: 'codex_zaufanie_folderu',
    wzor: /Trust this folder\? Codex/,
    zrodlo: 'codex-zaufanie-folderu.txt — Codex 0.162.0, 2026-10-09 12:03Z; herdr: idle (!)',
  },
  {
    nazwa: 'codex_limit',
    wzor: /Approaching rate limits/,
    zrodlo: 'codex-limit-tygodniowy.txt — Codex 0.162.0, 2026-10-09 10:50Z; herdr: done',
  },
];

/** Nazwa wykrytego dialogu albo null. */
export function wykryjDialog(ekran: string): string | null {
  const tekst = ekran.replace(/\s+/g, ' ');
  return DIALOGI.find(d => d.wzor.test(tekst))?.nazwa ?? null;
}

/**
 * Biała lista (recenzja Codexa nr 1): czarna lista nie złapie dialogu, którego
 * jeszcze nie nagraliśmy. Prompt wychodzi tylko, gdy dół ekranu wygląda jak
 * zwykłe pole wejścia danego agenta — tak jak na nagraniach `*-bez-dialogu*`
 * i `*-pracuje*`. Wszystko inne to „nie wiem”, czyli nie wysyłamy.
 */

/** Nazwana sesja wpisuje tytuł w górną ramkę: `──── Dostęp do ostatnich zmian ─` (claude-ramka-z-tytulem.txt). */
const LINIA_RAMKI_CLAUDE = /^─{20,}(?: .+ ─+)?\s*$/;

/**
 * Claude Code: pole wejścia to linia `❯ …` (od pierwszej kolumny) między dwiema
 * liniami `─` (górna może mieć tytuł sesji), i jest to ostatnia taka para na ekranie. Dialogi
 * (plan, wyjście z planu, zaufanie, pytania) nie mają zamykającej ramki pod `❯`
 * albo ich `❯` jest wcięte (opcje „ ❯ 1. Yes”).
 */
function zwyklePoleClaude(linie: string[]): boolean {
  const ramki = linie.flatMap((l, i) => (LINIA_RAMKI_CLAUDE.test(l) ? [i] : []));
  if (ramki.length < 2) return false;
  const gorna = ramki[ramki.length - 2]!;
  const dolna = ramki[ramki.length - 1]!;
  // Pod dolną ramką jest już tylko pasek stanu (git, tryb, effort).
  return dolna - gorna >= 2 && dolna - gorna <= 12 && linie[gorna + 1]!.startsWith('❯') && linie.length - dolna <= 6;
}

/**
 * Codex: ostatnie pole `› …`, bez numerowanych opcji, oraz stopka skrótów,
 * modelu/katalogu lub ostrzeżeń. Wąski pane pomija skróty (fixture 0.162.0).
 */
function zwyklePoleCodex(linie: string[]): boolean {
  const indeks = linie.findLastIndex(l => /^\s*› /.test(l));
  if (indeks < 0 || !/^› /.test(linie[indeks]!) || /^› \d+[.)](?:\s|$)/.test(linie[indeks]!)) return false;
  return linie.slice(indeks + 1).some(l =>
    /← for agents|\? for shortcuts/.test(l) ||
    /^\s+GPT-[\w.-]+(?:\s+[\w-]+)*\s+·\s+~\//.test(l) ||
    /^\s+.*⚠\s+\d+\s+warnings\b/.test(l)
  );
}

export type OcenaEkranu = { gotowy: true } | { gotowy: false; powod: 'dialog_wykryty' | 'ekran_nierozpoznany' };

export function ocenEkran(rodzaj: string, ekran: string): OcenaEkranu {
  if (wykryjDialog(ekran) !== null) return { gotowy: false, powod: 'dialog_wykryty' };
  // Puste końcowe linie nie są częścią interfejsu.
  const linie = ekran.replace(/\s+$/, '').split('\n');
  const zwykle = rodzaj === 'claude' ? zwyklePoleClaude(linie) : rodzaj === 'codex' ? zwyklePoleCodex(linie) : false;
  return zwykle ? { gotowy: true } : { gotowy: false, powod: 'ekran_nierozpoznany' };
}
