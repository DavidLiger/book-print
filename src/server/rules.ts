// src/server/rules.ts — protection de la page locale, règles pures testées par scripts/test-server.ts.
// Même principe que le studio de GLBInterpreter : le contrôle vise les pages d'autres sites ouvertes dans le navigateur.

export const HOST = '127.0.0.1';
export const PORT = 4200;
/** En-tête exigé sur toute action : une autre origine devrait passer par un préflight, que le serveur refuse. */
export const ACTION_HEADER = 'x-book-print';

/** `Host` = `127.0.0.1:<port>` ou `localhost:<port>` (contre le rebinding DNS) ; `Origin`, si présent, = `http://` + l'un des deux. */
export function hostAllowed(host: string | undefined, origin: string | undefined, port: number): boolean {
  const hosts = [`${HOST}:${port}`, `localhost:${port}`];
  if (!host || !hosts.includes(host.toLowerCase())) return false;
  return origin === undefined || hosts.some((h) => origin.toLowerCase() === `http://${h}`);
}

export interface ActionHeaders {
  method?: string;
  contentType?: string;
  actionHeader?: string | string[];
  origin?: string;
  host?: string;
}

/** `POST`, en-tête propre, `Origin` présent et admis (un navigateur l'envoie sur tout `POST`). */
const ownPost = (h: ActionHeaders, port: number) => h.method === 'POST' && h.actionHeader === '1' && h.origin !== undefined && hostAllowed(h.host, h.origin, port);

/** Action admise : corps JSON. */
export const actionAllowed = (h: ActionHeaders, port: number): boolean => ownPost(h, port) && /^application\/json\b/i.test(h.contentType ?? '');

/** Dépôt d'une image : mêmes protections, corps binaire. La signature est contrôlée ensuite, sur le fichier lui-même. `jpeg` : la référence d'un style (IC2). */
export const uploadAllowed = (h: ActionHeaders, port: number, jpeg = false): boolean => ownPost(h, port) && (jpeg ? /^image\/(png|jpeg)$/i : /^image\/png$/i).test(h.contentType ?? '');

/** Attente d'un onglet déjà ouvert au démarrage, comme le studio (LC1) : il se reconnecte en une seconde environ. */
export const TAB_WAIT_MS = 3_000;
/**
 * Onglet du navigateur intégré de Claude Desktop (LC2) : son `User-Agent` porte `Claude/<version>` (relevé le 10/11/2026 :
 * `… Claude/4.23118.0 Chrome/152…`), ou `Electron/` pour une autre version. Il ne compte pas comme un onglet ouvert pour le lanceur ni
 * pour l'attente de `print.cmd`, et n'est pas mis en veille par un onglet du navigateur de David (ni l'inverse).
 */
export const navigateurIntegre = (userAgent: string | undefined): boolean => /\b(?:Claude|Electron)\/\d/.test(userAgent ?? '');
/** Page à ouvrir au démarrage : seulement si aucun onglet ne s'est connecté depuis le démarrage. */
export const pageAOuvrir = (ongletVuA: number, demarreA: number): boolean => ongletVuA < demarreA;
/** `npm run print -- --no-open` (LC1) : le lanceur unique ouvre lui-même les pages ; sans option, Print ouvre la sienne (print.cmd). */
export function printOptions(argv: string[]): { open: boolean } {
  for (const a of argv) if (a !== '--no-open') throw new Error(`option inconnue « ${a} » (option : --no-open)`);
  return { open: !argv.includes('--no-open') };
}
