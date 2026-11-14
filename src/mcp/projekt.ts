import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { KATALOG_UWAG, KATALOG_UWAG_STARY } from '../host/zapis';

/** Agent bywa uruchomiony w podkatalogu repo, a paczki leżą przy jego korzeniu. */
export function znajdzProjekt(start: string): string {
  let katalog = resolve(start);
  for (;;) {
    if (existsSync(join(katalog, '.git')) || existsSync(join(katalog, KATALOG_UWAG)) || existsSync(join(katalog, KATALOG_UWAG_STARY))) return katalog;
    const wyzej = dirname(katalog);
    if (wyzej === katalog) return resolve(start);
    katalog = wyzej;
  }
}
