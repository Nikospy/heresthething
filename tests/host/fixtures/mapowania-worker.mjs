import { promises as fs } from 'node:fs';
const [modul, katalog, rola, origin] = process.argv.slice(2);
const zgoda = new Promise(r => process.on('message', m => { if (m === 'zwolnij') r(); }));
const czytaj = fs.readFile;
fs.readFile = async (...args) => {
  const wynik = await czytaj(...args);
  if (String(args[0]).endsWith('/mapowania.json')) {
    process.send('odczytano');
    if (rola === 'pierwszy') await zgoda;
  }
  return wynik;
};
const mkdir = fs.mkdir;
let zgloszono = false;
fs.mkdir = async (...args) => {
  try { return await mkdir(...args); }
  catch (e) {
    if (String(args[0]).endsWith('/mapowania.json.lock') && e.code === 'EEXIST' && !zgloszono) {
      zgloszono = true; process.send('blokada');
    }
    throw e;
  }
};
try {
  const { zapiszMapowanie } = await import(modul);
  await zapiszMapowanie(katalog, origin, `/repo/${rola}`);
  process.disconnect();
} catch (e) { process.send({ blad: String(e) }); process.exitCode = 1; process.disconnect(); }
