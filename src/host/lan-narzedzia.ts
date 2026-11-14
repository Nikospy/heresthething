import { timingSafeEqual } from 'node:crypto';
import { isIPv4 } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { CIASTECZKO, LIMITY_UDOSTEPNIANIA as L, SCIEZKA_ZAREZERWOWANA, WERSJA_UDOSTEPNIANIA, type WiadomoscHostSw } from '../wspolne/udostepnianie';

export function prywatnyIPv4(adres: string): boolean {
  if (!isIPv4(adres)) return false;
  const [a, b] = adres.split('.').map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

export function wybierzAdresWifi(interfejsy: NodeJS.Dict<NetworkInterfaceInfo[]>): string | null {
  // macOS nie ujawnia medium w networkInterfaces. en0 to Wi-Fi współczesnych
  // Maców, en1 starszych; nie zgadujemy po bridge/utun/Ethernet en2+.
  // Na Macu z Ethernet en0 heurystyka wymaga ręcznej weryfikacji interfejsu.
  for (const nazwa of ['en0', 'en1']) {
    for (const wpis of interfejsy[nazwa] ?? []) {
      if (!wpis.internal && wpis.family === 'IPv4' && prywatnyIPv4(wpis.address)) return wpis.address;
    }
  }
  return null;
}

export function poprawnyToken(wartosc: string | null | undefined, token: string): boolean {
  if (!wartosc || wartosc.length !== token.length) return false;
  const a = Buffer.from(wartosc), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function poprawneCiasteczko(naglowek: string | undefined, token: string): boolean {
  return (naglowek ?? '').split(';').some(pole => {
    const [nazwa, ...reszta] = pole.trim().split('=');
    return nazwa === CIASTECZKO && poprawnyToken(reszta.join('='), token);
  });
}

export function wstrzyknijHtml(dane: Buffer, kodowanie?: string): Buffer {
  const opcje = { maxOutputLength: 32 * 1024 * 1024 };
  const html = (kodowanie === 'gzip' ? gunzipSync(dane, opcje) : kodowanie === 'deflate' ? inflateSync(dane, opcje) : kodowanie === 'br' ? brotliDecompressSync(dane, opcje) : dane).toString('utf8');
  if (kodowanie && !['identity', 'gzip', 'deflate', 'br'].includes(kodowanie)) throw new Error('Nieobsługiwane kodowanie HTML');
  const skrypt = `<script src="${SCIEZKA_ZAREZERWOWANA}klient.js"></script>`;
  return Buffer.from(/<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, `${skrypt}</head>`) : skrypt + html);
}

export function* podzielPng(dane: Buffer, idTransferu: string): Generator<Extract<WiadomoscHostSw, { typ: 'pngPorcja' }>> {
  if (dane.length === 0 || dane.length > L.pngBajty) throw new Error('Niepoprawny rozmiar PNG');
  const liczbaPorcji = Math.ceil(dane.length / L.porcjaPngBajty);
  for (let numer = 0; numer < liczbaPorcji; numer++) {
    yield { kanal: 'udostepnianie', wersja: WERSJA_UDOSTEPNIANIA, typ: 'pngPorcja', idTransferu, numer, liczbaPorcji, bajtyRazem: dane.length,
      daneBase64: dane.subarray(numer * L.porcjaPngBajty, (numer + 1) * L.porcjaPngBajty).toString('base64') };
  }
}
