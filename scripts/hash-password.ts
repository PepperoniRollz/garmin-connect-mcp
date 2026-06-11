/**
 * Generates the bcrypt hash for SERVER_OWNER_PASSWORD_HASH.
 *
 *   npm run hash-password
 *
 * Prompts twice with hidden input (or reads one line from a pipe) and prints
 * the hash to stdout. The plaintext password is never stored anywhere.
 */
import {createInterface, Interface} from 'node:readline';
import {Writable} from 'node:stream';

import bcrypt from 'bcryptjs';

const BCRYPT_COST = 12;
const ENV_VAR_NAME = 'SERVER_OWNER_PASSWORD_HASH';

function hiddenQuestion(prompt: string): Promise<string> {
  let muted = false;
  const mutedStdout = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl: Interface = createInterface({input: process.stdin, output: mutedStdout, terminal: true});
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function readPipedLine(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data.split('\n')[0]?.trim() ?? '';
}

async function main(): Promise<void> {
  let password: string;
  if (process.stdin.isTTY) {
    password = await hiddenQuestion('Owner password: ');
    const confirmation = await hiddenQuestion('Confirm password: ');
    if (password !== confirmation) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
  } else {
    password = await readPipedLine();
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, BCRYPT_COST);
  console.log(`\n${ENV_VAR_NAME}='${hash}'`);
  console.log('\nAdd the line above to your server environment (quote it — bcrypt hashes contain "$").');
}

await main();
