import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { migawkaStanowiska, odpal, stanowisko, type Stanowisko } from './instalator-pomocnicze';
import { doctor, konfig, zainstalowane as zainstalowaneW } from './doctor-pomocnicze';
import { katalogTymczasowy, zbudujDistDlaTestow } from './pomocnicze';

vi.setConfig({ testTimeout: 60_000 });

/** S-33 faza 2 (D5–D9) i opcje (D14): `doctor` na zbudowanym instalatorze, tymczasowy HOME i profil, zaślepki CLI. */

const baza = katalogTymczasowy('uwagi-doctor-');

beforeAll(() => zbudujDistDlaTestow(), 120_000);

const zainstalowane = (): Stanowisko => zainstalowaneW(baza);

describe('doctor: stan i zdrowa instalacja', () => {
  it('D5 brak instalacji: nie_polaczono, kod 0, bez błędu, zero plików', () => {
    const s = stanowisko(baza);
    const przed = migawkaStanowiska(s);
    const w = doctor(s);
    expect(w.kod, w.stdout + w.stderr).toBe(0);
    expect(w.stdout).toContain('nie_polaczono: Połączenie nie jest skonfigurowane. Czat działa bez niego.');
    expect(w.stdout).not.toContain('[błąd]');
    expect(w.stdout).toContain('Niczego nie wysyła');
    expect(migawkaStanowiska(s)).toEqual(przed);
  });

  it('D6 zdrowa instalacja: dym ok, kod 0, „Wszystko gra.”, doctor sam nic nie zapisuje', () => {
    const s = zainstalowane();
    const przed = migawkaStanowiska(s);
    const w = doctor(s);
    expect(w.kod, w.stdout + w.stderr).toBe(0);
    expect(w.stdout).toMatch(/\[ok\] +host_ping_ok: .*protokół \d+/);
    expect(w.stdout).not.toContain('[błąd]');
    expect(w.stdout).toContain('Wszystko gra.');
    const po = migawkaStanowiska(s);
    // Doctor nie zapisuje. Udany ping nie trafia do dziennika (sondowanie), więc dopuszczamy co najwyżej host.log.
    const rozne = Object.keys({ ...przed, ...po }).filter(k => przed[k] !== po[k]);
    expect(rozne.filter(k => k !== 'profil/herestt/host.log')).toEqual([]);
  });

  it('po undo (katalog zostaje z mapowaniami i dziennikiem) doctor mówi „nie skonfigurowane”, nie błąd', () => {
    const s = zainstalowane();
    const u = odpal(['undo', '--profil', s.profil], s.env());
    expect(u.kod, u.stdout + u.stderr).toBe(0);
    const w = doctor(s);
    expect(w.kod, w.stdout).toBe(0);
    expect(w.stdout).toContain('nie_polaczono');
    expect(w.stdout).not.toContain('[błąd]');
  });
});

