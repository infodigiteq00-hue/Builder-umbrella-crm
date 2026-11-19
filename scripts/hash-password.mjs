// Prints a password hash for SUPER_ADMIN_PASSWORD_HASH (the same PBKDF2 the CRM uses to check sign-ins).
//   node scripts/hash-password.mjs            (asks for the password; nothing is shown or stored)
//   PW='…' node scripts/hash-password.mjs     (non-interactive)
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import readline from 'node:readline';

const ITER = 100000;
async function ask() {
  if (process.env.PW) return process.env.PW;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  rl._writeToOutput = () => {}; // do not echo what is typed
  process.stderr.write('Password: ');
  return new Promise((res) => rl.question('', (a) => { process.stderr.write('\n'); rl.close(); res(a); }));
}
const pw = await ask();
if (!pw || pw.length < 8) { console.error('Use at least 8 characters.'); process.exit(1); }
const salt = randomBytes(16);
console.log(`pbkdf2-sha256$${ITER}$${salt.toString('hex')}$${pbkdf2Sync(pw, salt, ITER, 32, 'sha256').toString('hex')}`);
