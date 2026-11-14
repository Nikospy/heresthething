import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { KORZEN, odpal, stanowisko, type Stanowisko } from './instalator-pomocnicze';

/** Wspólny szew testów `doctor` (S-33): zainstalowane stanowisko, zaślepki z `mcp get`, wywołanie. */

export const ID_DEV = readFileSync(join(KORZEN, 'src/wspolne/id-wtyczki.txt'), 'utf8').trim();

/** Zaślepka agenta rozszerzona o `mcp get`. Resztę (add/remove) oddaje oryginałowi z `instalator-pomocnicze`. */
const ZASLEPKA_GET = `#!/bin/sh
nazwa="$(basename "$0")"
if [ "$1 $2" = "mcp get" ]; then
  echo "$nazwa $*" >> "$STUB_LOG"
  [ -e "$STUB_STORE/$nazwa.$3" ] || exit 1
  case "$DOCTOR_GET_MODE" in
    smieci) head -c 1048576 /dev/urandom; echo "CANARY-TOKEN-sk-abcdefghijklmnopqrstuvwx" ;;
    binarne) head -c 8192 /dev/urandom ;;
    inna) echo "Args: /gdzies/indziej/mcp.mjs" ;;
    *) echo "Command: node"; echo "Args: $DOCTOR_MCP_PATH"; echo "TOKEN=CANARY-TOKEN-sk-abcdefghijklmnopqrstuvwx" ;;
  esac
  exit 0
fi
exec "$(dirname "$0")/$nazwa.orig" "$@"
`;

export function dodajGet(s: Stanowisko, agent: 'claude' | 'codex'): void {
  const sciezka = join(s.bin, agent);
  if (!existsSync(sciezka)) return;
  renameSync(sciezka, `${sciezka}.orig`);
  writeFileSync(sciezka, ZASLEPKA_GET, { mode: 0o755 });
  chmodSync(sciezka, 0o755);
}

/** Wtyczka widoczna w profilu Chrome (sam katalog `Extensions/<id>`, jak sprawdza instalator). */
export function wtyczkaWProfilu(s: Stanowisko, id = ID_DEV): void {
  mkdirSync(join(s.home, 'Library/Application Support/Google/Chrome/Default/Extensions', id), { recursive: true });
}

export const konfig = (s: Stanowisko, nazwa: string): string => join(s.profil, 'herestt', nazwa);
export const manifestChrome = (s: Stanowisko): string => join(s.profil, 'NativeMessagingHosts/com.herestt.host.json');

export function zainstalowane(baza: string, agenci: Array<'claude' | 'codex'> = ['claude', 'codex']): Stanowisko {
  const s = stanowisko(baza, agenci);
  const w = odpal(['--yes', '--browsers', 'chrome', '--agents', 'claude', '--profil', s.profil], s.env());
  expect(w.kod, w.stdout + w.stderr).toBe(0);
  for (const agent of agenci) dodajGet(s, agent);
  wtyczkaWProfilu(s);
  return s;
}

export function doctor(s: Stanowisko, extra: Record<string, string> = {}): ReturnType<typeof odpal> {
  return odpal(['doctor', '--profil', s.profil], s.env({ DOCTOR_MCP_PATH: konfig(s, 'mcp.mjs'), ...extra }));
}
