import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

/**
 * `host.log` obok hosta (H6). Chrome połyka stderr hosta, więc bez tego
 * debugowanie u właściciela byłoby zgadywaniem.
 *
 * Wpis ma tylko metadane: typ, idZadania, wynik, czas. Nigdy treści uwag,
 * base64, tekstu promptu ani odpowiedzi herdr — log nie może stać się kopią
 * tego, co właściciel oglądał.
 */

export const PLIK_DZIENNIKA = 'host.log';
const LIMIT_BAJTY = 1024 * 1024;

export type WpisDziennika = {
  typ: string;
  idZadania: string;
  ok: boolean;
  kod?: string;
  paczka?: string;
  prompt?: string;
  projekt?: string;
  ms: number;
};

export async function zapiszWpis(katalog: string, wpis: WpisDziennika): Promise<void> {
  const plik = join(katalog, PLIK_DZIENNIKA);
  try {
    try {
      if ((await fsp.stat(plik)).size > LIMIT_BAJTY) await fsp.rename(plik, `${plik}.1`);
    } catch {
      // brak pliku = nic do rotowania
    }
    await fsp.appendFile(plik, `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...wpis })}\n`, { mode: 0o600 });
  } catch {
    // Dziennik jest pomocą, nie warunkiem: błąd zapisu nie psuje zadania.
  }
}