describe('doctor: uszkodzenia', () => {
  it('D7 brak mcp.mjs → plik_brak, kod 1, działanie z wersjonowanym poleceniem', () => {
    const s = zainstalowane();
    rmSync(konfig(s, 'mcp.mjs'));
    const w = doctor(s);
    expect(w.kod).toBe(1);
    expect(w.stdout).toContain('plik_brak:mcp.mjs');
    expect(w.stdout).toMatch(/Działanie: Uruchom ponownie polecenie połączenia: npx heresthething@\d/);
    expect(w.stdout).toMatch(/Co teraz: Uruchom ponownie polecenie połączenia/);
  });

  it.each([
    ['binarne śmieci', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80])],
    ['pusty plik', Buffer.alloc(0)],
    ['nie JSON', Buffer.from('to nie jest json {')],
    ['tablica', Buffer.from('[1,2,3]')],
    ['zły identyfikator', Buffer.from(JSON.stringify({ wersja: 1, idWtyczki: 'x', binarki: {} }))],
    ['za duży', Buffer.alloc(200_000, 0x20)],
  ])('D7 config.json: %s → config_zly, kod 1, bez wyjątku', (_nazwa, tresc) => {
    const s = zainstalowane();
    writeFileSync(konfig(s, 'config.json'), tresc, { mode: 0o600 });
    const w = doctor(s);
    expect(w.kod, w.stdout + w.stderr).toBe(1);
    expect(w.stdout).toContain('config_zly');
    expect(w.stderr).toBe('');
  });

  it('D7 program z config.json zniknął → binarka_brak:git', () => {
    const s = zainstalowane();
    const dane = JSON.parse(readFileSync(konfig(s, 'config.json'), 'utf8')) as { binarki: Record<string, string> };
    dane.binarki.git = '/nie/ma/takiego/gita';
    writeFileSync(konfig(s, 'config.json'), JSON.stringify({ wersja: 1, ...dane }), { mode: 0o600 });
    const w = doctor(s);
    expect(w.kod).toBe(1);
    expect(w.stdout).toContain('binarka_brak:git');
  });

  it('D7 dziennik instalacji ze śmieciami → dziennik_zly (uwaga, nie błąd), a reszta idzie dalej', () => {
    const s = zainstalowane();
    writeFileSync(konfig(s, 'instalacja.json'), Buffer.from([0x00, 0xff, 0x7b]));
    const w = doctor(s);
    expect(w.stdout).toContain('dziennik_zly');
    expect(w.stdout).toMatch(/\[ok\] +host_ping_ok/);
    expect(w.kod).toBe(0);
  });

  it('D7 dziennik z częściowym zapisem → dziennik_czesciowy z poleceniem undo', () => {
    const s = zainstalowane();
    const dz = JSON.parse(readFileSync(konfig(s, 'instalacja.json'), 'utf8')) as { stan: string };
    dz.stan = 'czesciowy';
    writeFileSync(konfig(s, 'instalacja.json'), JSON.stringify(dz));
    const w = doctor(s);
    expect(w.stdout).toMatch(/\[uwaga\] +dziennik_czesciowy/);
    expect(w.stdout).toMatch(/npx heresthething@\d\S* undo/);
  });

  it('D7 dziennik i ustawienia wskazują różne wtyczki → id_rozne', () => {
    const s = zainstalowane();
    const dz = JSON.parse(readFileSync(konfig(s, 'instalacja.json'), 'utf8')) as { idWtyczki: string };
    dz.idWtyczki = 'p'.repeat(32);
    writeFileSync(konfig(s, 'instalacja.json'), JSON.stringify(dz));
    const w = doctor(s);
    expect(w.kod).toBe(1);
    expect(w.stdout).toContain('id_rozne');
  });

  it('D7 za szerokie prawa config.json → config_prawa', () => {
    const s = zainstalowane();
    chmodSync(konfig(s, 'config.json'), 0o644);
    const w = doctor(s);
    expect(w.stdout).toMatch(/\[uwaga\] +config_prawa/);
  });

  it('D7 host.log z uciętą linią, JSON bez pól i błędami: liczy, nie rzuca, nie pokazuje treści', () => {
    const s = zainstalowane();
    const t = '2026-11-13T10:00:00.000Z';
    writeFileSync(konfig(s, 'host.log'), [
      `{"t":"${t}","typ":"deliver","ok":false,"kod":"projekt_nie_git","ms":3}`,
      `{"t":"${t}","typ":"deliver","ok":false,"kod":"projekt_nie_git","ms":3}`,
      '{"t":"2026-11-13T10:00:01.000Z","typ":"ping","ok":true,"ms":1}',
      '{"bez":"pol"}',
      '{"t":"2026-11-13',
      '[1,2]',
    ].join('\n'));
    const w = doctor(s);
    expect(w.stdout).toMatch(/log_bledy: .*2 \/ 6: projekt_nie_git×2; ostatni 2026-11-13T10:00:00\.000Z/);
    expect(w.stdout).toMatch(/log_uszkodzony: .*\(3\)/);
    expect(w.kod).toBe(0);
  });

  it('mapowania: tylko liczba projektów', () => {
    const s = zainstalowane();
    writeFileSync(konfig(s, 'mapowania.json'), JSON.stringify({ wersja: 1, mapowania: { 'https://a.example': '/tajny/projekt-1', 'https://b.example': '/tajny/projekt-2' } }));
    const w = doctor(s);
    expect(w.stdout).toMatch(/mapowania: .*\(2\)/);
    expect(w.stdout).not.toContain('/tajny/');
    expect(w.stdout).not.toContain('a.example');
  });
});

