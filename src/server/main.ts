// src/server/main.ts — point d'entrée (`npm run print`, print.cmd). Écoute sur 127.0.0.1 seulement.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lancerArret } from '../lanceur/systeme';
import { createPrintServer } from './app';
import { loadConfig } from './config';
import { HOST, PORT, pageAOuvrir, printOptions, TAB_WAIT_MS } from './rules';

const CONFIG_PATH = fileURLToPath(new URL('../../config.local.json', import.meta.url));
const LANCEUR_VBS = fileURLToPath(new URL('../../lanceur/lanceur.vbs', import.meta.url));
/** Délai avant la sortie de Print, après « Tout arrêter et quitter » : la réponse est partie, l'arrêt est lancé. */
const QUIT_DELAY_MS = 1_000;

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

// « Tout arrêter et quitter » (LC1) : arrêt de ce que le lanceur unique a démarré (comme l'icône « Livres – Tout arrêter »), puis
// Print se ferme, même lancé par print.cmd.
const OPTIONS = printOptions(process.argv.slice(2));
let ongletVuA = 0;
const server = createPrintServer(CONFIG_PATH, undefined, {
  onglet: () => {
    ongletVuA = Date.now();
  },
  quitter: () => {
    const lance = lancerArret(LANCEUR_VBS);
    console.log(`book-print : « Tout arrêter et quitter »${lance ? '' : ' (arrêt du lanceur indisponible hors de Windows)'} ; Print se ferme`);
    server.close();
    setTimeout(() => process.exit(0), QUIT_DELAY_MS);
  },
});
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`book-print : le port ${PORT} est déjà occupé. Fermer l'autre fenêtre de book-print ou le programme qui l'utilise, puis relancer.`);
  else console.error('book-print :', e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  const demarreA = Date.now();
  console.log(`book-print : ${url} (Ctrl+C pour arrêter)`);
  const state = loadConfig(CONFIG_PATH);
  if (!state.ok) console.error(`book-print : configuration à corriger. ${state.message}`);
  // Un onglet resté ouvert se reconnecte seul (flux d'événements, LC1) : page ouverte seulement sinon, comme le studio.
  // Lancé par le lanceur unique (--no-open) : c'est lui qui ouvre les pages.
  if (!OPTIONS.open) return;
  setTimeout(() => {
    if (pageAOuvrir(ongletVuA, demarreA)) openBrowser(url);
    else console.log('book-print : un onglet déjà ouvert s\'est reconnecté (pas de nouvel onglet)');
  }, TAB_WAIT_MS);
});
