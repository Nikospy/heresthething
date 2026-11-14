/**
 * Prośba do agenta, którą człowiek wkleja agentowi: ta sama w panelu wtyczki i w instalatorze.
 * Leży w `src/wspolne`, bo instalator jest publiczny i nie może importować wtyczki (S-37).
 */
export const PROSBA_DO_AGENTA: { readonly pl: string; readonly en: string } = {
  pl: 'Czekaj na moje uwagi z wtyczki Here\'s the Thing. Powtarzaj w pętli: sprawdź notes_list, przeczytaj nowe przez notes_read, wykonaj je i ustaw status każdej przez notes_status. Gdy lista jest pusta, wywołaj notes_wait. Koniec czasu albo błąd notes_wait nie kończy pracy: wróć do notes_list.',
  en: 'Wait for my notes from the Here\'s the Thing extension. Repeat in a loop: check notes_list, read the new ones with notes_read, do them, and set the status of each one with notes_status. When the list is empty, call notes_wait. A timeout or error from notes_wait does not end the work: go back to notes_list.',
};
