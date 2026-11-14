import { czytajObecnosc, czytajStatus } from './status';
import { WERSJA_PROTOKOLU, ZAKRES_PROTOKOLU, wiadomoscDlaAgenta, wspolnaWersja, zakresWiadomosci, type Odpowiedz, type TozsamoscAgenta, type WynikPromptu, type ZakresProtokolu } from '../wspolne/protokol';
import { agenciProjektu, wyslijPrompt } from './agenci';
import { BladHosta } from './bledy';
import { zarejestrowaniAgenci } from './instalacja-agenci';
import type { Konfiguracja } from './konfiguracja';
import { mapuj, projektDlaOriginu, projektDlaStatusu, rozpoznaj, wybierzFolder } from './projekt';
import { sciezkaIstniejacejPaczki, zapiszPaczke, zweryfikujIdPaczki, zweryfikujPaczke } from './zapis';

export const WERSJA_HOSTA = '0.1.0';
/** Hash źródeł wstrzykiwany przez `scripts/build.mjs` — ping pozwala wtyczce porównać go ze swoim. */
declare const HASH_BUILDY: string;

export type Kontekst = { katalog: string; konfiguracja: Konfiguracja };

/** Odpowiedź bez koperty — kopertę i `zakres` pingu dokłada `obsluzZadanie`. */
type Tresc = Odpowiedz extends infer O ? (O extends unknown ? Omit<O, 'wersja' | 'idZadania' | 'zakres'> : never) : never;

const WZOR_ID_ZADANIA = /^[A-Za-z0-9_-]{1,64}$/;

function tozsamosc(surowa: unknown): TozsamoscAgenta {
  const t = surowa as Record<string, unknown> | null;
  if (
    typeof t !== 'object' ||
    t === null ||
    typeof t.paneId !== 'string' ||
    typeof t.terminalId !== 'string' ||
    !(typeof t.sesjaAgenta === 'string' || t.sesjaAgenta === null)
  ) {
    throw new BladHosta('zadanie_niepoprawne', 'agent: wymagane paneId, terminalId, sesjaAgenta');
  }
  // Tożsamości zapisane przed S-03 nie mają `zrodlo` — to agenci starego TUI.
  const zrodlo = t.zrodlo === 'hc' ? 'hc' : 'tui';
  const program = typeof t.program === 'string' && t.program.length > 0 ? t.program : null;
  return { zrodlo, paneId: t.paneId, terminalId: t.terminalId, sesjaAgenta: t.sesjaAgenta, program };
}

async function wykonaj(k: Kontekst, z: Record<string, unknown>): Promise<Tresc> {
  const b = k.konfiguracja.binarki;
  switch (z.typ) {
    case 'ping': {
      const agenci = await zarejestrowaniAgenci(k.katalog);
      return { ok: true, typ: 'ping', wersjaHosta: WERSJA_HOSTA, hash: HASH_BUILDY, hc: b.hc !== undefined, ...(agenci !== null ? { agenci } : {}) };
    }

    case 'resolve':
      return { ok: true, typ: 'resolve', ...(await rozpoznaj(b, k.katalog, z.origin)) };

    case 'mapuj':
      return { ok: true, typ: 'mapuj', projekt: await mapuj(b, k.katalog, z.origin, z.projekt) };

    case 'agents': {
      const projekt = await projektDlaOriginu(b, k.katalog, z.origin);
      const zrodla = await agenciProjektu(b, projekt);
      return { ok: true, typ: 'agents', projekt, agenci: zrodla.agenci, ostrzezenia: zrodla.ostrzezenia };
    }

    case 'deliver': {
      // Najpierw wszystko, co da się sprawdzić bez dysku i herdr.
      const paczka = zweryfikujPaczke(z);
      // Bez pola `agent` tylko zapisujemy: agent odbierze paczkę sam (S-27). Podane pole musi być poprawną tożsamością.
      const agent = z.agent === undefined ? null : tozsamosc(z.agent);
      const projekt = await projektDlaOriginu(b, k.katalog, z.origin);
      const zapis = await zapiszPaczke(b, projekt, paczka);
      const ostrzezenia = [...zapis.ostrzezenia];
      let prompt: WynikPromptu = 'pominiety';
      if (zapis.paczka === 'zapisana' && agent !== null) {
        // Paczka już leży na dysku — błąd herdr nie może zamienić całości w porażkę (W12).
        try {
          const wysylka = await wyslijPrompt(b, projekt, agent, wiadomoscDlaAgenta(zapis.sciezkaMdAbsolutna));
          prompt = wysylka.prompt;
          ostrzezenia.push(...wysylka.ostrzezenia);
        } catch (e) {
          prompt = 'blad';
          ostrzezenia.push(e instanceof BladHosta ? e.kod : 'wewnetrzny');
        }
      }
      return { ok: true, typ: 'deliver', sciezkaMd: zapis.sciezkaMdWzgledna, paczka: zapis.paczka, prompt, ostrzezenia };
    }

    case 'status': {
      const idPaczki = zweryfikujIdPaczki(z.idPaczki);
      const projekt = await projektDlaStatusu(b, k.katalog, z.origin);
      return { ok: true, typ: 'status', ...(await czytajStatus(projekt, idPaczki)) };
    }

    case 'obecnosc': {
      const projekt = await projektDlaStatusu(b, k.katalog, z.origin);
      return { ok: true, typ: 'obecnosc', czeka: await czytajObecnosc(projekt) };
    }

    case 'prompt': {
      const idPaczki = zweryfikujIdPaczki(z.idPaczki);
      const agent = tozsamosc(z.agent);
      const projekt = await projektDlaOriginu(b, k.katalog, z.origin);
      const paczka = await sciezkaIstniejacejPaczki(projekt, idPaczki);
      const wysylka = await wyslijPrompt(b, projekt, agent, wiadomoscDlaAgenta(paczka.sciezkaMdAbsolutna));
      return { ok: true, typ: 'prompt', prompt: wysylka.prompt, ostrzezenia: wysylka.ostrzezenia };
    }

    case 'wybierz_folder':
      return { ok: true, typ: 'wybierz_folder', folder: await wybierzFolder(b, z.prompt) };

    default:
      throw new BladHosta('zadanie_niepoprawne', 'nieznany typ zadania');
  }
}

