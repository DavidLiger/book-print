// src/lanceur/pages.ts — pages du Studio et de Print, ouvertes par le lanceur unique (LC1, décision de David du 09/11/2026). Le Studio
// (`--no-open`) et Print (`--no-open`) n'ouvrent plus leur page eux-mêmes. Le lanceur compte leurs onglets connectés (ceux du
// navigateur intégré de Claude Desktop exclus par Print, LC2) ; s'il en manque et que le navigateur par défaut est fermé, il l'ouvre
// directement sur les pages qui manquent (LC2 : Brave rouvert sans adresse ne restaurait rien) ; s'il tourne, il attend que ses onglets se
// reconnectent, puis n'ouvre que les pages qui manquent. Parties pures (lecture du registre, pages manquantes) et appels au système.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { LABELS, LOOPBACK, STUDIO_PORT, type Outil } from './outils';
import { attendre } from './systeme';
import { PORT as PRINT_PORT } from '../server/rules';

export type OutilPage = Extract<Outil, 'studio' | 'print'>;
export const URLS: Record<OutilPage, string> = { studio: `http://${LOOPBACK}:${STUDIO_PORT}/`, print: `http://${LOOPBACK}:${PRINT_PORT}/` };
/** Attente des onglets qui se reconnectent, navigateur ouvert (ou inconnu). */
export const ATTENTE_RECONNEXION_MS = 4_000;
/** Attente des onglets ouverts avec le navigateur fermé (LC2), pour le journal et pour un second double-clic. */
export const ATTENTE_OUVERTURE_MS = 15_000;

/** Valeur d'une ligne `reg query` : ce qui suit `REG_SZ` ou `REG_EXPAND_SZ` (nom de valeur en toute langue, « (par défaut) » compris). */
export function valeurReg(sortie: string): string | null {
  for (const ligne of sortie.split(/\r?\n/)) {
    const m = /\sREG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(ligne);
    if (m) return m[1]!;
  }
  return null;
}

/** Programme d'une commande `shell\open\command` : entre guillemets, ou jusqu'au premier espace ; variables `%X%` développées. */
export function exeDe(commande: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const c = commande.trim();
  const brut = c.startsWith('"') ? c.slice(1, c.indexOf('"', 1) > 0 ? c.indexOf('"', 1) : undefined) : c.split(/\s+/)[0];
  if (!brut) return null;
  const exe = brut.replace(/%([^%]+)%/g, (all, nom: string) => env[nom] ?? env[nom.toUpperCase()] ?? all);
  return /\.exe$/i.test(exe) ? exe : null;
}

/** Pages à ouvrir : outils qui répondent (compte connu) sans aucun onglet connecté. */
export function pagesManquantes(onglets: Partial<Record<OutilPage, number | null>>): OutilPage[] {
  return (['studio', 'print'] as const).filter((o) => onglets[o] === 0);
}

const reg = (args: string[]) => spawnSync('reg', ['query', ...args], { encoding: 'utf8', windowsHide: true }).stdout ?? '';

/** Navigateur par défaut (lien http), lu dans le registre de l'utilisateur. Null s'il est illisible. */
export function navigateurParDefaut(): { exe: string; image: string } | null {
  const progId = valeurReg(reg(['HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice', '/v', 'ProgId']));
  if (!progId || !/^[\w.-]+$/.test(progId)) return null;
  const commande = valeurReg(reg([`HKCR\\${progId}\\shell\\open\\command`, '/ve']));
  const exe = commande && exeDe(commande);
  return exe ? { exe, image: path.win32.basename(exe) } : null;
}

/** Le navigateur tourne-t-il ? Par le nom de son programme (`tasklist`). */
export function navigateurLance(image: string): boolean {
  const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  return out.toLowerCase().includes(`"${image.toLowerCase()}"`);
}

/** Commande `start` du navigateur fermé, ouvert directement sur les pages (LC2) : adresses du lanceur seulement (`URLS`). */
export function commandeNavigateur(exe: string, urls: string[]): string {
  return `start "" "${exe}" ${urls.map((u) => `"${u}"`).join(' ')}`;
}

