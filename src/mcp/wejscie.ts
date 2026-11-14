import { createInterface } from 'node:readline';
import { SerwerMcp } from './serwer';
import { Skrzynka } from './skrzynka';
import { znajdzProjekt } from './projekt';

export { znajdzProjekt };

const skrzynka = new Skrzynka(znajdzProjekt(process.cwd()));
await skrzynka.zapamietajIstniejace().catch(blad => console.error(`[tryb-uwag] ${String(blad)}`));

// stdout należy do protokołu; diagnostyka idzie wyłącznie na stderr.
const serwer = new SerwerMcp(skrzynka, odpowiedz => process.stdout.write(JSON.stringify(odpowiedz) + '\n'), '0.1.0');

const wejscie = createInterface({ input: process.stdin, crlfDelay: Infinity });
wejscie.on('line', linia => {
  if (linia.trim() === '') return;
  serwer.obsluz(linia).catch(blad => console.error(`[tryb-uwag] ${String(blad)}`));
});
wejscie.on('close', () => process.exit(0));
