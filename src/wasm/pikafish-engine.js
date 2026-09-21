export class PikafishEngine {
  #worker;
  #listeners = new Set();
  #startPromise;
  #resolveReady;
  #rejectReady;

  constructor() {
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.workerUrl = new URL('./pikafish.worker.js', import.meta.url);
    this.#worker = new Worker(this.workerUrl, { type: 'module' });
    this.#worker.onmessage = (event) => this.#handleMessage(event.data);
    this.#worker.onerror = (event) => {
      this.#emit({ type: 'fatal', error: event.message || 'Pikafish worker failed to load' });
    };
  }

  start({ threads = 1, hashMB = 16 } = {}) {
    if (this.#startPromise) return this.#startPromise;
    if (threads !== 1) throw new RangeError('The browser Wasm build supports one search thread');
    if (hashMB < 1 || hashMB > 256) throw new RangeError('hashMB must be between 1 and 256');

    this.#startPromise = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
      this.#worker.postMessage({ type: 'init', options: { threads, hashMB } });
    });
    return this.#startPromise;
  }

  send(command) {
    this.#worker.postMessage({ type: 'command', command });
  }

  stop() {
    this.#worker.postMessage({ type: 'stop' });
  }

  onOutput(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async waitFor(predicate, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for engine output`));
      }, timeoutMs);
      const unsubscribe = this.onOutput((message) => {
        if (predicate(message)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(message);
        }
      });
    });
  }

  terminate() {
    this.#worker.terminate();
  }

  #handleMessage(message) {
    if (message.type === 'ready') this.#resolveReady(this);
    if (message.type === 'fatal' && this.#rejectReady) this.#rejectReady(new Error(message.error));
    this.#emit(message);
  }

  #emit(message) {
    for (const listener of this.#listeners) listener(message);
  }
}
