/**
 * Kształt i walidacja historyjki: wspólne dla wtyczki i hosta, który sprawdza historyjkę przed zapisem paczki.
 * Leży w `src/wspolne`, bo program lokalny jest publiczny i nie może importować wtyczki (S-37).
 * Teksty błędów zostają we wtyczce: tu jest tylko rodzaj problemu (`problemHistoryjki`).
 */
import { jestAdresemPracy } from './adres-strony';
import { LIMIT_ZRZUTOW_HISTORYJKI, MAKS_SZEROKOSC_ZRZUTU_HISTORYJKI } from './protokol';

export const NARZEDZIA = ['strzalka', 'elipsa', 'prostokat', 'pisak', 'tekst'] as const;
export type Narzedzie = typeof NARZEDZIA[number];
export type Punkt = { x: number; y: number; nacisk?: number };
export type Adnotacja = { id: string; narzedzie: Narzedzie; punkty: Punkt[]; kolor: string; etykieta: string; komentarz: string };
export type ZrzutHistoryjki = { id: string; url: string; czas: string; szerokosc: number; wysokosc: number; adnotacje: Adnotacja[] };
export type Historyjka = { id: string; zrzuty: ZrzutHistoryjki[]; cofniete?: ZrzutHistoryjki[][]; ponowione?: ZrzutHistoryjki[][] };
const obiekt = (w: unknown): w is Record<string, unknown> => !!w && typeof w === 'object' && !Array.isArray(w);
const tekst = (w: unknown, max: number) => typeof w === 'string' && w.length <= max;
const id = (w: unknown) => typeof w === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(w);
const jednostka = (w: unknown) => typeof w === 'number' && Number.isFinite(w) && w >= 0 && w <= 1;
export function zrzutyPoprawne(w: unknown): w is ZrzutHistoryjki[] {
  if (!Array.isArray(w) || w.length > LIMIT_ZRZUTOW_HISTORYJKI) return false;
  const ids = new Set<string>(); let punkty = 0; let liczba = 0;
  for (const z of w) {
    if (!obiekt(z) || !id(z.id) || ids.has(z.id as string) || !tekst(z.url, 2048) || !jestAdresemPracy(z.url as string) || !tekst(z.czas, 80) ||
      !Number.isInteger(z.szerokosc) || (z.szerokosc as number) < 1 || (z.szerokosc as number) > MAKS_SZEROKOSC_ZRZUTU_HISTORYJKI ||
      !Number.isInteger(z.wysokosc) || (z.wysokosc as number) < 1 || (z.wysokosc as number) > 16384 || !Array.isArray(z.adnotacje)) return false;
    ids.add(z.id as string);
    for (const a of z.adnotacje) {
      if (!obiekt(a) || !id(a.id) || ids.has(a.id as string) || !NARZEDZIA.includes(a.narzedzie as Narzedzie) ||
        !Array.isArray(a.punkty) || a.punkty.length < 1 || (a.narzedzie !== 'pisak' && a.punkty.length !== (a.narzedzie === 'tekst' ? 1 : 2)) ||
        !a.punkty.every(p => obiekt(p) && jednostka(p.x) && jednostka(p.y) && (p.nacisk === undefined || jednostka(p.nacisk))) ||
        typeof a.kolor !== 'string' || !/^#[0-9a-f]{6}$/i.test(a.kolor) || !tekst(a.etykieta, 200) || !tekst(a.komentarz, 2000)) return false;
      ids.add(a.id as string); punkty += a.punkty.length; liczba++;
    }
  }
  return punkty <= 5000 && liczba <= 64;
}
export function historyjkaPoprawna(w: unknown): w is Historyjka {
  return obiekt(w) && id(w.id) && zrzutyPoprawne(w.zrzuty) && ['cofniete', 'ponowione'].every(k => w[k] === undefined ||
    (Array.isArray(w[k]) && w[k].length <= 50 && w[k].every(zrzutyPoprawne)));
}
export function ponumeruj(h?: Historyjka) {
  let numer = 0;
  return (h?.zrzuty ?? []).map(z => ({ ...z, adnotacje: z.adnotacje.map(a => ({ ...a, numer: ++numer })) }));
}

/** Pierwszy powód, dla którego historyjki nie da się wysłać; `numer` to numer zrzutu albo adnotacji. */
export type ProblemHistoryjki =
  | { rodzaj: 'brakZrzutow' }
  | { rodzaj: 'zrzutBezAdnotacji'; numer: number }
  | { rodzaj: 'adnotacjaBezKomentarza'; numer: number }
  | { rodzaj: 'adnotacjaUsunieteOdwolanie'; numer: number };

export function problemHistoryjki(h?: Historyjka): ProblemHistoryjki | null {
  if (!h) return null;
  if (!h.zrzuty.length) return { rodzaj: 'brakZrzutow' };
  const lista = ponumeruj(h).flatMap(z => z.adnotacje);
  for (const [i, z] of h.zrzuty.entries()) if (!z.adnotacje.length) return { rodzaj: 'zrzutBezAdnotacji', numer: i + 1 };
  for (const a of lista) {
    if (!a.komentarz.trim()) return { rodzaj: 'adnotacjaBezKomentarza', numer: a.numer };
    if ([...a.komentarz.matchAll(/\[\[([^\]]+)\]\]/g)].some(m => !/^\d+$/.test(m[1] ?? '') && !lista.some(b => b.id === m[1]))) return { rodzaj: 'adnotacjaUsunieteOdwolanie', numer: a.numer };
  }
  return null;
}
