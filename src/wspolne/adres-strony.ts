/**
 * Adresy, na których człowiek pracuje na żywo: zwykła strona albo strona demonstracyjna wtyczki (FR-008).
 * Tylko ten jeden plik demo: inne strony wtyczki (okienko, edytor, przewodnik) nie przechodzą. Model nie zna
 * własnego ID wtyczki, więc sprawdza kształt, a który dokładnie adres wolno otworzyć, rozstrzyga tło.
 */
const ORIGIN_WTYCZKI = /^chrome-extension:\/\/[a-p]{32}$/;
const ADRES_DEMO = /^chrome-extension:\/\/[a-p]{32}\/demo\.html(?:[?#]|$)/;
const ZWYKLA_STRONA = /^https?:\/\//;

export const jestOriginemWtyczki = (origin: string): boolean => ORIGIN_WTYCZKI.test(origin);
export const jestZwyklaStrona = (adres: string): boolean => ZWYKLA_STRONA.test(adres);
export const jestAdresemPracy = (adres: string): boolean => ZWYKLA_STRONA.test(adres) || ADRES_DEMO.test(adres);
