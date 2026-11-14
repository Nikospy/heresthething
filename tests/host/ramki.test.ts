import { describe, expect, it } from 'vitest';
import { czytajRamki, zakodujRamke } from '../../src/host/ramki';

async function zbierz(kawalki: Buffer[], limit = 1024): Promise<unknown[]> {
  const wynik: unknown[] = [];
  async function* zrodlo() {
    yield* kawalki;
  }
  for await (const r of czytajRamki(zrodlo(), limit)) wynik.push(r);
  return wynik;
}

const ramka = (obj: unknown) => zakodujRamke(obj, 1 << 20);

describe('czytajRamki', () => {
  it('składa ramkę podaną po jednym bajcie', async () => {
    const r = ramka({ typ: 'ping', tekst: 'zażółć' });
    const bajty = [...r].map(b => Buffer.from([b]));
    expect(await zbierz(bajty)).toEqual([{ typ: 'ping', tekst: 'zażółć' }]);
  });

  it('rozdziela dwie ramki w jednym kawałku', async () => {
    expect(await zbierz([Buffer.concat([ramka({ a: 1 }), ramka({ b: 2 })])])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('odrzuca zadeklarowaną długość ponad limit, zanim przyjdzie treść', async () => {
    const naglowek = Buffer.alloc(4);
    naglowek.writeUInt32LE(4_000_000_000, 0);
    await expect(zbierz([naglowek], 1024)).rejects.toMatchObject({ kod: 'za_duzy' });
  });

  it('odrzuca ramkę, która nie jest JSON', async () => {
    const tresc = Buffer.from('{nie json');
    const naglowek = Buffer.alloc(4);
    naglowek.writeUInt32LE(tresc.length, 0);
    await expect(zbierz([naglowek, tresc])).rejects.toMatchObject({ kod: 'zadanie_niepoprawne' });
  });

  it('zgłasza urwaną ramkę na końcu wejścia', async () => {
    const r = ramka({ a: 1 });
    await expect(zbierz([r.subarray(0, r.length - 2)])).rejects.toMatchObject({ kod: 'zadanie_niepoprawne' });
  });
});

describe('zakodujRamke', () => {
  it('liczy długość w bajtach UTF-8, nie w znakach', () => {
    const r = zakodujRamke({ t: 'ąę' }, 1024);
    expect(r.readUInt32LE(0)).toBe(Buffer.byteLength('{"t":"ąę"}'));
  });

  it('odmawia odpowiedzi ponad limit (Chrome zerwałby połączenie bez treści)', () => {
    expect(() => zakodujRamke({ t: 'x'.repeat(2000) }, 1000)).toThrow(expect.objectContaining({ kod: 'za_duzy' }));
  });
});
