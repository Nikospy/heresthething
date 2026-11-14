// Test dymny instalacji: uruchamia launcher tak, jak zrobi to Chrome z Docka
// (env tylko z launchd: PATH=/usr/bin:/bin:/usr/sbin:/sbin, bez HERDR_*),
// wysyła `ping` jedną ramką i sprawdza odpowiedź.
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';

const [launcher, id] = process.argv.slice(2);
const zadanie = Buffer.from(JSON.stringify({ wersja: 2, idZadania: 'instalacja', typ: 'ping' }));
const naglowek = Buffer.alloc(4);
naglowek.writeUInt32LE(zadanie.length, 0);

const p = spawn(launcher, [`chrome-extension://${id}/`], {
  env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: userInfo().homedir, USER: userInfo().username },
});
const wyjscie = [];
p.stdout.on('data', d => wyjscie.push(d));
p.stderr.on('data', d => process.stderr.write(d));
p.stdin.end(Buffer.concat([naglowek, zadanie]));
const kod = await new Promise(r => p.once('exit', r));
const bufor = Buffer.concat(wyjscie);
let odpowiedz = null;
try {
  odpowiedz = JSON.parse(bufor.subarray(4, 4 + bufor.readUInt32LE(0)).toString('utf8'));
} catch {
  // niżej
}
if (kod !== 0 || odpowiedz?.ok !== true || odpowiedz.typ !== 'ping') {
  console.error(`test dymny: kod=${kod}, odpowiedź=${JSON.stringify(odpowiedz)}`);
  process.exit(1);
}
console.log(`test dymny: ping OK (host ${odpowiedz.wersjaHosta}, protokół ${odpowiedz.wersja}, PATH launchd)`);
