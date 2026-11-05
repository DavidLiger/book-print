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

/** Action admise : `POST`, corps JSON, en-tête propre, `Origin` présent et admis (un navigateur l'envoie sur tout `POST`). */
export function actionAllowed(h: ActionHeaders, port: number): boolean {
  return (
    h.method === 'POST' &&
    /^application\/json\b/i.test(h.contentType ?? '') &&
    h.actionHeader === '1' &&
    h.origin !== undefined &&
    hostAllowed(h.host, h.origin, port)
  );
}
