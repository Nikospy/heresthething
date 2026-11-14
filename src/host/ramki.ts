import { BladHosta } from './bledy';

/**
 * Ramkowanie native messaging: 4 bajty długości (kolejność natywna — na
 * arm64/x64 little-endian) + JSON w UTF-8.
 *
 * Długość sprawdzamy przed alokacją bufora: wtyczka może zadeklarować do 4 GB,
 * a my nie chcemy, żeby jeden zły nagłówek zjadł pamięć. Treść składamy
 * w jednym buforze o znanym rozmiarze — doklejanie `Buffer.concat` przy każdym
 * kawałku kopiowałoby całą ramkę wielokrotnie (recenzja Codexa nr 8).
 */

const NAGLOWEK = 4;

export async function* czytajRamki(wejscie: AsyncIterable<Buffer | string>, limitBajtow: number): AsyncGenerator<unknown> {
  const naglowek = Buffer.alloc(NAGLOWEK);
  let naglowekBajtow = 0;
  let tresc: Buffer | null = null;
  let trescBajtow = 0;

  for await (const surowy of wejscie) {
    const kawalek = typeof surowy === 'string' ? Buffer.from(surowy) : surowy;
    let i = 0;
    while (i < kawalek.length) {
      if (tresc === null) {
        const ile = Math.min(NAGLOWEK - naglowekBajtow, kawalek.length - i);
        kawalek.copy(naglowek, naglowekBajtow, i, i + ile);
        naglowekBajtow += ile;
        i += ile;
        if (naglowekBajtow < NAGLOWEK) break;
        const dlugosc = naglowek.readUInt32LE(0);
        if (dlugosc > limitBajtow) throw new BladHosta('za_duzy', `ramka ${dlugosc} B > limit ${limitBajtow} B`);
        tresc = Buffer.allocUnsafe(dlugosc);
        trescBajtow = 0;
      }
      const ile = Math.min(tresc.length - trescBajtow, kawalek.length - i);
      kawalek.copy(tresc, trescBajtow, i, i + ile);
      trescBajtow += ile;
      i += ile;
      if (trescBajtow === tresc.length) {
        let wartosc: unknown;
        try {
          wartosc = JSON.parse(tresc.toString('utf8'));
        } catch {
          throw new BladHosta('zadanie_niepoprawne', 'ramka nie jest poprawnym JSON');
        }
        tresc = null;
        naglowekBajtow = 0;
        yield wartosc;
      }
    }
  }
  if (naglowekBajtow > 0 || tresc !== null) {
    throw new BladHosta('zadanie_niepoprawne', 'niepełna ramka na końcu wejścia');
  }
}

/** Chrome odrzuca odpowiedź > 1 MB i zrywa połączenie bez treści — wolimy wiedzieć wcześniej. */
export function zakodujRamke(wartosc: unknown, limitBajtow: number): Buffer {
  const tresc = Buffer.from(JSON.stringify(wartosc), 'utf8');
  if (tresc.length > limitBajtow) {
    throw new BladHosta('za_duzy', `odpowiedź ${tresc.length} B > limit ${limitBajtow} B`);
  }
  const naglowek = Buffer.alloc(NAGLOWEK);
  naglowek.writeUInt32LE(tresc.length, 0);
  return Buffer.concat([naglowek, tresc]);
}
