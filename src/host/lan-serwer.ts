import { randomBytes } from 'node:crypto';
import { createServer, request, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { isIPv4, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { CIASTECZKO, KOMUNIKATY_LAN, LIMITY_UDOSTEPNIANIA as L, PARAMETR_TOKENU, SCIEZKA_ZAREZERWOWANA as P, walidujCialoUwagi, walidujOperacjeLan, type KodBleduLan, type OperacjaLan, type OdpowiedzLan, type UpstreamLan, type WidokSesjiLan } from '../wspolne/udostepnianie';
import { poprawneCiasteczko, poprawnyToken, wybierzAdresWifi, wstrzyknijHtml } from './lan-narzedzia';

export class BladLan extends Error {
  constructor(readonly kod: KodBleduLan) { super(KOMUNIKATY_LAN[kod]); }
}
export function bladLan(kod: KodBleduLan): OdpowiedzLan { return { ok: false, kod, blad: KOMUNIKATY_LAN[kod] }; }
function json(res: ServerResponse, status: number, dane: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(dane));
}
function naglowki(req: IncomingMessage, upstream: UpstreamLan): OutgoingHttpHeaders {
  const wynik = { ...req.headers, host: `${upstream.host}:${upstream.port}`, 'accept-encoding': 'identity' };
  // Token LAN nigdy nie opuszcza hosta w Cookie ani Referer.
  if (wynik.cookie) wynik.cookie = wynik.cookie.split(';').filter(pole => pole.trim().split('=')[0] !== CIASTECZKO).join(';');
  delete wynik.referer;
  return wynik;
}
function cialo(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const czesci: Buffer[] = [];
    let rozmiar = 0;
    let skonczone = false;
    req.on('data', (b: Buffer) => {
      if (skonczone) return;
      rozmiar += b.length;
      if (rozmiar > L.cialoZadaniaLanBajty) {
        skonczone = true;
        czesci.length = 0;
        reject(new BladLan('za_duzy'));
      } else czesci.push(b);
    });
    req.once('end', () => {
      if (skonczone) return;
      skonczone = true;
      try { resolve(JSON.parse(Buffer.concat(czesci, rozmiar).toString('utf8'))); }
      catch { reject(new BladLan('zadanie_niepoprawne')); }
    });
    req.once('error', () => { skonczone = true; reject(new BladLan('rozlaczono')); });
    req.once('aborted', () => { skonczone = true; reject(new BladLan('rozlaczono')); });
  });
}

