import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ID_DEV, doctor, dodajGet, konfig, manifestChrome, zainstalowane, wtyczkaWProfilu } from './doctor-pomocnicze';
import { migawkaStanowiska, stanowisko } from './instalator-pomocnicze';
import { katalogTymczasowy, zbudujDistDlaTestow } from './pomocnicze';

vi.setConfig({ testTimeout: 60_000 });

/** S-33 faza 3 (D10–D13): przeglądarki, agenci, ślady starej nazwy. Zaślepki CLI, tymczasowy HOME. */

const baza = katalogTymczasowy('uwagi-doctor-przeg-');

beforeAll(() => zbudujDistDlaTestow(), 120_000);

const manifest = (s: ReturnType<typeof stanowisko>): Record<string, unknown> => JSON.parse(readFileSync(manifestChrome(s), 'utf8')) as Record<string, unknown>;

describe('doctor: przeglądarki', () => {
  it('zdrowa instalacja: wiersz przeglądarki z faktami, Arc bez opisu to tylko informacja', () => {
    const s = zainstalowane(baza);
    const w = doctor(s);
    expect(w.kod, w.stdout).toBe(0);
    expect(w.stdout).toMatch(/\[info\] +przegladarka: .*Chrome: aplikacja jest, opis połączenia jest, wtyczka w profilu jest/);
    expect(w.stdout).toMatch(/przegladarka: .*Arc \(niesprawdzone\): aplikacja jest, opis połączenia brak/);
    expect(w.stdout).not.toMatch(/\[uwaga\]/);
    expect(w.stdout).toContain('Wszystko gra.');
  });

  it('D10 obcy identyfikator w opisie → manifest_origin_inny (blad, kod 1)', () => {
    const s = zainstalowane(baza);
    writeFileSync(manifestChrome(s), JSON.stringify({ ...manifest(s), allowed_origins: [`chrome-extension://${'p'.repeat(32)}/`] }));
    const w = doctor(s);
    expect(w.kod).toBe(1);
    expect(w.stdout).toMatch(/\[błąd\] +manifest_origin_inny: .*\(Chrome\)/);
  });

  it('D10 opis wskazuje inny program → manifest_sciezka_inna', () => {
    const s = zainstalowane(baza);
    writeFileSync(manifestChrome(s), JSON.stringify({ ...manifest(s), path: '/inna/instalacja/uruchom-host.sh' }));
    const w = doctor(s);
    expect(w.kod).toBe(1);
    expect(w.stdout).toContain('manifest_sciezka_inna');
    expect(w.stdout).not.toContain('/inna/instalacja');
  });

  it.each([['śmieci', Buffer.from([0xff, 0x00, 0x7b])], ['pusty', Buffer.alloc(0)], ['tablica', Buffer.from('[]')]])('D10 opis nieczytelny (%s) → manifest_zly', (_n, tresc) => {
    const s = zainstalowane(baza);
    writeFileSync(manifestChrome(s), tresc);
    const w = doctor(s);
    expect(w.kod).toBe(1);
    expect(w.stdout).toContain('manifest_zly');
    expect(w.stderr).toBe('');
  });

  it('D10 opis jest, wtyczki nie ma w żadnym profilu → wtyczki_brak_w_profilu (uwaga, kod 0)', () => {
    const s = stanowisko(baza);
    const w0 = doctor(s);
    expect(w0.kod).toBe(0);
    const zainst = zainstalowane(baza);
    rmSync(join(zainst.home, 'Library'), { recursive: true });
    const w = doctor(zainst);
    expect(w.kod).toBe(0);
    expect(w.stdout).toMatch(/\[uwaga\] +wtyczki_brak_w_profilu: .*\(Chrome\)/);
    expect(w.stdout).toMatch(/Co teraz: Uruchom polecenie połączenia ponownie i zaznacz przeglądarkę/);
  });

  it('wtyczka rozpakowana: brak Extensions/<id>, wpis w Secure Preferences lub Preferences → wtyczka w profilu jest, bez uwagi', () => {
    for (const plik of ['Secure Preferences', 'Preferences']) {
      const s = zainstalowane(baza);
      const chrome = join(s.home, 'Library/Application Support/Google/Chrome');
      rmSync(join(chrome, 'Default/Extensions'), { recursive: true });
      // Drugi profil bez wpisu i katalog bez ustawień nie psują wyniku.
      mkdirSync(join(chrome, 'Profile 1'), { recursive: true });
      writeFileSync(join(chrome, 'Profile 1/Preferences'), JSON.stringify({ extensions: { settings: { [`${'b'.repeat(32)}`]: {} } } }));
      mkdirSync(join(chrome, 'Crashpad'), { recursive: true });
      writeFileSync(join(chrome, 'Default', plik), JSON.stringify({ extensions: { settings: { [ID_DEV]: { path: '/home/x/dist/ext', location: 4 } } } }));
      const w = doctor(s);
      expect(w.kod, w.stdout).toBe(0);
      expect(w.stdout).toMatch(/przegladarka: .*Chrome: aplikacja jest, opis połączenia jest, wtyczka w profilu jest/);
      expect(w.stdout).not.toContain('wtyczki_brak_w_profilu');
      expect(w.stdout).not.toContain('/home/x/dist/ext');
    }
  });

  it('ustawienia profilu nieczytelne i brak Extensions/<id> → wtyczka w profilu nieznana (info), bez uwagi', () => {
    const s = zainstalowane(baza);
    const profil = join(s.home, 'Library/Application Support/Google/Chrome/Default');
    rmSync(join(profil, 'Extensions'), { recursive: true });
    writeFileSync(join(profil, 'Secure Preferences'), '{"extensions": {"settings": ');
    const w = doctor(s);
    expect(w.kod, w.stdout).toBe(0);
    expect(w.stdout).toMatch(/\[info\] +przegladarka: .*Chrome: .*wtyczka w profilu nieznana/);
    expect(w.stdout).not.toContain('wtyczki_brak_w_profilu');
    expect(w.stderr).toBe('');
  });

  it('ustawienia czytelne, wpisu brak, katalogu brak → nadal wtyczki_brak_w_profilu', () => {
    const s = zainstalowane(baza);
    const profil = join(s.home, 'Library/Application Support/Google/Chrome/Default');
    rmSync(join(profil, 'Extensions'), { recursive: true });
    writeFileSync(join(profil, 'Preferences'), JSON.stringify({ extensions: { settings: { [`${'c'.repeat(32)}`]: {} } } }));
    const w = doctor(s);
    expect(w.stdout).toMatch(/\[uwaga\] +wtyczki_brak_w_profilu: .*\(Chrome\)/);
  });

  it('D10 wybrana przeglądarka bez opisu → manifest_brak; przeglądarka z wtyczką, ale bez opisu, też', () => {
    const s = zainstalowane(baza);
    rmSync(manifestChrome(s));
    const w = doctor(s);
    expect(w.stdout).toMatch(/\[uwaga\] +manifest_brak: .*\(Chrome\)/);
    const t = zainstalowane(baza);
    // Arc ma wtyczkę w profilu, ale nie był wybrany i nie ma opisu.
    mkdirSync(join(t.home, 'Library/Application Support/Arc/User Data/Default/Extensions', 'a'.repeat(32)), { recursive: true });
    expect(doctor(t).stdout).not.toMatch(/manifest_brak: .*\(Arc\)/);
  });

  it('D10 organizacja zarządza przeglądarką → przegladarka_zarzadzana, zawartość pliku poza raportem', () => {
    const s = zainstalowane(baza);
    const prefs = join(s.profil, 'managed');
    mkdirSync(prefs, { recursive: true });
    writeFileSync(join(prefs, 'com.google.Chrome.plist'), 'CANARY-POLITYKA-TAJNA');
    const w = doctor(s, { HERESTT_MANAGED_PREFS: prefs });
    expect(w.stdout).toMatch(/\[uwaga\] +przegladarka_zarzadzana: .*\(Chrome\)/);
    expect(w.stdout).toContain('Przeglądarką zarządza organizacja.');
    expect(w.stdout + w.stderr).not.toContain('CANARY');
    // plik w podkatalogu użytkownika też liczy się
    const t = zainstalowane(baza);
    const prefsT = join(t.profil, 'managed');
    mkdirSync(join(prefsT, 'ktokolwiek'), { recursive: true });
    writeFileSync(join(prefsT, 'ktokolwiek', 'com.google.Chrome.plist'), 'x');
    expect(doctor(t, { HERESTT_MANAGED_PREFS: prefsT, USER: 'ktokolwiek' }).stdout).toContain('przegladarka_zarzadzana');
  });

  it('opis w przeglądarce, ale katalogu programu nie ma → plik_brak:program (blad), nie „nie skonfigurowano”', () => {
    const s = zainstalowane(baza);
    rmSync(join(s.profil, 'herestt'), { recursive: true });
    const w = doctor(s);
    expect(w.kod).toBe(1);
    expect(w.stdout).toContain('plik_brak:program');
    expect(w.stdout).not.toContain('nie_polaczono');
  });
});

