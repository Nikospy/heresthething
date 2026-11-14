/**
 * Kształt uwagi wspólny dla wtyczki i hosta: typy i limity długości.
 * Host waliduje nimi paczki z Wi-Fi, a wtyczka model sesji (`src/ext/model/uwagi.ts` re-eksportuje).
 * Leży w `src/wspolne`, bo program lokalny jest publiczny i nie może importować wtyczki (S-37).
 */

export const TYPY_UWAG = ['odstęp', 'typografia', 'kolor', 'zachowanie', 'treść'] as const;

export type TypUwagi = (typeof TYPY_UWAG)[number];

/**
 * Limity długości. Tekst strony ucinamy, bo jest tylko tropem, a każdy znak
 * z niej to potencjalna treść podsunięta agentowi. Tekst właściciela ma limit
 * tylko po to, żeby przypadkowe wklejenie nie zrobiło z paczki megabajtów.
 */
export const LIMITY_TEKSTU = {
  tekstWlasciciela: 4000,
  tekstElementu: 80,
  /** Tekst ludzkiej nazwy i cała nazwa z rolą (FR-024). */
  tekstNazwy: 40,
  nazwaElementu: 64,
  selektor: 300,
  klasa: 60,
  url: 500,
} as const;

export function jestTypemUwagi(wartosc: unknown): wartosc is TypUwagi {
  return typeof wartosc === 'string' && (TYPY_UWAG as readonly string[]).includes(wartosc);
}
