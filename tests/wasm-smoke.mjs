import assert from 'node:assert/strict';
import process from 'node:process';
import createPikafishModule from '../src/wasm/build/pikafish.js';

const lines = [];
let errors = '';
const waitFor = async (predicate, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${errors || 'engine output'}`)), timeoutMs);
    const poll = () => {
      const found = lines.find(predicate);
      if (found) {
        clearTimeout(timer);
        resolve(found);
      } else {
        setTimeout(poll, 25);
      }
    };
    poll();
  });

const command = (text) =>
  module.ccall('pikafish_command', null, ['string'], [text]);

const module = await createPikafishModule({
  print: (line) => lines.push(line),
  printErr: (line) => { errors += `${line}\n`; }
});

if (module.pthreadPoolReady) await module.pthreadPoolReady;

module._pikafish_init(1, 16);
command('uci');
await waitFor((line) => line.includes('uciok'));
command('isready');
await waitFor((line) => line === 'readyok');
command('position startpos');
command('go depth 5');
const bestMove = await waitFor((line) => line.startsWith('bestmove '));

assert.match(bestMove, /^bestmove [a-i][0-9][a-i][0-9]/);
assert.ok(lines.some((line) => line.includes('id name Pikafish')), 'engine identification missing');
console.log(`PASS: ${bestMove}`);
process.exit(0);
