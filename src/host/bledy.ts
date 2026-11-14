import type { KodBledu } from '../wspolne/protokol';

/**
 * Jedyny typ błędu, który host świadomie zwraca wtyczce. Każdy inny wyjątek
 * dyspozytor zamienia na `wewnetrzny`, żeby nie wyciekał stack trace ani
 * ścieżki z wnętrza Node.
 */
export class BladHosta extends Error {
  constructor(
    readonly kod: KodBledu,
    wiadomosc: string,
    /** Tylko dla `projekt_nie_toplevel`: korzeń repozytorium do zaproponowania użytkownikowi. */
    readonly korzen?: string,
  ) {
    super(wiadomosc);
    this.name = 'BladHosta';
  }
}

/**
 * Błędy systemu plików zamieniamy na kody kontraktu w jednym miejscu
 * (red-team §14.8: surowe `ENAMETOOLONG` nie może dojść do wtyczki).
 */
export function zBleduSystemu(e: unknown, kontekst: string): BladHosta {
  if (e instanceof BladHosta) return e;
  const kod = (e as NodeJS.ErrnoException | null)?.code;
  switch (kod) {
    case 'ELOOP':
    case 'ENOTDIR':
      return new BladHosta('sciezka_symlink', `${kontekst}: element ścieżki nie jest zwykłym katalogiem`);
    case 'ENAMETOOLONG':
      return new BladHosta('za_duzy', `${kontekst}: ścieżka za długa`);
    case 'ENOSPC':
    case 'EDQUOT':
      return new BladHosta('wewnetrzny', `${kontekst}: brak miejsca na dysku`);
    case 'EACCES':
    case 'EPERM':
      return new BladHosta('wewnetrzny', `${kontekst}: brak uprawnień`);
    default:
      return new BladHosta('wewnetrzny', `${kontekst}: ${kod ?? 'nieznany błąd'}`);
  }
}
