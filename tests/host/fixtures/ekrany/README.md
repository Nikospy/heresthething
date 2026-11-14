# Nagrane ekrany agentów (F1)

Prawdziwe wyjścia `herdr agent read <pane> --source detection --lines 15` (herdr 0.9.3), agenci testowi w scratchpadzie, 2026-10-09 (UTC).

| Plik | Agent | Kiedy | Status herdr w tej chwili | Uwagi |
|---|---|---|---|---|
| `claude-zaufanie-folderu.txt` | Claude Code 2.1.295 | 12:02:19Z | `blocked` | dialog zaufania; dół z opcjami poza 15 liniami |
| `claude-bez-dialogu.txt` | Claude Code 2.1.295 (plan, `--disallowedTools Edit,Write,NotebookEdit`) | 12:02:45Z | `idle` | zwykły prompt — musi przejść |
| `claude-akceptacja-planu.txt` | j.w. | 12:02:54Z | `done` | „Exit plan mode?” (Write zablokowany, więc bez pliku planu) |
| `claude-akceptacja-planu-auto.txt` | Claude Code 2.1.295 (plan) | 11:49:42Z | `done` | „Would you like to proceed? ❯ 1. Yes, and use auto mode” — **ten dialog zatwierdził prompt** (F1). Źródło `--source recent-unwrapped`, ostatnie 15 niepustych linii |
| `codex-zaufanie-folderu.txt` | Codex 0.162.0 (`--sandbox read-only`) | 12:03:28Z | `idle` (!) | `agent start` zwrócił `idle`, choć dialog był na ekranie |
| `codex-bez-dialogu.txt` | j.w. | 12:03:35Z | `idle` | zwykły prompt — musi przejść |
| `codex-limit-tygodniowy.txt` | Codex 0.162.0 | 10:50:48Z | `done` | „Approaching rate limits”; źródło `--source recent-unwrapped` |

`codex-bez-dialogu-waski.txt`: fragment zwykłego, bezczynnego ekranu przekazany przez koordynatora po odtworzeniu nieudanego `final-mewitz` (2026-10-09, Codex 0.162.0 / GPT-6.1-Sol, wąski pane, mewitz). Zachowane podane linie, w tym wielokropki; brak stopki „for agents / for shortcuts”. To zapis obserwacji koordynatora, nie nowy odczyt wykonany przez astra.

`claude-ramka-z-tytulem.txt`: Claude Code 2.1.296, herdr 0.9.3, mewitz, 2026-10-10 ~17:50Z, status `working`. Sesja ma nazwę, więc górna ramka pola wejścia to `──── Dostęp do ostatnich zmian ─`, nie same `─` — przez to host zgłaszał `ekran_nierozpoznany` przy zwykłym polu. Nad ramką: zrzut strony z wtyczki, „2 new messages”, „Update installed”.
