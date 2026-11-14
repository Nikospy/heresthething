/**
 * Build części lokalnej: host natywny, instalator (bin `heresthething`) i serwer MCP.
 *
 * Jedno źródło dla dwóch repozytoriów (S-37): repo prywatne woła `zbudujLokalne` ze
 * `scripts/build.mjs` (z klientem iPada), a publiczne repo pakietu npm uruchamia ten plik
 * wprost (`npm run build`, bez klienta iPada, bo ten jest częścią wtyczki).
 *
 * dist/host/host.mjs        host jako jeden plik .mjs, bez zależności runtime
 * dist/host/instalator.mjs  instalator CLI
 * dist/mcp/mcp.mjs          serwer MCP
 *
 * `hashHosta` liczy skrót tylko z wejść hosta, więc host z publicznego buildu i wtyczka
 * z prywatnego mają ten sam HASH_BUILDY, gdy źródła hosta są te same.
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Katalog wynikowy. Domyślnie `dist/` w repo.
 * `TRYB_UWAG_DIST` (ścieżka absolutna wewnątrz katalogu tymczasowego) jest
 * dla testów, które odpalają build równolegle: dwa procesy nie mogą robić
 * `rm` tego samego `dist/`. `npm run build` tej zmiennej nie ustawia.
 */
export function katalogWynikowy(root) {
  const nadpisanie = process.env.TRYB_UWAG_DIST;
  if (nadpisanie === undefined || nadpisanie === '') return join(root, 'dist');
  if (!isAbsolute(nadpisanie)) {
    throw new Error('TRYB_UWAG_DIST musi być ścieżką absolutną, żeby cwd nie zmieniało celu');
  }
  const pelny = resolve(nadpisanie);
  const bazy = [resolve(tmpdir())];
  try { bazy.push(realpathSync(tmpdir())); } catch { /* tmpdir bez realpath */ }
  const wSrodku = bazy.some(baza => {
    const rel = relative(baza, pelny);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!wSrodku) {
    throw new Error(`TRYB_UWAG_DIST musi leżeć w katalogu tymczasowym, jest ${pelny}`);
  }
  return pelny;
}

export async function wersjaPakietu(root) {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
}

/**
 * Hash wejść hosta (z metafile esbuild): ping go zwraca, a wtyczka porównuje ze swoim,
 * żeby wykryć hosta zainstalowanego ze starszego kodu (audyt W5). Liczony tylko z plików
 * hosta, więc zmiana samej wtyczki nie wymaga ponownej instalacji hosta. `absWorkingDir`
 * kotwiczy ścieżki z metafile przy korzeniu repo, więc hash nie zależy od cwd (przegląd Z12).
 */
export async function hashHosta(root) {
  const proba = await build({
    bundle: true,
    absWorkingDir: root,
    entryPoints: [join(root, 'src/host/host.ts')],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    write: false,
    metafile: true,
    define: { KLIENT_IPADA: '""', HASH_BUILDY: '""' },
  });
  const hash = createHash('sha256');
  for (const wejscie of Object.keys(proba.metafile.inputs).sort()) hash.update(wejscie).update(await readFile(join(root, wejscie)));
  return hash.digest('hex').slice(0, 12);
}

/**
 * Buduje host, instalator i serwer MCP do `dist`. `klientIpada` to gotowy skrypt klienta
 * tabletu, który host podaje przez Wi-Fi; pusty tekst = build bez tabletu (repo publiczne).
 */
export async function zbudujLokalne({ root, dist, hash, wersja, klientIpada = '' }) {
  const DEFINY = { HASH_BUILDY: JSON.stringify(hash), WERSJA_PAKIETU: JSON.stringify(wersja) };
  const wspolne = {
    bundle: true,
    target: 'node22',
    format: 'esm',
    platform: 'node',
    sourcemap: false,
    logLevel: 'warning',
    legalComments: 'none',
    absWorkingDir: root,
  };

  await build({
    ...wspolne,
    entryPoints: [join(root, 'src/host/host.ts')],
    outfile: join(dist, 'host', 'host.mjs'),
    define: { KLIENT_IPADA: JSON.stringify(klientIpada), ...DEFINY, WERSJA_HOSTA: JSON.stringify(wersja) },
  });

  // Instalator jest poza hashem hosta: podgląd, zapis, doctor i undo, bin heresthething.
  await build({
    ...wspolne,
    entryPoints: [join(root, 'src/host/instalator.ts')],
    outfile: join(dist, 'host', 'instalator.mjs'),
    banner: { js: '#!/usr/bin/env node' },
  });
  await chmod(join(dist, 'host', 'instalator.mjs'), 0o755);

  // Serwer MCP: osobny plik poza hashem hosta, jego zmiana nie wymaga przeładowania wtyczki.
  await build({
    ...wspolne,
    entryPoints: [join(root, 'src/mcp/wejscie.ts')],
    outfile: join(dist, 'mcp', 'mcp.mjs'),
    define: { ...DEFINY },
  });
}

// Uruchomiony wprost (repo publiczne): sam host, instalator i MCP, bez klienta iPada.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dist = katalogWynikowy(root);
  await rm(dist, { recursive: true, force: true });
  const hash = await hashHosta(root);
  await zbudujLokalne({ root, dist, hash, wersja: await wersjaPakietu(root) });
  console.log(`[build] gotowe → dist/ (host, instalator, MCP; hash ${hash})`);
}
