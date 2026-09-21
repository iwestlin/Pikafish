import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import process from 'node:process';

const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TEST_URL = process.env.PIKAFISH_TEST_URL ||
  'http://127.0.0.1:8787/browser-test.html?auto=1';
const PORT = 9333;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

class WebSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    socket.on('data', (chunk) => this.#onData(chunk));
  }

  static connect(url) {
    const target = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': 13
      }
    });

    return new Promise((resolve, reject) => {
      request.once('upgrade', (response, socket) => resolve(new WebSocket(socket)));
      request.once('error', reject);
      request.end();
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send({ id, method, params });
    return promise;
  }

  send(value) {
    const payload = Buffer.from(JSON.stringify(value));
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; ++index)
      masked[index] = payload[index] ^ mask[index % 4];

    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.#frame()) {}
  }

  #frame() {
    if (this.buffer.length < 2) return false;
    const opcode = this.buffer[0] & 0x0f;
    const masked = Boolean(this.buffer[1] & 0x80);
    let length = this.buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < offset + 2) return false;
      length = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffer.length < offset + 8) return false;
      length = Number(this.buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    if (masked) offset += 4;
    if (this.buffer.length < offset + length) return false;

    let payload = this.buffer.subarray(offset, offset + length);
    if (masked) {
      const mask = this.buffer.subarray(offset - 4, offset);
      const unmasked = Buffer.alloc(length);
      for (let index = 0; index < length; ++index)
        unmasked[index] = payload[index] ^ mask[index % 4];
      payload = unmasked;
    }
    this.buffer = this.buffer.subarray(offset + length);

    if (opcode === 8) {
      this.socket.destroy();
      return false;
    }
    if (opcode !== 1) return true;

    const message = JSON.parse(payload.toString('utf8'));
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    } else {
      this.events.push(message);
    }
    return true;
  }
}

async function waitForDebugger() {
  for (let attempt = 0; attempt < 100; ++attempt) {
    try {
      const targets = await json(`http://127.0.0.1:${PORT}/json/list`);
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error('Chrome debugger did not start');
}

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.PIKAFISH_CHROME_PROFILE || '/tmp/pikafish-cdp-profile'}`,
  'about:blank'
], { stdio: 'ignore' });

try {
  const debuggerUrl = await waitForDebugger();
  const websocket = await WebSocket.connect(debuggerUrl);
  await websocket.call('Page.enable');
  await websocket.call('Runtime.enable');
  await websocket.call('Log.enable');
  await websocket.call('Page.navigate', { url: TEST_URL });
  let status;
  let resultText;
  for (let attempt = 0; attempt < 1200; ++attempt) {
    const evaluation = await websocket.call('Runtime.evaluate', {
      expression: '(() => { const element = document.getElementById("result"); const log = document.getElementById("log"); return element ? {status: element.dataset.status, text: element.textContent, log: log?.textContent} : null; })()',
      returnByValue: true
    });
    if (evaluation.exceptionDetails) {
      console.error('Browser exception:', JSON.stringify(evaluation.exceptionDetails, null, 2));
      break;
    }
    if (evaluation.result.value?.status === 'pass' || evaluation.result.value?.status === 'fail') {
      status = evaluation.result.value.status;
      resultText = evaluation.result.value.text;
      break;
    }
    if (attempt % 50 === 49 && evaluation.result.value?.log) {
      console.log('browser log:', evaluation.result.value.log.split('\n').slice(-20).join('\n'));
    }
    await sleep(100);
  }
  if (!status) throw new Error('Browser test did not finish');
  for (const event of websocket.events) {
    if (event.method === 'Runtime.consoleAPICalled') {
      console.log(`browser ${event.params.type}:`, event.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    } else if (event.method === 'Runtime.exceptionThrown') {
      console.error('browser exception:', JSON.stringify(event.params, null, 2));
    } else if (event.method === 'Log.entryAdded') {
      console.error('browser log:', event.params.entry);
    }
  }
  for (const event of websocket.events) {
    if (event.method === 'Runtime.consoleAPICalled') {
      console.log(`browser ${event.params.type}:`, event.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    } else if (event.method === 'Runtime.exceptionThrown') {
      console.error('browser exception:', JSON.stringify(event.params, null, 2));
    }
  }
  assert.equal(status, 'pass', resultText);
  console.log(`PASS: ${resultText} (${TEST_URL})`);
} finally {
  chrome.kill();
}