describe('doctor: dym przy ubogim PATH', () => {
  const launcher = (s: Stanowisko, tresc: string): void => {
    const sciezka = konfig(s, 'uruchom-host.sh');
    writeFileSync(sciezka, `#!/bin/sh\n${tresc}\n`, { mode: 0o755 });
    chmodSync(sciezka, 0o755);
  };

  it.each([
    ['pusty, kod 0', 'exit 0', 'odpowiedź nieczytelna'],
    ['nagłówek kłamie o długości', "printf '\\377\\377\\377\\377'", 'odpowiedź nieczytelna'],
    ['1 MB śmieci', 'head -c 1048576 /dev/zero', 'odpowiedź nieczytelna'],
    ['kod wyjścia 3', 'exit 3', 'kod wyjścia 3'],
    ['ramka bez końca', "printf '\\020\\000\\000\\000{\"ok\":tr'", 'odpowiedź nieczytelna'],
  ])('D8 launcher: %s → host_ping_blad (%s), bez wyjątku i bez surowego tekstu', (_nazwa, skrypt, powod) => {
    const s = zainstalowane();
    launcher(s, `echo CANARY-STDERR-TAJNE 1>&2\n${skrypt}`);
    const w = doctor(s);
    expect(w.kod, w.stdout + w.stderr).toBe(1);
    expect(w.stdout).toMatch(new RegExp(`\\[błąd\\] +host_ping_blad: .*\\(${powod}\\)`));
    expect(w.stdout + w.stderr).not.toContain('CANARY');
    expect(w.stderr).toBe('');
  });

  it('D8 dym idzie z ubogim PATH jak z Docka: program dostępny tylko na PATH testu nie jest widoczny dla launchera', () => {
    const s = zainstalowane();
    const narzedzie = join(s.bin, 'tylko-w-pelnym-path');
    writeFileSync(narzedzie, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const tresc = '{"ok":true,"typ":"ping","wersjaHosta":"0.1.0","wersja":2}';
    const dlugosc = tresc.length.toString(8).padStart(3, '0');
    launcher(s, `command -v tylko-w-pelnym-path >/dev/null 2>&1 || exit 7\nprintf '\\${dlugosc}\\000\\000\\000${tresc}'`);
    // Kontrola: ten sam launcher z PATH testu (pełnym) by zadziałał.
    const pelny = spawnSync(konfig(s, 'uruchom-host.sh'), [], { env: s.env(), input: '' });
    expect(pelny.status).toBe(0);
    // doctor puszcza go z PATH=/usr/bin:/bin:/usr/sbin:/sbin, więc musi zgłosić objaw.
    const w = doctor(s);
    expect(w.kod, w.stdout).toBe(1);
    expect(w.stdout).toMatch(/\[błąd\] +host_ping_blad: .*\(kod wyjścia 7\)/);
  });

  it('D8 wiszący launcher → czas minął po skróconym limicie', () => {
    const s = zainstalowane();
    launcher(s, 'exec sleep 20');
    const start = Date.now();
    const w = doctor(s, { HERESTT_DOCTOR_LIMIT_MS: '400' });
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(w.stdout).toMatch(/host_ping_blad: .*\(czas minął\)/);
  });
});

describe('doctor: wyciek', () => {
  it('D9 kanarki w plikach i na wyjściu launchera nie trafiają do raportu, ścieżka domowa tylko jako ~', () => {
    const s = zainstalowane();
    const dane = JSON.parse(readFileSync(konfig(s, 'config.json'), 'utf8')) as Record<string, unknown>;
    dane.tajne = 'CANARY-TOKEN-sk-abcdefghijklmnopqrstuvwx';
    writeFileSync(konfig(s, 'config.json'), JSON.stringify(dane), { mode: 0o600 });
    const dz = JSON.parse(readFileSync(konfig(s, 'instalacja.json'), 'utf8')) as Record<string, unknown>;
    dz.tajne = 'CANARY-DZIENNIK';
    writeFileSync(konfig(s, 'instalacja.json'), JSON.stringify(dz));
    writeFileSync(konfig(s, 'mapowania.json'), JSON.stringify({ wersja: 1, mapowania: { 'https://tajna-strona.example': `${s.home}/NAZWA-PROJEKTU-TAJNA` } }));
    writeFileSync(konfig(s, 'host.log'), `${JSON.stringify({ t: '2026-11-13T10:00:00.000Z', typ: 'deliver', ok: false, kod: 'CANARY-KOD', projekt: `${s.home}/NAZWA-PROJEKTU-TAJNA`, ms: 1 })}\n`);
    mkdirSync(join(s.home, 'NAZWA-PROJEKTU-TAJNA'), { recursive: true });
    const w = doctor(s);
    const wszystko = w.stdout + w.stderr;
    for (const kanarek of ['CANARY', 'NAZWA-PROJEKTU-TAJNA', 'tajna-strona', s.home, s.profil, 'sk-abcdefgh']) {
      expect(wszystko, kanarek).not.toContain(kanarek);
    }
    expect(wszystko).toContain('<profil>/herestt');
  });
});

describe('doctor: opcje i język', () => {
  it.each([['--yes'], ['--dry-run'], ['--all'], ['--browsers', 'chrome'], ['--agents', 'claude'], ['--id', 'a'.repeat(32)], ['undo']])('D14 doctor %s → kod 2, zero plików', (...opcje) => {
    const s = stanowisko(baza);
    const przed = migawkaStanowiska(s);
    const w = odpal(['doctor', ...opcje, '--profil', s.profil], s.env());
    expect(w.kod).toBe(2);
    expect(w.stdout).toContain('doctor');
    expect(migawkaStanowiska(s)).toEqual(przed);
  });

  it('D14 inny system niż macOS: zdanie D15, kod 0', () => {
    const s = stanowisko(baza);
    const w = doctor(s, { HERESTT_PLATFORM: 'linux' });
    expect(w.kod).toBe(0);
    expect(w.stdout).toContain('Połączenie z agentem działa na razie tylko na macOS. Czat działa wszędzie.');
  });

  it('D14 język: LANG=pl daje polski, LANG=C angielski', () => {
    const s = stanowisko(baza);
    expect(doctor(s).stdout).toContain('Raport powstał na tym komputerze');
    const en = doctor(s, { LANG: 'C', LC_ALL: '' });
    expect(en.stdout).toContain('This report was made on this computer');
    expect(en.stdout).toContain('The connection is not set up. Chat works without it.');
    expect(en.stdout).toContain('All good.');
  });
});
