import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITY, WERSJA_PROTOKOLU, type Odpowiedz } from '../wspolne/protokol';
import { BladHosta } from './bledy';
import { zapiszWpis } from './dziennik';
import { obsluzZadanie, odpowiedzBledu, type Kontekst } from './dyspozytor';
import { wczytajKonfiguracje } from './konfiguracja';
import { czytajRamki, zakodujRamke } from './ramki';
import { ZMIENNA_ADRESU_TESTOWEGO } from '../wspolne/udostepnianie';
import { KanalUdostepniania } from './udostepnianie';

declare const KLIENT_IPADA: string;

/**
 * Punkt wejścia native messaging hosta. Chrome uruchamia launcher z
 * `install.sh`, który robi `exec <node> <katalog>/host.mjs <origin>`.
 *
 * Konfiguracja, mapowania i dziennik leżą w katalogu, w którym leży ten plik
 * (H2): globalnie `~/.config/herestt/`, w E2E `<profil>/herestt/`.
 */

const katalog = dirname(fileURLToPath(import.meta.url));

function wyslij(odpowiedz: Odpowiedz): void {
  let ramka: Buffer;
  try {
    ramka = zakodujRamke(odpowiedz, LIMITY.odpowiedzBajty);
  } catch {
    ramka = zakodujRamke(
      { ok: false, kod: 'za_duzy', blad: 'odpowiedź przekroczyła limit', wersja: WERSJA_PROTOKOLU, idZadania: odpowiedz.idZadania },
      LIMITY.odpowiedzBajty,
    );
  }
  process.stdout.write(ramka);
}

async function przygotujKontekst(): Promise<Kontekst> {
  const konfiguracja = await wczytajKonfiguracje(katalog);
  // Chrome podaje origin wywołującego jako pierwszy argument. allowed_origins
  // już to filtruje; sprawdzamy drugi raz na wypadek ręcznie zmienionego manifestu.
  const nadawca = process.argv[2];
  if (nadawca !== `chrome-extension://${konfiguracja.idWtyczki}/`) {
    throw new BladHosta('konfiguracja', 'nieznany nadawca — host przyjmuje tylko wtyczkę Tryb uwag');
  }
  return { katalog, konfiguracja };
}

async function main(): Promise<void> {
  let kontekst: Kontekst | BladHosta;
  try {
    kontekst = await przygotujKontekst();
  } catch (e) {
    kontekst = e instanceof BladHosta ? e : new BladHosta('konfiguracja', 'nie da się wczytać konfiguracji');
  }

  const kanal = new KanalUdostepniania(
    wiadomosc => { process.stdout.write(zakodujRamke(wiadomosc, LIMITY.odpowiedzBajty)); },
    () => KLIENT_IPADA,
    (typ, ok) => { void zapiszWpis(katalog, { typ, ok, idZadania: '', ms: 0 }); },
    process.env[ZMIENNA_ADRESU_TESTOWEGO],
  );
  const zakoncz = (): void => {
    void kanal.zatrzymaj('Udostępnianie zostało przerwane.', true).finally(() => process.exit(0));
  };
  process.once('SIGTERM', zakoncz);
  process.once('SIGINT', zakoncz);
  try {
    for await (const zadanie of czytajRamki(process.stdin, LIMITY.wiadomoscBajty)) {
      if (typeof zadanie === 'object' && zadanie !== null && 'kanal' in zadanie && zadanie.kanal === 'udostepnianie') {
        if (kontekst instanceof BladHosta) wyslij(odpowiedzBledu(zadanie, kontekst));
        else await kanal.przyjmij(zadanie);
        continue;
      }
      const start = performance.now();
      const odpowiedz = kontekst instanceof BladHosta ? odpowiedzBledu(zadanie, kontekst) : await obsluzZadanie(kontekst, zadanie);
      wyslij(odpowiedz);
      const typ = typeof (zadanie as { typ?: unknown } | null)?.typ === 'string' ? String((zadanie as { typ: string }).typ).slice(0, 20) : '?';
      // Udany ping to sondowanie ze strony „Połącz z agentem” co kilka sekund: bez wartości, a wypychałby z logu resztę.
      if (typ !== 'ping' || !odpowiedz.ok) await zapiszWpis(katalog, {
        typ,
        idZadania: odpowiedz.idZadania,
        ok: odpowiedz.ok,
        ...(odpowiedz.ok ? {} : { kod: odpowiedz.kod }),
        ...('paczka' in odpowiedz ? { paczka: odpowiedz.paczka } : {}),
        ...('prompt' in odpowiedz ? { prompt: odpowiedz.prompt } : {}),
        ...('projekt' in odpowiedz && typeof odpowiedz.projekt === 'string' ? { projekt: odpowiedz.projekt } : {}),
        ms: Math.round(performance.now() - start),
      });
    }
  } catch (e) {
    // Zła ramka (za duża, nie-JSON): odpisujemy błędem i kończymy — dalszy strumień jest nieczytelny.
    const blad = e instanceof BladHosta ? e : new BladHosta('wewnetrzny', 'błąd odczytu wejścia');
    wyslij(odpowiedzBledu(null, blad));
    await zapiszWpis(katalog, { typ: '?', idZadania: '', ok: false, kod: blad.kod, ms: 0 });
  } finally {
    await kanal.zatrzymaj('Udostępnianie zostało przerwane.', true);
    process.off('SIGTERM', zakoncz);
    process.off('SIGINT', zakoncz);
  }
}

await main();