export type SerwerLan = {
  adres: string; port: number; url: string;
  sesja(widok: WidokSesjiLan): void;
  zamknij(powod: string): Promise<void>;
};
export async function uruchomSerwerLan(opcje: {
  upstream: UpstreamLan; sciezka: string; klient: string; adresTestowy?: string;
  wykonaj(operacja: OperacjaLan, png?: Buffer, sygnal?: AbortSignal): Promise<OdpowiedzLan>;
}): Promise<SerwerLan> {
  const { upstream } = opcje;
  if (!['localhost', '127.0.0.1'].includes(upstream.host) || !Number.isInteger(upstream.port) || upstream.port < 1 || upstream.port > 65535) throw new BladLan('upstream_niepoprawny');
  const adres = opcje.adresTestowy ?? wybierzAdresWifi(networkInterfaces());
  if (!adres || !isIPv4(adres) || adres === '0.0.0.0') throw new BladLan('brak_wifi');
  const token = randomBytes(32).toString('hex');
  const gniazda = new Set<Socket>();
  const strumienie = new Set<ServerResponse>();
  const odpowiedzi = new Set<ServerResponse>();
  let zamkniety = false;
  const sledz = (socket: Socket): void => { gniazda.add(socket); socket.once('close', () => gniazda.delete(socket)); };
  const serwer = createServer((req, res) => {
    odpowiedzi.add(res);
    res.once('close', () => odpowiedzi.delete(res));
    void obsluz(req, res).catch(e => {
      const kod = e instanceof BladLan ? e.kod : 'zadanie_niepoprawne';
      json(res, kod === 'za_duzy' ? 413 : kod === 'niedozwolone' ? 403 : 400, bladLan(kod));
    });
  });
  serwer.on('connection', sledz);
  async function obsluz(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (zamkniety) { json(res, 503, bladLan('rozlaczono')); return; }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) { json(res, 403, bladLan('niedozwolone')); return; }
    const url = new URL(req.url, 'http://lan');
    if (url.searchParams.has(PARAMETR_TOKENU)) {
      if (req.method !== 'GET' || !poprawnyToken(url.searchParams.get(PARAMETR_TOKENU), token)) { json(res, 403, bladLan('nieautoryzowany')); return; }
      url.searchParams.delete(PARAMETR_TOKENU);
      res.writeHead(303, { location: url.pathname + url.search, 'set-cookie': `${CIASTECZKO}=${token}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(); return;
    }
    if (!poprawneCiasteczko(req.headers.cookie, token)) { json(res, 403, bladLan('nieautoryzowany')); return; }
    if (url.pathname.startsWith(P)) {
      // Brak CORS i kontrola Origin blokują operacje z obcego originu.
      if (req.headers.origin && req.headers.origin !== `http://${adres}:${port}`) { json(res, 403, bladLan('niedozwolone')); return; }
      const sciezka = url.pathname.slice(P.length);
      if (sciezka === 'klient.js' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' }); res.end(opcje.klient); return;
      }
      if (sciezka === 'zdarzenia' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': polaczono\n\n'); strumienie.add(res);
        res.once('close', () => strumienie.delete(res)); return;
      }
      let operacja: OperacjaLan;
      let png: Buffer | undefined;
      if (sciezka === 'sesja' && req.method === 'GET' && !url.search) operacja = { typ: 'sesja' };
      else if (sciezka === 'uwaga' && req.method === 'POST' && !url.search) {
        const dane = await cialo(req);
        if (!walidujCialoUwagi(dane)) throw new BladLan('zadanie_niepoprawne');
        operacja = { typ: 'zapisz', uwaga: { ...dane.uwaga, idTransferu: null } };
        if (dane.pngBase64) png = Buffer.from(dane.pngBase64, 'base64');
      } else if (sciezka === 'usun' && req.method === 'POST' && !url.search) {
        const dane = await cialo(req);
        if (typeof dane !== 'object' || dane === null || Object.keys(dane).length !== 1 || !('id' in dane)) throw new BladLan('niedozwolone');
        const usun = { typ: 'usun', id: dane.id };
        if (!walidujOperacjeLan(usun)) throw new BladLan('zadanie_niepoprawne');
        operacja = usun;
      } else { json(res, 403, bladLan('niedozwolone')); return; }
      const kontroler = new AbortController();
      const anuluj = (): void => { if (!res.writableEnded) kontroler.abort(); };
      res.once('close', anuluj);
      try { json(res, 200, await opcje.wykonaj(operacja, png, kontroler.signal)); }
      finally { res.off('close', anuluj); }
      return;
    }
    const doGory = request({ hostname: upstream.host, port: upstream.port, path: req.url, method: req.method, headers: naglowki(req, upstream) }, odpowiedz => {
      const headers = { ...odpowiedz.headers };
      if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].filter(pole => pole.split('=')[0]!.trim() !== CIASTECZKO);
      const html = String(headers['content-type'] ?? '').toLowerCase().includes('text/html') && req.method !== 'HEAD';
      if (!html) { res.writeHead(odpowiedz.statusCode ?? 502, headers); odpowiedz.pipe(res); return; }
      const czesci: Buffer[] = []; let bajty = 0;
      odpowiedz.on('data', (b: Buffer) => {
        bajty += b.length;
        if (bajty > 32 * 1024 * 1024) { doGory.destroy(); json(res, 502, bladLan('za_duzy')); }
        else czesci.push(b);
      });
      odpowiedz.on('end', () => {
        try {
          const wynik = wstrzyknijHtml(Buffer.concat(czesci), headers['content-encoding']);
          for (const klucz of ['content-encoding', 'content-length', 'transfer-encoding', 'content-security-policy', 'content-security-policy-report-only', 'etag', 'content-md5']) delete headers[klucz];
          headers['content-length'] = String(wynik.length);
          res.writeHead(odpowiedz.statusCode ?? 502, headers); res.end(wynik);
        } catch { json(res, 502, bladLan('zadanie_niepoprawne')); }
      });
      odpowiedz.on('error', () => { if (!res.headersSent) json(res, 502, bladLan('rozlaczono')); else res.destroy(); });
    });
    doGory.on('socket', sledz);
    doGory.on('error', () => { if (!res.headersSent) json(res, 502, bladLan('rozlaczono')); else res.destroy(); });
    res.once('close', () => doGory.destroy());
    req.pipe(doGory);
  }
  serwer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (zamkniety || !req.url?.startsWith('/') || req.url.startsWith('//')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    const url = new URL(req.url, 'http://lan');
    if (url.pathname.startsWith(P) || !(poprawneCiasteczko(req.headers.cookie, token) || poprawnyToken(url.searchParams.get(PARAMETR_TOKENU), token))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    url.searchParams.delete(PARAMETR_TOKENU);
    const doGory = request({ hostname: upstream.host, port: upstream.port, path: url.pathname + url.search, method: req.method, headers: naglowki(req, upstream) });
    doGory.on('socket', sledz);
    doGory.on('upgrade', (odpowiedz, drugi, reszta) => {
      sledz(drugi);
      socket.write(`HTTP/1.1 ${odpowiedz.statusCode} ${odpowiedz.statusMessage}\r\n`);
      for (let i = 0; i < odpowiedz.rawHeaders.length; i += 2) {
        const nazwa = odpowiedz.rawHeaders[i]!.toLowerCase();
        const wartosc = odpowiedz.rawHeaders[i + 1]!;
        if (nazwa !== 'set-cookie' || wartosc.split('=')[0]!.trim() !== CIASTECZKO) socket.write(`${odpowiedz.rawHeaders[i]}: ${wartosc}\r\n`);
      }
      socket.write('\r\n'); if (reszta.length) socket.write(reszta); if (head.length) drugi.write(head);
      socket.pipe(drugi).pipe(socket);
      socket.once('close', () => drugi.destroy()); drugi.once('close', () => socket.destroy());
      drugi.on('error', () => socket.destroy());
    });
    doGory.on('response', odpowiedz => { odpowiedz.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    doGory.on('error', () => socket.destroy()); socket.on('error', () => doGory.destroy()); socket.once('close', () => doGory.destroy());
    doGory.end();
  });
  await new Promise<void>((resolve, reject) => { serwer.once('error', reject); serwer.listen(0, adres, () => { serwer.off('error', reject); resolve(); }); });
  const nasluch = serwer.address();
  if (!nasluch || typeof nasluch === 'string') throw new BladLan('rozlaczono');
  const port = nasluch.port;
  const url = new URL(opcje.sciezka, `http://${adres}:${port}`);
  url.searchParams.set(PARAMETR_TOKENU, token);
  return {
    adres, port, url: url.href,
    sesja(widok) { for (const res of strumienie) res.write(`data: ${JSON.stringify({ typ: 'sesja', widok })}\n\n`); },
    async zamknij(powod) {
      if (zamkniety) return;
      zamkniety = true;
      for (const res of strumienie) res.end(`data: ${JSON.stringify({ typ: 'przerwane', powod })}\n\n`);
      for (const res of odpowiedzi) if (!strumienie.has(res)) json(res, 503, bladLan('rozlaczono'));
      const zamkniecie = new Promise<void>(resolve => serwer.close(() => resolve()));
      // Pozwala end() wysłać jawny błąd/SSE przed zniszczeniem także upgrade.
      await new Promise<void>(resolve => setImmediate(resolve));
      for (const socket of gniazda) socket.destroy();
      await zamkniecie;
    },
  };
}
