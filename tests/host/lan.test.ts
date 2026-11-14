import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { NetworkInterfaceInfo } from 'node:os';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { uruchomSerwerLan, type SerwerLan } from '../../src/host/lan-serwer';
import { wybierzAdresWifi, podzielPng } from '../../src/host/lan-narzedzia';
import { walidujOperacjeLan, walidujWiadomoscHostSw, walidujWiadomoscSwHost } from '../../src/wspolne/udostepnianie';

vi.mock('node:os', () => ({ networkInterfaces: () => ({}) }));
let lan: SerwerLan | undefined;
let upstream: Server | undefined;
afterEach(async () => { await lan?.zamknij('koniec'); upstream?.closeAllConnections(); await new Promise<void>(r => upstream ? upstream.close(() => r()) : r()); });
const wpis = (address: string, extra = {}): NetworkInterfaceInfo => ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null, ...extra });
it('wybiera prywatny IPv4 Wi-Fi, odrzuca publiczny, wildcard, VPN i loopback', () => {
  expect(wybierzAdresWifi({ en0: [wpis('0.0.0.0'), wpis('8.8.8.8')], en1: [wpis('192.168.1.8')] })).toBe('192.168.1.8');
  expect(wybierzAdresWifi({ en0: [wpis('127.0.0.1', { internal: true })], utun0: [wpis('10.1.1.1')] })).toBeNull();
});
it.each([undefined, '0.0.0.0'])('brak Wi-Fi lub adres %s nie uruchamia nasłuchu', async adresTestowy => {
  await expect(uruchomSerwerLan({ upstream: { host: 'localhost', port: 80 }, sciezka: '/', klient: '', adresTestowy, wykonaj: async () => ({ ok: true, widok: { rewizja: 0, uwagi: [] } }) })).rejects.toMatchObject({ kod: 'brak_wifi' });
});
async function start(kodowanie?: string) {
  let polaczenia = 0;
  const html = Buffer.from('<html><head><title>fixture</title></head><body>Treść</body></html>');
  upstream = createServer((q, r) => {
    expect(q.headers.host).toBe(`127.0.0.1:${port}`);
    const dane = kodowanie === 'gzip' ? gzipSync(html) : kodowanie === 'br' ? brotliCompressSync(html) : kodowanie === 'deflate' ? deflateSync(html) : html;
    r.writeHead(200, { 'content-type': 'text/html', ...(kodowanie ? { 'content-encoding': kodowanie } : {}) }).end(dane);
  });
  upstream.on('connection', () => polaczenia++);
  await new Promise<void>(r => upstream!.listen(0, '127.0.0.1', r));
  const nasluch = upstream.address();
  if (!nasluch || typeof nasluch === 'string') throw new Error('Brak portu fixture');
  const port = nasluch.port;
  lan = await uruchomSerwerLan({ upstream: { host: '127.0.0.1', port }, sciezka: '/?x=1', klient: 'window.fixture = true;', adresTestowy: '127.0.0.1', wykonaj: async () => ({ ok: true, widok: { rewizja: 0, uwagi: [] } }) });
  return { origin: new URL(lan.url).origin, polaczenia: () => polaczenia };
}
it('HTTP i upgrade bez dostępu zwracają 403 bez połączenia upstream', async () => {
  const s = await start();
  expect((await fetch(s.origin)).status).toBe(403);
  expect((await fetch(s.origin + '/?__tryb_uwag=obcy')).status).toBe(403);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const q = request(s.origin, { headers: { connection: 'Upgrade', upgrade: 'websocket' } }, r => { r.resume(); resolve(r.statusCode); });
    q.on('error', reject); q.end();
  });
  expect(status).toBe(403);
  expect(s.polaczenia()).toBe(0);
});
it.each([undefined, 'gzip', 'br', 'deflate'])('token ustawia bezpieczne cookie, HTML %s zawiera zewnętrzny klient', async kodowanie => {
  const s = await start(kodowanie);
  const wejscie = await fetch(lan!.url, { redirect: 'manual' });
  expect(wejscie.status).toBe(303);
  expect(wejscie.headers.get('location')).toBe('/?x=1');
  const cookie = wejscie.headers.get('set-cookie')!;
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
  const headers = { cookie: cookie.split(';')[0]! };
  const strona = await fetch(s.origin + '/?x=1', { headers });
  expect(strona.headers.get('content-encoding')).toBeNull();
  expect(await strona.text()).toBe('<html><head><title>fixture</title><script src="/__tryb-uwag/klient.js"></script></head><body>Treść</body></html>');
  expect(await (await fetch(s.origin + '/__tryb-uwag/klient.js', { headers })).text()).toBe('window.fixture = true;');
  expect((await fetch(s.origin + '/__tryb-uwag/sesja', { headers: { ...headers, origin: 'http://obcy' } })).status).toBe(403);
  for (const op of ['agenci', 'wyslij', 'mapowania', 'status']) expect((await fetch(s.origin + '/__tryb-uwag/' + op, { headers })).status).toBe(403);
});
describe('uwaga bez typu w kontrakcie (FR-025)', () => {
  const zapisz = (typUwagi: unknown) => ({ typ: 'zapisz', uwaga: { id: 'uwaga-1', tekst: 'Treść', typUwagi, url: 'http://127.0.0.1:4321/', scrollX: 0, scrollY: 0, szerokoscWidoku: 800, wysokoscWidoku: 600, dpr: 2, selektor: null, idTransferu: null } });
  const widok = (typUwagi: unknown) => ({ kanal: 'udostepnianie', wersja: 1, typ: 'sesja', widok: { rewizja: 1, uwagi: [{ id: 'uwaga-1', numer: 1, tekst: 'Treść', typUwagi, wlasna: true, maRysunek: false }] } });

  it('tablet może zapisać uwagę bez typu i z typem', () => {
    expect(walidujOperacjeLan(zapisz(null))).toBe(true);
    expect(walidujOperacjeLan(zapisz('kolor'))).toBe(true);
  });

  it('jedna uwaga bez typu nie unieważnia widoku sesji na tablecie', () => {
    expect(walidujWiadomoscSwHost(widok(null))).toBe(true);
    expect(walidujWiadomoscSwHost(widok('treść'))).toBe(true);
  });

  it('obca wartość i brak pola dalej są odrzucane', () => {
    expect(walidujOperacjeLan(zapisz('usuń repo'))).toBe(false);
    expect(walidujOperacjeLan(zapisz(undefined))).toBe(false);
    expect(walidujWiadomoscSwHost(widok('usuń repo'))).toBe(false);
  });
});
it.each(['wyslij', 'agenci', 'mapowania', 'status', 'potwierdzProjekt'])('kontrakt odrzuca operację %s', typ => {
  expect(walidujOperacjeLan({ typ })).toBe(false);
});
it.each(['projekt', 'origin', 'upstream'])('kontrakt odrzuca narzucone pole %s', pole => {
  expect(walidujOperacjeLan({ typ: 'sesja', [pole]: 'obcy' })).toBe(false);
});
it('PNG ponad 512 KiB jest kompletne, każda ramka mieści się w limicie', () => {
  const dane = Buffer.alloc(700_001); for (let i = 0; i < dane.length; i++) dane[i] = i % 251;
  const porcje = [...podzielPng(dane, 'transfer')];
  for (const p of porcje) { expect(walidujWiadomoscHostSw(p)).toBe(true); expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(512 * 1024); }
  expect(porcje.map(p => p.numer)).toEqual([0, 1, 2]);
  expect(Buffer.concat(porcje.map(p => Buffer.from(p.daneBase64, 'base64')))).toEqual(dane);
});
