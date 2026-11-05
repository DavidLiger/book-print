// src/server/main.ts — point d'entrée (`npm run print`, print.cmd). Écoute sur 127.0.0.1 seulement.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPrintServer } from './app';
import { loadConfig } from './config';
import { HOST, PORT } from './rules';

const CONFIG_PATH = fileURLToPath(new URL('../../config.local.json', import.meta.url));

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const fallback = () => console.log(`book-print : ouvrir ${url} dans le navigateur`);
  try {
    const p = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
    p.on('error', fallback);
    p.unref();
  } catch {
    fallback();
  }
}

const server = createPrintServer(CONFIG_PATH);
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`book-print : le port ${PORT} est déjà occupé. Fermer l'autre fenêtre de book-print ou le programme qui l'utilise, puis relancer.`);
  else console.error('book-print :', e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`book-print : ${url} (Ctrl+C pour arrêter)`);
  const state = loadConfig(CONFIG_PATH);
  if (!state.ok) console.error(`book-print : configuration à corriger. ${state.message}`);
  openBrowser(url);
});
