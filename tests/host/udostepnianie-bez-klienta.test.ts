import { expect, test } from 'vitest';
import { KanalUdostepniania } from '../../src/host/udostepnianie';
import { KOMUNIKATY_LAN, WERSJA_UDOSTEPNIANIA, type WiadomoscHostSw } from '../../src/wspolne/udostepnianie';

/**
 * Host z publicznego pakietu npm jest budowany bez klienta tabletu (klient to część wtyczki, S-37).
 * Start udostępniania ma wtedy odmówić, zamiast podać tabletowi pustą stronę.
 */
test('host bez klienta tabletu odmawia startu udostępniania', async () => {
  const wyslane: WiadomoscHostSw[] = [];
  const dziennik: [string, boolean][] = [];
  const kanal = new KanalUdostepniania(w => { wyslane.push(w); }, () => '', (typ, ok) => { dziennik.push([typ, ok]); });
  await kanal.przyjmij({
    kanal: 'udostepnianie', wersja: WERSJA_UDOSTEPNIANIA, typ: 'start', idZadania: 'z1',
    upstream: { host: 'localhost', port: 5173 }, sciezka: '/',
  });
  expect(wyslane).toEqual([{
    kanal: 'udostepnianie', wersja: WERSJA_UDOSTEPNIANIA, typ: 'blad', idZadania: 'z1',
    kod: 'niedozwolone', blad: KOMUNIKATY_LAN.niedozwolone,
  }]);
  expect(dziennik).toEqual([['lan_start', false]]);
});
