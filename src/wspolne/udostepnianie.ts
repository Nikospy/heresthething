import { LIMITY } from './protokol';
import { LIMITY_TEKSTU, jestTypemUwagi, type TypUwagi } from './uwaga';

/**
 * Osobny kanał trwałego portu connectNative; nie zmienia sendNativeMessage.
 * Projekt i upstream ustala SW. LAN przekazuje tylko operacje poniżej.
 * Walidatory zwracają boolean (type guard), nie rzucają dla danych z JSON
 * i odrzucają dodatkowe pola zamiast przepuszczać uprawnienia klienta.
 */
export const WERSJA_UDOSTEPNIANIA = 1;
export const SCIEZKA_ZAREZERWOWANA = '/__tryb-uwag/';
export const PARAMETR_TOKENU = '__tryb_uwag';
/** Host ustawia HttpOnly, SameSite=Strict, Path=/. HTTP w LAN nie zapewnia TLS. */
export const CIASTECZKO = 'tryb_uwag';
/** Czyta wyłącznie host; nie jest polem wiadomości ani ustawieniem popupu. */
export const ZMIENNA_ADRESU_TESTOWEGO = 'TRYB_UWAG_LAN_ADRES';

export const LIMITY_UDOSTEPNIANIA = {
  wiadomoscHostSwBajty: LIMITY.odpowiedzBajty,
  porcjaPngBajty: 256 * 1024,
  pngBajty: LIMITY.zrzutBajty,
  // 2 MiB base64 oraz zapas na tekst i jego escapowanie w JSON.
  cialoZadaniaLanBajty: 3 * 1024 * 1024,
  tekstWlasciciela: LIMITY_TEKSTU.tekstWlasciciela,
  selektor: LIMITY_TEKSTU.selektor,
  url: LIMITY_TEKSTU.url,
  idZnakow: 128,
  sciezkaZnakow: 8192,
  bladZnakow: 2000,
  timeoutOdpowiedziSwMs: 30_000,
} as const;

export const KOMUNIKATY_LAN = {
  brak_wifi: 'Brak prywatnego adresu IPv4 Wi-Fi. Połącz Maca z siecią Wi-Fi.',
  upstream_niepoprawny: 'Udostępnić można tylko stronę HTTP z localhost lub 127.0.0.1.',
  projekt_niepotwierdzony: 'Najpierw potwierdź projekt na Macu.',
  juz_udostepniane: 'Udostępnianie już działa. Zatrzymaj je przed ponownym startem.',
  niedozwolone: 'Ta operacja nie jest dostępna przez Wi-Fi.',
  nieautoryzowany: 'Brak dostępu. Otwórz adres z tokenem skopiowany z popupu na Macu.',
  za_duzy: 'Dane przekraczają dopuszczalny rozmiar.',
  transfer_przerwany: 'Przesyłanie rysunku zostało przerwane. Uwaga nie została zapisana.',
  transfer_niekompletny: 'Nie odebrano całego rysunku. Uwaga nie została zapisana.',
  png_niepoprawny: 'Rysunek nie jest poprawnym obrazem PNG.',
  rysunek_za_duzy: 'Rysunek przekracza 2 MiB także po zmniejszeniu skali.',
  rozlaczono: 'Udostępnianie zostało przerwane. Uruchom je ponownie na Macu.',
  timeout: 'Nie otrzymano na czas odpowiedzi z Maca. Sprawdź połączenie.',
  nie_wlasna: 'Możesz zmieniać i usuwać tylko własne uwagi.',
  blad_zapisu: 'Nie udało się zapisać uwagi na Macu.',
  zadanie_niepoprawne: 'Żądanie ma niepoprawne lub niedozwolone pola.',
} as const;
export type KodBleduLan = keyof typeof KOMUNIKATY_LAN;

export type UwagaLan = {
  id: string;
  tekst: string;
  /** `null`: użytkownik nie wybrał typu (FR-025). */
  typUwagi: TypUwagi | null;
  url: string;
  scrollX: number;
  scrollY: number;
  szerokoscWidoku: number;
  wysokoscWidoku: number;
  dpr: number;
  selektor: string | null;
  idTransferu: string | null;
};
export const OPERACJE_LAN = ['sesja', 'zapisz', 'usun'] as const;
export type OperacjaLan =
  | { typ: 'sesja' }
  | { typ: 'zapisz'; uwaga: UwagaLan }
  | { typ: 'usun'; id: string };