/** Zawsze zwraca odpowiedź (nigdy nie rzuca) — host ma odpisać nawet na śmieci. `zakresHosta` domyślnie jest stałą kompilacji; test wstrzykuje szerszy. */
export async function obsluzZadanie(k: Kontekst, surowe: unknown, zakresHosta: ZakresProtokolu = ZAKRES_PROTOKOLU): Promise<Odpowiedz> {
  const z = (typeof surowe === 'object' && surowe !== null ? surowe : {}) as Record<string, unknown>;
  const idZadania = typeof z.idZadania === 'string' && WZOR_ID_ZADANIA.test(z.idZadania) ? z.idZadania : '';
  // Błąd wersji niesie sufit hosta. Inny błąd niesie wersję zadania, bo wtyczka porównuje ją z kopertą, którą wysłała.
  let wersjaBledu = zakresHosta.do;
  try {
    const nadawca = zakresWiadomosci(z.zakres, z.wersja);
    const wybrana = nadawca === null ? null : wspolnaWersja(nadawca, zakresHosta);
    if (wybrana === null || nadawca === null) throw new BladHosta('wersja_nieobslugiwana', `host obsługuje protokół ${zakresHosta.do}`);
    const dol = Math.max(nadawca.od, zakresHosta.od);
    const wersjaZadania = typeof z.wersja === 'number' && Number.isInteger(z.wersja) ? z.wersja : null;
    const wPrzecieciu = wersjaZadania !== null && wersjaZadania >= dol && wersjaZadania <= wybrana;
    // Ping wolno wysłać dowolną kopertą, byle zakresy się przecinały: wraca maksimum.
    // Reszta przyjmuje każdą całkowitą z przecięcia. Po restarcie SW klient traci wybraną i wysyła dolny koniec.
    if (z.typ !== 'ping' && !wPrzecieciu) throw new BladHosta('wersja_nieobslugiwana', `host obsługuje protokół ${zakresHosta.do}`);
    wersjaBledu = wersjaZadania ?? wybrana;
    if (idZadania === '') throw new BladHosta('zadanie_niepoprawne', 'brak albo niepoprawne idZadania');
    const tresc = await wykonaj(k, z);
    const koperta = { wersja: z.typ === 'ping' ? wybrana : wersjaZadania!, idZadania } as const;
    if (z.typ === 'ping' && tresc.ok === true && tresc.typ === 'ping') {
      return { ...tresc, zakres: { od: zakresHosta.od, do: zakresHosta.do }, ...koperta } as Odpowiedz;
    }
    return { ...tresc, ...koperta } as Odpowiedz;
  } catch (e) {
    const wersja = e instanceof BladHosta && e.kod === 'wersja_nieobslugiwana' ? zakresHosta.do : wersjaBledu;
    // `as Odpowiedz`: w produkcji `wersja` jest 2. Test wstrzykuje szerszy zakres, więc typ koperty zostaje przy stałej kompilacji.
    if (e instanceof BladHosta) return { ok: false, kod: e.kod, blad: e.message, ...(e.korzen !== undefined ? { korzen: e.korzen } : {}), wersja, idZadania } as Odpowiedz;
    return { ok: false, kod: 'wewnetrzny', blad: 'nieoczekiwany błąd hosta', wersja, idZadania } as Odpowiedz;
  }
}

/** Odpowiedź z błędem, gdy kontekstu nie da się nawet zbudować (np. brak config.json). */
export function odpowiedzBledu(surowe: unknown, blad: BladHosta): Odpowiedz {
  const z = (typeof surowe === 'object' && surowe !== null ? surowe : {}) as Record<string, unknown>;
  const idZadania = typeof z.idZadania === 'string' && WZOR_ID_ZADANIA.test(z.idZadania) ? z.idZadania : '';
  return { ok: false, kod: blad.kod, blad: blad.message, wersja: WERSJA_PROTOKOLU, idZadania };
}