/**
 * Navigateur fermé, ouvert sur les pages qui manquent (LC2) : ses onglets ne sont pas attendus (Brave rouvert sans adresse affichait sa
 * page de démarrage, sans rien restaurer). Par `cmd /c start`, qui se termine aussitôt : le navigateur n'est pas dans l'arbre du lanceur,
 * « Tout arrêter » ne le ferme jamais.
 */
export function demarrerNavigateur(exe: string, urls: string[]): void {
  const p = spawn('cmd.exe', ['/d', '/s', '/c', commandeNavigateur(exe, urls)], { windowsVerbatimArguments: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => undefined);
}

/** Page ouverte dans le navigateur par défaut, comme le font le Studio et Print (`rundll32 url.dll`), hors de l'arbre du lanceur. */
export function ouvrirAdresse(url: string): void {
  const p = spawn('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true, windowsHide: true });
  p.on('error', () => undefined);
  p.unref();
}

function requeteJson(options: http.RequestOptions, body?: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.request({ timeout: 2_000, ...options }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? (JSON.parse(b) as Record<string, unknown>) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

/** Onglets connectés : Studio par `GET /__studio/ping` (sans effet), Print par `POST /api/onglets`. Null s'il ne répond pas. */
export async function compterOnglets(outil: OutilPage): Promise<number | null> {
  const host = `${LOOPBACK}:${outil === 'studio' ? STUDIO_PORT : PRINT_PORT}`;
  const r =
    outil === 'studio'
      ? await requeteJson({ host: LOOPBACK, port: STUDIO_PORT, path: '/__studio/ping', headers: { host } })
      : await requeteJson(
          { host: LOOPBACK, port: PRINT_PORT, path: '/api/onglets', method: 'POST', headers: { host, origin: `http://${host}`, 'content-type': 'application/json', 'x-book-print': '1', 'content-length': 2 } },
          '{}',
        );
  return typeof r?.onglets === 'number' ? r.onglets : null;
}

/** Pages du Studio et de Print : rien si leurs onglets sont là ; navigateur fermé : ouvert sur les pages manquantes ; sinon attente puis pages manquantes. */
export async function ouvrirPages(outils: OutilPage[], note: (m: string) => void): Promise<void> {
  const compter = async () => Object.fromEntries(await Promise.all(outils.map(async (o) => [o, await compterOnglets(o)] as const))) as Partial<Record<OutilPage, number | null>>;
  const avant = await compter();
  if (!pagesManquantes(avant).length) return note(`pages : onglets déjà connectés (${outils.map((o) => `${LABELS[o]} ${avant[o] ?? 'sans réponse'}`).join(', ')})`);
  const nav = navigateurParDefaut();
  if (!nav) note('pages : navigateur par défaut illisible dans le registre');
  else if (!navigateurLance(nav.image)) {
    const manquent = pagesManquantes(avant);
    note(`pages : navigateur fermé (${nav.image}) : ouvert sur ${manquent.map((o) => `${LABELS[o]} (${URLS[o]})`).join(', ')}`);
    demarrerNavigateur(nav.exe, manquent.map((o) => URLS[o]));
    // Le verrou de lancement reste tenu jusqu'ici : un second double-clic retrouve ces onglets au lieu d'en rouvrir.
    const connectes = await attendre(async () => pagesManquantes(await compter()).length === 0, ATTENTE_OUVERTURE_MS, 500);
    return note(`pages : ${connectes ? 'onglets connectés' : `onglets pas encore connectés après ${ATTENTE_OUVERTURE_MS / 1000} s`}`);
  }
  const attente = ATTENTE_RECONNEXION_MS;
  let apres = avant;
  await attendre(
    async () => {
      apres = await compter();
      return pagesManquantes(apres).length === 0;
    },
    attente,
    500,
  );
  const manquent = pagesManquantes(apres);
  for (const o of outils) if (!manquent.includes(o)) note(`pages : ${LABELS[o]} : onglet existant reconnecté (${apres[o] ?? 'sans réponse'})`);
  for (const o of manquent) {
    note(`pages : ${LABELS[o]} : aucun onglet, page ouverte (${URLS[o]})`);
    ouvrirAdresse(URLS[o]);
  }
}
