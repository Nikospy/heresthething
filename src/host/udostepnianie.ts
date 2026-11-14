import { randomUUID } from 'node:crypto';
import { KOMUNIKATY_LAN, WERSJA_UDOSTEPNIANIA, LIMITY_UDOSTEPNIANIA as L, walidujWiadomoscSwHost, type WiadomoscHostSw, type OperacjaLan, type OdpowiedzLan } from '../wspolne/udostepnianie';
import { podzielPng } from './lan-narzedzia';
import { BladLan, bladLan, uruchomSerwerLan, type SerwerLan } from './lan-serwer';

/**
 * Jeden port Chrome jest właścicielem jednego nasłuchu. Nie ma magazynu
 * sesji po stronie hosta: dopiero wynik SW potwierdza zapis, także PNG.
 * Timeout, anulowanie HTTP i stop przerywają oczekiwanie i sprzątają transfer.
 * EOF/sygnał wywołuje zatrzymaj(..., true), stop pozwala na ponowny start.
 * klient pochodzi z bundla; adresTestowy wyłącznie z punktu wejścia/testów,
 * nigdy z wiadomości SW lub z LAN. Tokenów ani treści uwag nie logujemy.
 */
export class KanalUdostepniania {
  private serwer: SerwerLan | null = null;
  private zamkniety = false;
  private oczekujace = new Map<string, (wynik: OdpowiedzLan) => void>();
  constructor(private readonly wyslij: (wiadomosc: WiadomoscHostSw) => void,
    private readonly klient: () => string,
    private readonly dziennik: (typ: string, ok: boolean) => void,
    private readonly adresTestowy?: string) {}

  async przyjmij(dane: unknown): Promise<void> {
    if (!walidujWiadomoscSwHost(dane)) {
      const id = typeof dane === 'object' && dane !== null && 'idZadania' in dane && typeof dane.idZadania === 'string' && /^[^\s\u0000-\u001f\u007f]{1,128}$/u.test(dane.idZadania) ? dane.idZadania : '?';
      this.wyslij({ kanal: 'udostepnianie', wersja: WERSJA_UDOSTEPNIANIA, typ: 'blad', idZadania: id, kod: 'zadanie_niepoprawne', blad: KOMUNIKATY_LAN.zadanie_niepoprawne }); return;
    }
    switch (dane.typ) {
      case 'start': {
        try {
          if (this.zamkniety) throw new BladLan('rozlaczono');
          if (this.serwer) throw new BladLan('juz_udostepniane');
          // Host z publicznego pakietu npm nie ma klienta tabletu (jest częścią wtyczki, S-37): odmowa zamiast pustej strony.
          if (this.klient() === '') throw new BladLan('niedozwolone');
          this.serwer = await uruchomSerwerLan({ upstream: dane.upstream, sciezka: dane.sciezka, klient: this.klient(),
            ...(this.adresTestowy ? { adresTestowy: this.adresTestowy } : {}),
            wykonaj: (operacja, png, sygnal) => this.wykonaj(operacja, png, sygnal) });
          this.wyslij({ kanal: 'udostepnianie', wersja: WERSJA_UDOSTEPNIANIA, typ: 'uruchomione', idZadania: dane.idZadania,
            url: this.serwer.url, adres: this.serwer.adres, port: this.serwer.port });
          this.dziennik('lan_start', true);
        } catch (e) {
          const kod = e instanceof BladLan ? e.kod : 'rozlaczono';
          this.wyslij({ kanal: 'udostepnianie', wersja: WERSJA_UDOSTEPNIANIA, typ: 'blad', idZadania: dane.idZadania, kod, blad: KOMUNIKATY_LAN[kod] });
          this.dziennik('lan_start', false);
        }
        break;
      }
      case 'stop':
        await this.zatrzymaj(KOMUNIKATY_LAN.rozlaczono);
        this.wyslij({ kanal: 'udostepnianie', wersja: WERSJA_UDOSTEPNIANIA, typ: 'zatrzymane', powod: KOMUNIKATY_LAN.rozlaczono }); break;
      case 'sesja': this.serwer?.sesja(dane.widok); break;
      case 'wynik': this.oczekujace.get(dane.idZadania)?.(dane.ok ? { ok: true, widok: dane.widok } : { ok: false, kod: dane.kod, blad: dane.blad }); break;
    }
  }

  private async wykonaj(operacja: OperacjaLan, png?: Buffer, sygnal?: AbortSignal): Promise<OdpowiedzLan> {
    if (!this.serwer || this.zamkniety || sygnal?.aborted) return bladLan('rozlaczono');
    const idZadania = randomUUID();
    const idTransferu = png ? randomUUID() : null;
    return new Promise<OdpowiedzLan>(resolve => {
      const zakoncz = (wynik: OdpowiedzLan): void => {
        if (!this.oczekujace.delete(idZadania)) return;
        clearTimeout(timer); sygnal?.removeEventListener('abort', anuluj);
        if (!wynik.ok && idTransferu) {
          try { this.wyslij({ kanal: 'udostepnianie', wersja: WERSJA_UDOSTEPNIANIA, typ: 'pngPrzerwany', idTransferu }); } catch { /* Port już zamknięty; SW sprząta transfery po disconnect. */ }
        }
        this.dziennik('lan_zadanie', wynik.ok);
        resolve(wynik);
      };
      const anuluj = (): void => zakoncz(bladLan('rozlaczono'));
      const timer = setTimeout(() => zakoncz(bladLan('timeout')), L.timeoutOdpowiedziSwMs);
      this.oczekujace.set(idZadania, zakoncz);
      sygnal?.addEventListener('abort', anuluj, { once: true });
      try {
        if (png && idTransferu) for (const porcja of podzielPng(png, idTransferu)) this.wyslij(porcja);
        const docelowa = operacja.typ === 'zapisz' ? { ...operacja, uwaga: { ...operacja.uwaga, idTransferu } } : operacja;
        this.wyslij({ kanal: 'udostepnianie', wersja: WERSJA_UDOSTEPNIANIA, typ: 'zadanie', idZadania, operacja: docelowa });
      } catch { zakoncz(bladLan('transfer_przerwany')); }
    });
  }

  async zatrzymaj(powod: string, koniec = false): Promise<void> {
    if (koniec) this.zamkniety = true;
    const serwer = this.serwer;
    this.serwer = null;
    for (const zakoncz of this.oczekujace.values()) zakoncz(bladLan('rozlaczono'));
    await serwer?.zamknij(powod);
    if (serwer) this.dziennik('lan_stop', true);
  }
}