export type WidokSesjiLan = {
  rewizja: number;
  uwagi: Array<{
    id: string;
    numer: number;
    tekst: string;
    typUwagi: TypUwagi | null;
    wlasna: boolean;
    maRysunek: boolean;
  }>;
};
export type UpstreamLan = { host: 'localhost' | '127.0.0.1'; port: number };
export type OdpowiedzLan =
  | { ok: true; widok: WidokSesjiLan }
  | { ok: false; kod: KodBleduLan; blad: string };
/** POST /__tryb-uwag/uwaga. PNG to kreski na białym tle, nie zrzut strony. */
export type CialoUwagi = { uwaga: Omit<UwagaLan, 'idTransferu'>; pngBase64?: string };
/** POST /__tryb-uwag/usun. */
export type CialoUsun = { id: string };
/** GET klient.js: JavaScript; GET sesja: OdpowiedzLan; GET zdarzenia: SSE. */
export type ZdarzenieLan =
  | { typ: 'sesja'; widok: WidokSesjiLan }
  | { typ: 'przerwane'; powod: string };

type Koperta<T> = T & { kanal: 'udostepnianie'; wersja: typeof WERSJA_UDOSTEPNIANIA };
export type WiadomoscSwHost = Koperta<
  | { typ: 'start'; idZadania: string; upstream: UpstreamLan; sciezka: string }
  | { typ: 'stop'; idZadania: string }
  | { typ: 'sesja'; widok: WidokSesjiLan }
  | ({ typ: 'wynik'; idZadania: string } & OdpowiedzLan)
>;
export type WiadomoscHostSw = Koperta<
  | { typ: 'uruchomione'; idZadania: string; url: string; adres: string; port: number }
  | { typ: 'blad'; idZadania: string; kod: KodBleduLan; blad: string }
  | { typ: 'zatrzymane'; powod: string }
  | { typ: 'zadanie'; idZadania: string; operacja: OperacjaLan }
  | { typ: 'pngPorcja'; idTransferu: string; numer: number; liczbaPorcji: number; bajtyRazem: number; daneBase64: string }
  | { typ: 'pngPrzerwany'; idTransferu: string }
>;

/**
 * Porcje numerujemy od 0. Każda poza ostatnią ma porcjaPngBajty bajtów.
 * Host nadaje idTransferu, a SW sprawdza ciągłość, brak duplikatów i sumę.
 * Dopiero komplet oraz zapis PNG pozwalają wykonać zapisz z idTransferu.
 * wynik(ok:true) potwierdza trwały zapis przez Magazyn, nie odbiór porcji.
 * pngPrzerwany, timeout lub zamknięcie portu usuwa transfer i jego obraz,
 * jeśli nie został przypisany do uwagi. Walidator nie przechowuje stanu.
 */
type Rekord = Record<string, unknown>;
function rekord(v: unknown): v is Rekord {
  return typeof v === 'object' && v !== null && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}