describe('doctor: agenci', () => {
  it('D11 wpis jest: agent_wpis_ok, token z wyjścia agenta poza raportem, nowa sesja, kod 0', () => {
    const s = zainstalowane(baza);
    const w = doctor(s);
    expect(w.kod, w.stdout).toBe(0);
    expect(w.stdout).toMatch(/\[ok\] +agent_wpis_ok: .*\(Claude Code\)/);
    expect(w.stdout).toContain('agent_nowa_sesja');
    expect(w.stdout + w.stderr).not.toContain('CANARY');
    expect(w.stdout).not.toContain('TOKEN');
    // Codex nie był wybrany: brak wpisu to informacja, nie uwaga.
    expect(w.stdout).toMatch(/\[info\] +agent_bez_wpisu: .*\(Codex\)/);
  });

  it('D11 wpis usunięty: agent_bez_wpisu jako uwaga z działaniem, kod 0', () => {
    const s = zainstalowane(baza);
    rmSync(join(s.magazyn, 'claude.herestt'));
    const w = doctor(s);
    expect(w.kod).toBe(0);
    expect(w.stdout).toMatch(/\[uwaga\] +agent_bez_wpisu: .*\(Claude Code\)/);
    expect(w.stdout).toMatch(/Co teraz: Uruchom polecenie połączenia ponownie i zaznacz agenta/);
  });

  it('D11 wpis wskazuje inną instalację → agent_wpis_inna_sciezka', () => {
    const s = zainstalowane(baza);
    const w = doctor(s, { DOCTOR_GET_MODE: 'inna' });
    expect(w.stdout).toMatch(/\[uwaga\] +agent_wpis_inna_sciezka: .*\(Claude Code\)/);
    expect(w.stdout).not.toContain('/gdzies/indziej');
  });

  it.each([['smieci'], ['binarne']])('D11 wyjście agenta: %s (1 MB / binarne) → bez wyjątku, bez wycieku', mode => {
    const s = zainstalowane(baza);
    const w = doctor(s, { DOCTOR_GET_MODE: mode });
    expect(w.stderr).toBe('');
    expect(w.stdout + w.stderr).not.toContain('CANARY');
    expect(w.stdout).toContain('Claude Code');
    expect([0, 1]).toContain(w.kod);
  });

  it('D11 brak codex na PATH → agent_brak', () => {
    const s = zainstalowane(baza, ['claude']);
    const w = doctor(s);
    expect(w.stdout).toMatch(/\[info\] +agent_brak: .*\(Codex\)/);
  });

  it('D11 agent wiszący → limit czasu, bez zawieszenia', () => {
    const s = zainstalowane(baza);
    writeFileSync(join(s.bin, 'claude'), '#!/bin/sh\nexec sleep 20\n', { mode: 0o755 });
    const start = Date.now();
    const w = doctor(s, { HERESTT_DOCTOR_LIMIT_MS: '400' });
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(w.stdout).toMatch(/agent_bez_wpisu: .*\(Claude Code\)/);
  });

  it('D12 doctor woła tylko `mcp get`, nigdy add ani remove', () => {
    const s = zainstalowane(baza);
    const przed = readFileSync(s.log, 'utf8').split('\n').filter(l => l.length > 0).length;
    doctor(s);
    const nowe = readFileSync(s.log, 'utf8').split('\n').filter(l => l.length > 0).slice(przed);
    expect(nowe.length).toBeGreaterThan(0);
    for (const linia of nowe) expect(linia).toMatch(/^(claude|codex) mcp get herestt$/);
  });
});

