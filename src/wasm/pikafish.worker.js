import createPikafishModule from './build/pikafish.js';

let module;
const notify = (message) => self.postMessage(message);

async function initialize({ threads, hashMB }) {
  if (module) return;
  module = await createPikafishModule({
    locateFile: (file) => new URL(`./build/${file}`, import.meta.url).href,
    print: (line) => notify({ type: 'output', line }),
    printErr: (line) => notify({ type: 'error', line })
  });

  module._pikafish_init(threads, hashMB);
  notify({ type: 'ready' });
}

function execute(command) {
  if (!module) throw new Error('Pikafish is not initialized');
  module.ccall('pikafish_command', null, ['string'], [command]);
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === 'init') await initialize(message.options);
    else if (message.type === 'command') execute(message.command);
    else if (message.type === 'stop') module?._pikafish_stop();
  } catch (error) {
    notify({ type: 'fatal', error: error.message });
  }
};
