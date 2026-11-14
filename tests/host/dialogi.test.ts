import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIALOGI, ocenEkran, wykryjDialog } from '../../src/host/dialogi';

/** Prawdziwe ekrany nagrane `herdr agent read --source detection` (źródła: tests/host/fixtures/ekrany/README.md). */
const ekran = (plik: string) => readFileSync(join(import.meta.dirname, 'fixtures/ekrany', plik), 'utf8');

describe('wykryjDialog na nagranych ekranach', () => {
  it.each([
    ['claude-akceptacja-planu-auto.txt', 'claude_akceptacja_planu'],
    ['claude-akceptacja-planu.txt', 'claude_wyjscie_z_planu'],
    ['claude-zaufanie-folderu.txt', 'claude_zaufanie_folderu'],
    ['codex-zaufanie-folderu.txt', 'codex_zaufanie_folderu'],
    ['codex-limit-tygodniowy.txt', 'codex_limit'],
  ])('%s → %s', (plik, nazwa) => {
    expect(wykryjDialog(ekran(plik))).toBe(nazwa);
  });

  it.each(['claude-bez-dialogu.txt', 'codex-bez-dialogu.txt'])('zwykły ekran %s → brak dialogu (prompt może przejść)', plik => {
    expect(wykryjDialog(ekran(plik))).toBeNull();
  });

  it('łapie nagłówek zawinięty przez terminal w środku zdania', () => {
    // Dokładnie tak zawinął go panel 65 kolumn na nagraniu.
    expect(wykryjDialog(' Claude has written up a plan and is ready to execute. Would you\n like to proceed?\n')).toBe('claude_akceptacja_planu');
  });

  it('każdy wzorzec ma wskazane źródło w nagraniu', () => {
    for (const d of DIALOGI) expect(d.zrodlo).toMatch(/\.txt — .*2026-\d\d-\d\d/);
  });
});

describe('ocenEkran: biała lista zwykłego pola wejścia (recenzja Codexa nr 1)', () => {
  it.each([
    ['claude', 'claude-bez-dialogu.txt'],
    ['claude', 'claude-bez-dialogu-2.txt'],
    ['claude', 'claude-bez-dialogu-auto-podpowiedz.txt'],
    ['claude', 'claude-pracuje.txt'],
    ['claude', 'claude-ramka-z-tytulem.txt'],
    ['codex', 'codex-bez-dialogu.txt'],
    ['codex', 'codex-pracuje.txt'],
  ])('%s, %s → gotowy', (rodzaj, plik) => {
    expect(ocenEkran(rodzaj, ekran(plik))).toEqual({ gotowy: true });
  });

  it.each([
    ['claude', 'claude-akceptacja-planu-auto.txt'],
    ['claude', 'claude-akceptacja-planu.txt'],
    ['claude', 'claude-zaufanie-folderu.txt'],
    ['codex', 'codex-zaufanie-folderu.txt'],
    ['codex', 'codex-limit-tygodniowy.txt'],
  ])('%s, %s → dialog_wykryty', (rodzaj, plik) => {
    expect(ocenEkran(rodzaj, ekran(plik))).toEqual({ gotowy: false, powod: 'dialog_wykryty' });
  });

  it('nieznany dialog Claude (nagrany plan bez znanego nagłówka) → ekran_nierozpoznany, nie przepuszczamy', () => {
    // Ten sam prawdziwy ekran co akceptacja planu, ale z wyciętym nagłówkiem — symulacja dialogu, którego nie znamy.
    const bezNaglowka = ekran('claude-akceptacja-planu-auto.txt').replace(/Would you\s+like to proceed\?/, 'Apply these changes?');
    expect(wykryjDialog(bezNaglowka)).toBeNull();
    expect(ocenEkran('claude', bezNaglowka)).toEqual({ gotowy: false, powod: 'ekran_nierozpoznany' });
  });

  it('nieznany dialog Codexa z listą opcji → ekran_nierozpoznany', () => {
    const bezNaglowka = ekran('codex-limit-tygodniowy.txt').replace('Approaching rate limits', 'Something new');
    expect(ocenEkran('codex', bezNaglowka)).toEqual({ gotowy: false, powod: 'ekran_nierozpoznany' });
  });

  it('ekran Codexa oceniany jako Claude (i odwrotnie) → nierozpoznany', () => {
    expect(ocenEkran('claude', ekran('codex-bez-dialogu.txt'))).toEqual({ gotowy: false, powod: 'ekran_nierozpoznany' });
    expect(ocenEkran('codex', ekran('claude-bez-dialogu.txt'))).toEqual({ gotowy: false, powod: 'ekran_nierozpoznany' });
  });

  it('inny rodzaj agenta (np. gemini) → nierozpoznany, bo nie znamy jego pola wejścia', () => {
    expect(ocenEkran('gemini', ekran('claude-bez-dialogu.txt'))).toEqual({ gotowy: false, powod: 'ekran_nierozpoznany' });
  });

  it('tytuł sesji w górnej ramce nie otwiera drogi dialogowi bez dolnej ramki', () => {
    const bezDolnejRamki = ekran('claude-ramka-z-tytulem.txt').replace(/\n─{20,}\n/, '\n  ❯ 1. Yes\n');
    expect(ocenEkran('claude', bezDolnejRamki)).toEqual({ gotowy: false, powod: 'ekran_nierozpoznany' });
  });

  it('pusty ekran → nierozpoznany', () => {
    expect(ocenEkran('claude', '')).toEqual({ gotowy: false, powod: 'ekran_nierozpoznany' });
  });
});

describe('Codex 0.162.0: stopka wąskiego pane (finał mewitz)', () => {
  it('akceptuje przekazany zwykły ekran bez stopki skrótów', () => {
    expect(ocenEkran('codex', ekran('codex-bez-dialogu-waski.txt'))).toEqual({ gotowy: true });
  });
  it.each([
    '  GPT-6.1-Sol medium · ~/dev/active/…',
    '  ⚠ 3 warnings · f2 to view',
  ])('pole wejścia i stopka %s wystarczają', stopka => {
    expect(ocenEkran('codex', `› Ask Codex to do anything\n\n${stopka}`)).toEqual({ gotowy: true });
    expect(ocenEkran('codex', `› 1. Continue\n\n${stopka}`)).toEqual({ gotowy: false, powod: 'ekran_nierozpoznany' });
    expect(ocenEkran('codex', stopka)).toEqual({ gotowy: false, powod: 'ekran_nierozpoznany' });
  });
  it.each(['codex-zaufanie-folderu.txt', 'codex-limit-tygodniowy.txt'])('%s pozostaje zablokowany również ze zwykłym polem i nową stopką', plik => {
    expect(ocenEkran('codex', `${ekran(plik)}\n${ekran('codex-bez-dialogu-waski.txt')}`)).toEqual({ gotowy: false, powod: 'dialog_wykryty' });
  });
  it('nieznany dialog pod wcześniejszym polem wejścia i nową stopką pozostaje zablokowany', () => {
    expect(ocenEkran('codex', '› Ask Codex to do anything\nNew question?\n› 1. Continue\n  GPT-6.1-Sol medium · ~/repo\n  ⚠ 3 warnings · f2 to view')).toEqual({ gotowy: false, powod: 'ekran_nierozpoznany' });
  });
});