function pola(v: Rekord, wymagane: readonly string[], opcjonalne: readonly string[] = []): boolean {
  return wymagane.every(k => Object.hasOwn(v, k)) &&
    Object.keys(v).every(k => wymagane.includes(k) || opcjonalne.includes(k));
}
function tekst(v: unknown, max: number, pusty = false): v is string {
  return typeof v === 'string' && v.length <= max && (pusty || v.trim().length > 0);
}
function id(v: unknown): v is string {
  return tekst(v, LIMITY_UDOSTEPNIANIA.idZnakow) && !/[\s\u0000-\u001f\u007f]/u.test(v);
}
function liczba(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function calkowita(v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}
function kod(v: unknown): v is KodBleduLan {
  return typeof v === 'string' && Object.hasOwn(KOMUNIKATY_LAN, v);
}
const encoder = new TextEncoder();
function rozmiar(v: unknown, limit: number): boolean {
  try {
    const json = JSON.stringify(v);
    return typeof json === 'string' && json.length <= limit && encoder.encode(json).byteLength <= limit;
  } catch {
    return false;
  }
}
function adresHttp(v: unknown, max: number): v is string {
  if (!tekst(v, max)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' && u.username === '' && u.password === '';
  } catch { return false; }
}
function sciezka(v: unknown): v is string {
  return tekst(v, LIMITY_UDOSTEPNIANIA.sciezkaZnakow) && v.startsWith('/') &&
    !v.startsWith('//') && !/[\\#\s\u0000-\u001f\u007f]/u.test(v);
}
/** Kanoniczne base64 bez prefiksu data:, białych znaków i niezerowych bitów dopełnienia. */
function bajtyBase64(v: unknown, max: number): number | null {
  if (typeof v !== 'string' || v.length === 0 || v.length % 4 !== 0 || v.length > Math.ceil(max / 3) * 4) return null;
  const padding = v.endsWith('==') ? 2 : v.endsWith('=') ? 1 : 0;
  const koniec = v.length - padding;
  const alfabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < koniec; i++) if (!alfabet.includes(v.charAt(i))) return null;
  const ostatni = alfabet.indexOf(v.charAt(koniec - 1));
  if ((padding === 2 && (ostatni & 15) !== 0) || (padding === 1 && (ostatni & 3) !== 0)) return null;
  const bajty = v.length / 4 * 3 - padding;
  return bajty <= max ? bajty : null;
}
const typUwagiPoprawny = (v: unknown): boolean => v === null || jestTypemUwagi(v);
const POLA_UWAGI = ['id', 'tekst', 'typUwagi', 'url', 'scrollX', 'scrollY', 'szerokoscWidoku', 'wysokoscWidoku', 'dpr', 'selektor'] as const;
function uwaga(v: unknown, transfer: boolean): boolean {
  return rekord(v) && pola(v, transfer ? [...POLA_UWAGI, 'idTransferu'] : POLA_UWAGI) &&
    id(v.id) && tekst(v.tekst, LIMITY_TEKSTU.tekstWlasciciela) && typUwagiPoprawny(v.typUwagi) &&
    adresHttp(v.url, LIMITY_TEKSTU.url) && liczba(v.scrollX) && liczba(v.scrollY) &&
    liczba(v.szerokoscWidoku) && v.szerokoscWidoku > 0 &&
    liczba(v.wysokoscWidoku) && v.wysokoscWidoku > 0 && liczba(v.dpr) && v.dpr > 0 &&
    (v.selektor === null || tekst(v.selektor, LIMITY_TEKSTU.selektor)) &&
    (!transfer || v.idTransferu === null || id(v.idTransferu));
}
export function walidujOperacjeLan(v: unknown): v is OperacjaLan {
  if (!rekord(v)) return false;
  switch (v.typ) {
    case 'sesja': return pola(v, ['typ']);
    case 'usun': return pola(v, ['typ', 'id']) && id(v.id);
    case 'zapisz': return pola(v, ['typ', 'uwaga']) && uwaga(v.uwaga, true);
    default: return false;
  }
}
export function walidujCialoUwagi(v: unknown): v is CialoUwagi {
  return rekord(v) && pola(v, ['uwaga'], ['pngBase64']) && uwaga(v.uwaga, false) &&
    (!Object.hasOwn(v, 'pngBase64') || bajtyBase64(v.pngBase64, LIMITY_UDOSTEPNIANIA.pngBajty) !== null) &&
    rozmiar(v, LIMITY_UDOSTEPNIANIA.cialoZadaniaLanBajty);
}
/** Sprawdzenie base64 nie zastępuje dekodowania i sprawdzenia PNG przez odbiorcę. */
function widok(v: unknown): v is WidokSesjiLan {
  if (!rekord(v) || !pola(v, ['rewizja', 'uwagi']) || !calkowita(v.rewizja, 0) || !Array.isArray(v.uwagi)) return false;
  const idy = new Set<string>();
  const numery = new Set<number>();
  for (const u of v.uwagi) {
    if (!rekord(u) || !pola(u, ['id', 'numer', 'tekst', 'typUwagi', 'wlasna', 'maRysunek']) ||
      !id(u.id) || !calkowita(u.numer, 1) || !tekst(u.tekst, LIMITY_TEKSTU.tekstWlasciciela) ||
      !typUwagiPoprawny(u.typUwagi) || typeof u.wlasna !== 'boolean' || typeof u.maRysunek !== 'boolean' ||
      idy.has(u.id) || numery.has(u.numer)) return false;
    idy.add(u.id);
    numery.add(u.numer);
  }
  return true;
}
function koperta(v: unknown): v is Rekord {
  return rekord(v) && v.kanal === 'udostepnianie' && v.wersja === WERSJA_UDOSTEPNIANIA;
}
function polaPortu(v: Rekord, wymagane: readonly string[]): boolean {
  return pola(v, ['kanal', 'wersja', 'typ', ...wymagane]);
}
export function walidujWiadomoscSwHost(v: unknown): v is WiadomoscSwHost {
  if (!koperta(v)) return false;
  switch (v.typ) {
    case 'start': return polaPortu(v, ['idZadania', 'upstream', 'sciezka']) && id(v.idZadania) &&
      rekord(v.upstream) && pola(v.upstream, ['host', 'port']) &&
      (v.upstream.host === 'localhost' || v.upstream.host === '127.0.0.1') &&
      calkowita(v.upstream.port, 1, 65535) && sciezka(v.sciezka);
    case 'stop': return polaPortu(v, ['idZadania']) && id(v.idZadania);
    case 'sesja': return polaPortu(v, ['widok']) && widok(v.widok);
    case 'wynik': return id(v.idZadania) && (v.ok === true
      ? polaPortu(v, ['idZadania', 'ok', 'widok']) && widok(v.widok)
      : v.ok === false && polaPortu(v, ['idZadania', 'ok', 'kod', 'blad']) &&
        kod(v.kod) && tekst(v.blad, LIMITY_UDOSTEPNIANIA.bladZnakow));
    default: return false;
  }
}
function uruchomione(v: Rekord): boolean {
  if (!polaPortu(v, ['idZadania', 'url', 'adres', 'port']) || !id(v.idZadania) ||
    !tekst(v.adres, 15) || !calkowita(v.port, 1, 65535) ||
    !adresHttp(v.url, LIMITY_UDOSTEPNIANIA.sciezkaZnakow + 1024)) return false;
  const oktety = v.adres.split('.');
  if (oktety.length !== 4 || !oktety.every(o => /^(0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255)) return false;
  const u = new URL(v.url);
  return u.hostname === v.adres && Number(u.port || 80) === v.port && u.hash === '' &&
    u.searchParams.getAll(PARAMETR_TOKENU).length === 1 && !!u.searchParams.get(PARAMETR_TOKENU);
}
function porcja(v: Rekord): boolean {
  if (!polaPortu(v, ['idTransferu', 'numer', 'liczbaPorcji', 'bajtyRazem', 'daneBase64']) ||
    !id(v.idTransferu) || !calkowita(v.bajtyRazem, 1, LIMITY_UDOSTEPNIANIA.pngBajty) ||
    !calkowita(v.liczbaPorcji, 1) || !calkowita(v.numer, 0, v.liczbaPorcji - 1)) return false;
  const limit = LIMITY_UDOSTEPNIANIA.porcjaPngBajty;
  if (v.liczbaPorcji !== Math.ceil(v.bajtyRazem / limit)) return false;
  const oczekiwane = Math.min(limit, v.bajtyRazem - v.numer * limit);
  return bajtyBase64(v.daneBase64, limit) === oczekiwane;
}
export function walidujWiadomoscHostSw(v: unknown): v is WiadomoscHostSw {
  if (!koperta(v) || !rozmiar(v, LIMITY_UDOSTEPNIANIA.wiadomoscHostSwBajty)) return false;
  switch (v.typ) {
    case 'uruchomione': return uruchomione(v);
    case 'blad': return polaPortu(v, ['idZadania', 'kod', 'blad']) && id(v.idZadania) &&
      kod(v.kod) && tekst(v.blad, LIMITY_UDOSTEPNIANIA.bladZnakow);
    case 'zatrzymane': return polaPortu(v, ['powod']) && tekst(v.powod, LIMITY_UDOSTEPNIANIA.bladZnakow);
    case 'zadanie': return polaPortu(v, ['idZadania', 'operacja']) && id(v.idZadania) && walidujOperacjeLan(v.operacja);
    case 'pngPorcja': return porcja(v);
    case 'pngPrzerwany': return polaPortu(v, ['idTransferu']) && id(v.idTransferu);
    default: return false;
  }
}
