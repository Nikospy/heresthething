import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

/**
 * Którzy agenci są zarejestrowani według dziennika instalacji (S-32).
 *
 * Ping niesie tylko tę jedną informację z `instalacja.json`: dwie możliwe nazwy,
 * bez ścieżek i bez reszty dziennika. Czytnik jest łagodny celowo: ping to też test
 * dymny instalacji, więc żadne wyjście dziennika (brak, symlink, śmieci) nie może go
 * przewrócić. Ścisły parser dziennika żyje w instalatorze i tu go nie importujemy.
 */

export const PLIK_INSTALACJI = 'instalacja.json';
const LIMIT_BAJTY = 256 * 1024;
const ZNANI_AGENCI = ['claude', 'codex'] as const;

/**
 * `null` = nie wiadomo (brak dziennika albo dziennik nieczytelny). `[]` = dziennik jest,
 * a agentów nie zapisano albo instalację cofnięto.
 */
export async function zarejestrowaniAgenci(katalog: string): Promise<string[] | null> {
  try {
    const plik = join(katalog, PLIK_INSTALACJI);
    const st = await fsp.lstat(plik);
    if (!st.isFile() || st.size > LIMIT_BAJTY) return null;
    const dane: unknown = JSON.parse(await fsp.readFile(plik, 'utf8'));
    if (typeof dane !== 'object' || dane === null || Array.isArray(dane)) return null;
    const d = dane as Record<string, unknown>;
    if (d.stan === 'cofniecie') return [];
    if (!Array.isArray(d.kroki)) return null;
    const cele = new Set<string>();
    for (const krok of d.kroki as unknown[]) {
      if (typeof krok !== 'object' || krok === null) continue;
      const k = krok as Record<string, unknown>;
      if (k.rodzaj === 'mcp' && k.ok === true && typeof k.cel === 'string') cele.add(k.cel);
    }
    return ZNANI_AGENCI.filter(a => cele.has(a));
  } catch {
    return null;
  }
}
