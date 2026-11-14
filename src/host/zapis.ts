import { historyjkaPoprawna, problemHistoryjki } from '../wspolne/historyjka';
import { constants as C, promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { LIMITY, MAKS_OBRAZOW_PLANSZY, PLIK_OBRAZU_PLANSZY, WZOR_ID_PACZKI, WZOR_NAZWY_ZRZUTU, WZOR_PLIKU_RYSUNKU } from '../wspolne/protokol';
import { BladHosta, zBleduSystemu } from './bledy';
import type { Binarki } from './konfiguracja';
import { gitCzyIgnorowane } from './uruchom';

/**
 * Zapis paczki do `<projekt>/.herestt/<idPaczki>/`.
 *
 * Odczyt (lista, treść, status, ścieżka istniejącej paczki) obejmuje też
 * `<projekt>/.scratch/uwagi-ui/`. Zapis i `.gitignore` dotyczą tylko nowego.
 *
 * Model zagrożeń (host.md §4 K4, §14): dane od wtyczki są niezaufane, a repo
 * może być sklonowanym złośliwym repo z zacommitowanym symlinkiem
 * (`.herestt`, a przy odczycie też `.scratch` i `uwagi-ui`, oraz `.gitignore`).
 * Wyścig z innym procesem tego samego użytkownika jest poza modelem (i tak ma
 * pełny dostęp), ale O_NOFOLLOW|O_EXCL zamyka go na ostatnim komponencie bez kosztu.
 *
 * Publikacja: katalog tymczasowy → pliki → jeden `rename`. Agent albo widzi
 * komplet, albo nic. `fsync` świadomie pomijamy (§6).
 */

export const KATALOG_UWAG = '.herestt';
/** Paczki sprzed zmiany nazwy. Tylko odczyt: nikt ich nie przenosi i nie kasuje. */
export const KATALOG_UWAG_STARY = join('.scratch', 'uwagi-ui');
const PLIK_MD = 'uwagi.md';
const PLIK_JSON = 'uwagi.json';
const PREFIKS_TMP = '.tmp-';
const STARY_TMP_MS = 60 * 60 * 1000;
const LIMIT_SCIEZKI_BAJTY = 1000; // PATH_MAX na macOS to 1024
const PNG_SYGNATURA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const PNG_MAKS_WYMIAR = 16384;
/** ~8K × 5K; ogranicza pamięć dekodera agenta przy „bombie” o małym pliku i ogromnych wymiarach (recenzja Codexa nr 7). */
const PNG_MAKS_PIKSELI = 40_000_000;

export type PaczkaZweryfikowana = {
  idPaczki: string;
  markdown: string;
  json: string;
  pliki: Array<[nazwa: string, dane: Buffer]>;
};

export type WynikZapisu = {
  paczka: 'zapisana' | 'istniejaca';
  /** Względem projektu, np. `.herestt/<id>/uwagi.md`. */
  sciezkaMdWzgledna: string;
  sciezkaMdAbsolutna: string;
  ostrzezenia: string[];
};

export function zweryfikujIdPaczki(id: unknown): string {
  if (typeof id !== 'string' || !WZOR_ID_PACZKI.test(id)) throw new BladHosta('id_niepoprawne', 'idPaczki nie pasuje do RRRR-MM-DD-HHmm-xxxxxx');
  return id;
}

/** Nagłówek, IHDR z rozsądnymi wymiarami i IEND na końcu — sam 8-bajtowy nagłówek nie wystarcza (red-team §14.2). */
function dekodujPng(nazwa: string, b64: unknown): Buffer {
  if (typeof b64 !== 'string') throw new BladHosta('zrzut_niepoprawny', `${nazwa}: brak danych`);
  // Wstępny limit na długości tekstu, żeby nie dekodować gigabajtów.
  if (b64.length > Math.ceil(LIMITY.zrzutBajty / 3) * 4 + 4) throw new BladHosta('za_duzy', `${nazwa}: zrzut > ${LIMITY.zrzutBajty} B`);
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new BladHosta('zrzut_niepoprawny', `${nazwa}: niepoprawny base64`);
  const buf = Buffer.from(b64, 'base64');
  // Właściwy limit po dekodowaniu (red-team §14.4: wcześniej przepuszczało +1 B).
  if (buf.length > LIMITY.zrzutBajty) throw new BladHosta('za_duzy', `${nazwa}: zrzut > ${LIMITY.zrzutBajty} B`);
  const ok =
    buf.length >= PNG_SYGNATURA.length + 25 + PNG_IEND.length &&
    buf.subarray(0, 8).equals(PNG_SYGNATURA) &&
    buf.readUInt32BE(8) === 13 &&
    buf.toString('latin1', 12, 16) === 'IHDR' &&
    buf.readUInt32BE(16) >= 1 &&
    buf.readUInt32BE(16) <= PNG_MAKS_WYMIAR &&
    buf.readUInt32BE(20) >= 1 &&
    buf.readUInt32BE(20) <= PNG_MAKS_WYMIAR &&
    buf.readUInt32BE(16) * buf.readUInt32BE(20) <= PNG_MAKS_PIKSELI &&
    buf.subarray(buf.length - PNG_IEND.length).equals(PNG_IEND);
  if (!ok) throw new BladHosta('zrzut_niepoprawny', `${nazwa}: to nie jest kompletny PNG`);
  return buf;
}

/** Walidacja czysta (bez FS): kształt, limity, whitelisty nazw. */
export function zweryfikujPaczke(surowa: unknown): PaczkaZweryfikowana {
  if (typeof surowa !== 'object' || surowa === null) throw new BladHosta('zadanie_niepoprawne', 'brak paczki');
  const p = surowa as Record<string, unknown>;
  const idPaczki = zweryfikujIdPaczki(p.idPaczki);
  if (typeof p.markdown !== 'string' || p.markdown.length === 0) throw new BladHosta('zadanie_niepoprawne', 'brak markdown');
  if (Buffer.byteLength(p.markdown) > LIMITY.markdownBajty) throw new BladHosta('za_duzy', 'markdown');
  if (typeof p.json !== 'string') throw new BladHosta('zadanie_niepoprawne', 'brak json');
  if (Buffer.byteLength(p.json) > LIMITY.jsonBajty) throw new BladHosta('za_duzy', 'json');
  let json: unknown;
  try {
    json = JSON.parse(p.json);
  } catch {
    throw new BladHosta('json_niepoprawny', 'json nie parsuje się');
  }
  // `null`, liczba czy tablica to nie paczka uwag (red-team §14.3).
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new BladHosta('json_niepoprawny', 'json musi być obiektem');
  if (!Array.isArray(p.zrzuty)) throw new BladHosta('zadanie_niepoprawne', 'zrzuty muszą być tablicą');
  if (p.zrzuty.length > LIMITY.zrzutow) throw new BladHosta('za_duzo_zrzutow', `zrzutów ${p.zrzuty.length} > ${LIMITY.zrzutow}`);

  const nazwy = new Set<string>();
  const pliki: Array<[string, Buffer]> = [];
  for (const z of p.zrzuty as unknown[]) {
    const nazwa = (z as { nazwa?: unknown } | null)?.nazwa;
    if (typeof nazwa !== 'string' || !WZOR_NAZWY_ZRZUTU.test(nazwa) || nazwy.has(nazwa)) {
      throw new BladHosta('nazwa_niepoprawna', `niedozwolona nazwa zrzutu: ${JSON.stringify(String(nazwa).slice(0, 60))}`);
    }
    nazwy.add(nazwa);
    pliki.push([nazwa, dekodujPng(nazwa, (z as { pngBase64?: unknown }).pngBase64)]);
  }
  if (pliki.filter(([n]) => n !== PLIK_OBRAZU_PLANSZY && !WZOR_PLIKU_RYSUNKU.test(n)).length > LIMITY.zrzutowBezPlanszy) {
    throw new BladHosta('za_duzo_zrzutow', `zrzutów ${pliki.length} > ${LIMITY.zrzutowBezPlanszy}`);
  }
  // Plik i wpis w JSON muszą się zgadzać: tekst paczki linkuje obraz na podstawie tego wpisu.
  // Stara plansza deklaruje jeden `plansza.png`; nowa deklaruje `plansza-N.png` w `obraz.rysunki`.
  const zadeklarowane = new Set<string>();
  const planszaJson = 'plansza' in json && typeof json.plansza === 'object' && json.plansza !== null && !Array.isArray(json.plansza) ? json.plansza : null;
  const obraz = planszaJson !== null && 'obraz' in planszaJson && typeof planszaJson.obraz === 'object' && planszaJson.obraz !== null && !Array.isArray(planszaJson.obraz) ? planszaJson.obraz : null;
  const plikPlanszy = obraz !== null && 'plik' in obraz ? obraz.plik : null;
  if (plikPlanszy !== null && plikPlanszy !== PLIK_OBRAZU_PLANSZY) {
    throw new BladHosta('zrzut_niepoprawny', 'Obraz planszy nie zgadza się z opisem w uwagi.json.');
  }
  if (plikPlanszy === PLIK_OBRAZU_PLANSZY) zadeklarowane.add(PLIK_OBRAZU_PLANSZY);
  const deklaracje = obraz !== null && 'rysunki' in obraz && Array.isArray(obraz.rysunki) ? obraz.rysunki : [];
  for (const d of deklaracje) {
    if (typeof d !== 'object' || d === null || Array.isArray(d)) {
      throw new BladHosta('zrzut_niepoprawny', 'Obraz planszy nie zgadza się z opisem w uwagi.json.');
    }
    const numer = 'numer' in d ? d.numer : undefined;
    const plik = 'plik' in d ? d.plik : undefined;
    const numerZNazwy = typeof plik === 'string' ? Number(WZOR_PLIKU_RYSUNKU.exec(plik)?.[1]) : NaN;
    if (typeof plik !== 'string' || !WZOR_PLIKU_RYSUNKU.test(plik) || numer !== numerZNazwy || zadeklarowane.has(plik)) {
      throw new BladHosta('zrzut_niepoprawny', 'Obraz planszy nie zgadza się z opisem w uwagi.json.');
    }
    zadeklarowane.add(plik);
  }
  const plikiPlanszy = pliki.filter(([n]) => n === PLIK_OBRAZU_PLANSZY || WZOR_PLIKU_RYSUNKU.test(n)).map(([n]) => n);
  if (plikiPlanszy.length > MAKS_OBRAZOW_PLANSZY) {
    throw new BladHosta('za_duzo_zrzutow', `obrazów planszy ${plikiPlanszy.length} > ${MAKS_OBRAZOW_PLANSZY}`);
  }
  if (plikiPlanszy.length !== zadeklarowane.size || plikiPlanszy.some(n => !zadeklarowane.has(n))) {
    throw new BladHosta('zrzut_niepoprawny', 'Obraz planszy nie zgadza się z opisem w uwagi.json.');
  }
  const h = (json as { historyjka?: unknown }).historyjka;
  const nazwyH = pliki.filter(([n]) => n.startsWith('zrzut-')).map(([n]) => n);
  if (h !== undefined) {
    const surowa = h as { id?: unknown; zrzuty?: unknown };
    if (!surowa || !Array.isArray(surowa.zrzuty)) throw new BladHosta('json_niepoprawny', 'Niepoprawna historyjka.');
    const zrzuty = surowa.zrzuty.map((z: Record<string, unknown>) => ({ ...z, ...(z?.kontekstStrony as object) }));
    const historia = { id: surowa.id, zrzuty };
    if (!historyjkaPoprawna(historia) || problemHistoryjki(historia)) throw new BladHosta('json_niepoprawny', 'Niepoprawne adnotacje historyjki.');
    let numer = 0;
    for (const [i,z] of surowa.zrzuty.entries()) {
      for (const a of z.adnotacje) if (a.numer !== ++numer) throw new BladHosta('json_niepoprawny', 'Niepoprawna numeracja historyjki.');
      for (const n of [`zrzut-${i+1}.png`, `zrzut-${i+1}-oryginal.png`]) {
        const buf = pliki.find(([nazwa])=>nazwa===n)?.[1];
        if (!buf || buf.readUInt32BE(16) !== z.szerokosc || buf.readUInt32BE(20) !== z.wysokosc) throw new BladHosta('zrzut_niepoprawny', 'Brak pary PNG lub niezgodne wymiary.');
      }
      if (z.plik !== `zrzut-${i+1}.png` || z.oryginal !== `zrzut-${i+1}-oryginal.png`) throw new BladHosta('json_niepoprawny', 'Niepoprawne nazwy plików historyjki.');
    }
    if (nazwyH.length !== zrzuty.length * 2) throw new BladHosta('zrzut_niepoprawny', 'Nadmiarowe PNG historyjki.');
  } else if (nazwyH.length) throw new BladHosta('json_niepoprawny', 'PNG historyjki bez manifestu.');
  return { idPaczki, markdown: p.markdown, json: p.json, pliki };
}

/** Istniejący albo nowy katalog — zawsze prawdziwy katalog, nigdy symlink. */
async function katalogBezSymlinka(sciezka: string): Promise<void> {
  try {
    await fsp.mkdir(sciezka, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const st = await fsp.lstat(sciezka);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new BladHosta('sciezka_symlink', `${sciezka} nie jest zwykłym katalogiem`);
}

/** O_EXCL: niczego nie nadpisujemy; O_NOFOLLOW: ostatni komponent nie może być symlinkiem. */
async function zapiszNowyPlik(sciezka: string, dane: string | Buffer): Promise<void> {
  const fh = await fsp.open(sciezka, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(dane);
  } finally {
    await fh.close();
  }
}

async function czyZwyklyPlik(sciezka: string): Promise<boolean> {
  try {
    return (await fsp.lstat(sciezka)).isFile();
  } catch {
    return false;
  }
}

/** `.herestt/.gitignore` z `*` — `.gitignore` projektu zostaje nietknięty (BRIEF §13.1). */
export async function upewnijSieZeIgnorowane(katalogUwag: string): Promise<void> {
  const plik = join(katalogUwag, '.gitignore');
  try {
    await zapiszNowyPlik(plik, '# Tryb uwag: paczki dla agentów, nie do repo.\n*\n');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (!(await czyZwyklyPlik(plik))) throw new BladHosta('sciezka_symlink', '.herestt/.gitignore nie jest zwykłym plikiem');
    // Treści nie poprawiamy — skutek sprawdza `git check-ignore` po zapisie.
  }
}

/** Resztki po hoście ubitym w trakcie zapisu (red-team §14.5: `kill -9` zostawia `.tmp-*`). */
async function sprzatnijStareTmp(katalogUwag: string): Promise<void> {
  const teraz = Date.now();
  for (const nazwa of await fsp.readdir(katalogUwag)) {
    if (!nazwa.startsWith(PREFIKS_TMP)) continue;
    const sciezka = join(katalogUwag, nazwa);
    try {
      const st = await fsp.lstat(sciezka);
      if (st.isDirectory() && !st.isSymbolicLink() && teraz - st.mtimeMs > STARY_TMP_MS) await fsp.rm(sciezka, { recursive: true, force: true });
    } catch {
      // równoległy host mógł już posprzątać
    }
  }
}

/** Paczka istnieje tylko wtedy, gdy jest prawdziwy katalog z `uwagi.md` (red-team §14.7). */
async function stanCelu(docelowy: string): Promise<'brak' | 'kompletna'> {
  let st;
  try {
    st = await fsp.lstat(docelowy);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'brak';
    throw e;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new BladHosta('sciezka_symlink', 'katalog paczki nie jest zwykłym katalogiem');
  if (!(await czyZwyklyPlik(join(docelowy, PLIK_MD)))) throw new BladHosta('wewnetrzny', 'katalog paczki istnieje, ale bez uwagi.md');
  return 'kompletna';
}

function wynik(projekt: string, idPaczki: string, paczka: WynikZapisu['paczka'], ostrzezenia: string[], katalog = KATALOG_UWAG): WynikZapisu {
  const wzgledna = join(katalog, idPaczki, PLIK_MD);
  return { paczka, sciezkaMdWzgledna: wzgledna, sciezkaMdAbsolutna: join(projekt, wzgledna), ostrzezenia };
}

export type StanKatalogu = 'jest' | 'brak' | 'zly';

/** Zwykły katalog. Dowiązanie i plik to `zly` — nikt za nimi nie idzie. Brak wpisu to `brak`. */
export async function stanKatalogu(sciezka: string): Promise<StanKatalogu> {
  try {
    const st = await fsp.lstat(sciezka);
    return st.isSymbolicLink() || !st.isDirectory() ? 'zly' : 'jest';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'brak';
    throw e;
  }
}

export type PolozeniePaczki =
  | { rodzaj: 'jest'; katalog: string; wzgledny: string }
  | { rodzaj: 'brak' }
  | { rodzaj: 'zly' };

/**
 * Katalog paczki. `.herestt/<id>` wygrywa, gdy jest zwykłym katalogiem.
 * Brak tego wpisu kieruje do `.scratch/uwagi-ui/<id>`. Zły liść (dowiązanie albo plik) nie jest śledzony.
 */
export async function polozeniePaczki(projekt: string, idPaczki: string): Promise<PolozeniePaczki> {
  const nowyKorzen = join(projekt, KATALOG_UWAG);
  const stanNowego = await stanKatalogu(nowyKorzen);
  if (stanNowego === 'zly') return { rodzaj: 'zly' };
  if (stanNowego === 'jest') {
    const katalog = join(nowyKorzen, idPaczki);
    const stan = await stanKatalogu(katalog);
    if (stan === 'jest') return { rodzaj: 'jest', katalog, wzgledny: KATALOG_UWAG };
    if (stan === 'zly') return { rodzaj: 'zly' };
  }
  // Zły stary korzeń (plik albo dowiązanie) jest brakiem: nie śledzimy go i nie zamieniamy braku paczki w `niepoprawny`.
  const scratch = await stanKatalogu(join(projekt, '.scratch'));
  if (scratch !== 'jest') return { rodzaj: 'brak' };
  const staryKorzen = join(projekt, KATALOG_UWAG_STARY);
  const stanStarego = await stanKatalogu(staryKorzen);
  if (stanStarego !== 'jest') return { rodzaj: 'brak' };
  const katalog = join(staryKorzen, idPaczki);
  const stan = await stanKatalogu(katalog);
  if (stan !== 'jest') return stan === 'zly' ? { rodzaj: 'zly' } : { rodzaj: 'brak' };
  return { rodzaj: 'jest', katalog, wzgledny: KATALOG_UWAG_STARY };
}

/**
 * `projekt` musi być już zweryfikowany (`zweryfikujProjekt`). Idempotencja:
 * paczka o tym `idPaczki` już jest → `istniejaca`, bez zapisu.
 */
export async function zapiszPaczke(b: Binarki, projekt: string, paczka: PaczkaZweryfikowana): Promise<WynikZapisu> {
  const katalogUwag = join(projekt, KATALOG_UWAG);
  const docelowy = join(katalogUwag, paczka.idPaczki);
  const tmp = join(katalogUwag, `${PREFIKS_TMP}${paczka.idPaczki}-${randomBytes(4).toString('hex')}`);
  // Najdłuższa ścieżka, jaką utworzymy: tmp + najdłuższa dozwolona nazwa zrzutu.
  if (Buffer.byteLength(join(tmp, 'uwaga-0000-abcdefgh.png')) > LIMIT_SCIEZKI_BAJTY) throw new BladHosta('za_duzy', 'ścieżka projektu za długa');

  // „Ponów” paczki ze starego katalogu nie może założyć pustej kopii w `.herestt`: ta kopia zasłoniłaby status.json.
  const gdzie = await polozeniePaczki(projekt, paczka.idPaczki);
  if (gdzie.rodzaj === 'zly') throw new BladHosta('sciezka_symlink', 'katalog paczki nie jest zwykłym katalogiem');
  if (gdzie.rodzaj === 'jest' && (await stanCelu(gdzie.katalog)) === 'kompletna') {
    return wynik(projekt, paczka.idPaczki, 'istniejaca', await ostrzezeniaGit(b, projekt, paczka.idPaczki, gdzie.wzgledny), gdzie.wzgledny);
  }

  try {
    await katalogBezSymlinka(katalogUwag);
    await upewnijSieZeIgnorowane(katalogUwag);
    await sprzatnijStareTmp(katalogUwag);
    if ((await stanCelu(docelowy)) === 'kompletna') return wynik(projekt, paczka.idPaczki, 'istniejaca', await ostrzezeniaGit(b, projekt, paczka.idPaczki));

    await fsp.mkdir(tmp, { mode: 0o700 });
    try {
      for (const [nazwa, dane] of paczka.pliki) await zapiszNowyPlik(join(tmp, nazwa), dane);
      await zapiszNowyPlik(join(tmp, PLIK_JSON), paczka.json);
      await zapiszNowyPlik(join(tmp, PLIK_MD), paczka.markdown);
      await fsp.rename(tmp, docelowy);
    } catch (e) {
      await fsp.rm(tmp, { recursive: true, force: true });
      // Równoległy zapis tego samego id wygrał wyścig (red-team §14.6).
      const kod = (e as NodeJS.ErrnoException).code;
      if ((kod === 'ENOTEMPTY' || kod === 'EEXIST') && (await stanCelu(docelowy)) === 'kompletna') {
        return wynik(projekt, paczka.idPaczki, 'istniejaca', await ostrzezeniaGit(b, projekt, paczka.idPaczki));
      }
      throw e;
    }
  } catch (e) {
    throw zBleduSystemu(e, 'zapis paczki');
  }

  return wynik(projekt, paczka.idPaczki, 'zapisana', await ostrzezeniaGit(b, projekt, paczka.idPaczki));
}

/**
 * Zacommitowany `!*` albo reguła wyżej mogą odsłonić paczkę (red-team §14.1).
 * Sprawdzamy też przy `istniejaca` — inaczej retry po zgubionej odpowiedzi
 * gubi ostrzeżenie (recenzja Codexa nr 9).
 */
async function ostrzezeniaGit(b: Binarki, projekt: string, idPaczki: string, katalog = KATALOG_UWAG): Promise<string[]> {
  return (await gitCzyIgnorowane(b, projekt, join(katalog, idPaczki, PLIK_MD))) ? [] : ['nie_ignorowane'];
}

/** Dla `typ:'prompt'`: ścieżka do istniejącej paczki albo błąd. */
export async function sciezkaIstniejacejPaczki(projekt: string, idPaczki: string): Promise<WynikZapisu> {
  zweryfikujIdPaczki(idPaczki);
  try {
    const gdzie = await polozeniePaczki(projekt, idPaczki);
    if (gdzie.rodzaj === 'zly') throw new BladHosta('sciezka_symlink', 'katalog paczki nie jest zwykłym katalogiem');
    if (gdzie.rodzaj !== 'jest' || (await stanCelu(gdzie.katalog)) !== 'kompletna') throw new BladHosta('id_niepoprawne', 'nie ma paczki o tym idPaczki');
    return wynik(projekt, idPaczki, 'istniejaca', [], gdzie.wzgledny);
  } catch (e) {
    if (e instanceof BladHosta) throw e;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new BladHosta('id_niepoprawne', 'nie ma paczki o tym idPaczki');
    throw zBleduSystemu(e, 'odczyt paczki');
  }
}