describe('doctor: ślady starej nazwy', () => {
  it('D13 stary katalog i stary opis w przeglądarce → jedna uwaga stare_slady z liczbą', () => {
    const s = zainstalowane(baza);
    mkdirSync(join(s.profil, 'tryb-uwag'), { recursive: true });
    writeFileSync(join(s.profil, 'tryb-uwag', 'mapowania.json'), '{}');
    writeFileSync(join(s.profil, 'NativeMessagingHosts/pl.tryb_uwag.host.json'), '{}');
    const przed = migawkaStanowiska(s);
    const w = doctor(s);
    expect(w.stdout).toMatch(/\[uwaga\] +stare_slady: .*\(2\)/);
    expect(w.stdout).toMatch(/Uruchom polecenie połączenia: zdejmie je\./);
    const po = migawkaStanowiska(s);
    expect(Object.keys(po).filter(k => !k.endsWith('host.log') && po[k] !== przed[k])).toEqual([]);
  });

  it('D13 przy czystym koncie ślady też są pokazane, kod 0', () => {
    const s = stanowisko(baza);
    mkdirSync(join(s.profil, 'tryb-uwag'), { recursive: true });
    const w = doctor(s);
    expect(w.kod).toBe(0);
    expect(w.stdout).toContain('nie_polaczono');
    expect(w.stdout).toContain('stare_slady');
    expect(readdirSync(s.profil)).toEqual(['tryb-uwag']);
  });

  it('nic z dopisanych helperów nie zostawia stanu: dodajGet/wtyczkaWProfilu są idempotentne dla brakującego agenta', () => {
    const s = stanowisko(baza, ['claude']);
    expect(() => { dodajGet(s, 'codex'); wtyczkaWProfilu(s); }).not.toThrow();
    expect(konfig(s, 'x')).toContain('herestt');
  });
});
