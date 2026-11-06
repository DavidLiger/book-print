// src/research/url-check.ts — contrôle des URL des sources (spec §5.2, architecture §5). Le serveur est le seul à sortir, et seulement sur
// action de David. `http` et `https` seulement ; adresses privées et locales refusées à chaque saut, redirections comprises ; 5 redirections
// au plus ; 10 s par URL ; 4 requêtes à la fois ; le corps n'est jamais lu ni conservé.
//
// Limite connue : `fetch` ne permet pas de figer l'adresse résolue. Un DNS qui change entre la vérification et la requête n'est pas vu ;
// cet outil tourne en local, sur des URL que David relit, ce risque est accepté.
import dns from 'node:dns/promises';
import net from 'node:net';
import type { UrlCheck } from '../schema/claim';

export const URL_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;
export const URL_CONCURRENCY = 4;

export interface UrlDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Adresses d'un nom d'hôte. */
  lookup: (host: string) => Promise<string[]>;
  now: () => Date;
  timeoutMs: number;
}

export const defaultUrlDeps = (): UrlDeps => ({
  fetch: (url, init) => fetch(url, init),
  lookup: async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address),
  now: () => new Date(),
  timeoutMs: URL_TIMEOUT_MS,
});

const PRIVATE = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) PRIVATE.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(address, prefix, 'ipv6');

/** Une IPv4 écrite en IPv6 (`::ffff:7f00:1`) est comparée aux règles IPv4 par `BlockList`. */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i;

class UrlStop extends Error {}

/** Refuse un schéma interdit, des identifiants dans l'URL, un nom local, et toute adresse privée derrière un nom. */
async function assertPublic(target: string, deps: UrlDeps): Promise<URL> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new UrlStop('URL invalide');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlStop(`schéma refusé : ${url.protocol}`);
  if (url.username || url.password) throw new UrlStop('identifiants dans l\'URL refusés');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UrlStop('adresse privée ou locale refusée');
    return url;
  }
  if (!host.includes('.') || LOCAL_NAMES.test(host)) throw new UrlStop('adresse privée ou locale refusée');
  const addresses = await deps.lookup(host).catch(() => {
    throw new UrlStop('nom de domaine introuvable');
  });
  if (addresses.length === 0) throw new UrlStop('nom de domaine introuvable');
  if (addresses.some(isPrivateAddress)) throw new UrlStop('adresse privée ou locale refusée');
  return url;
}

async function ask(url: string, method: 'HEAD' | 'GET', deps: UrlDeps, signal: AbortSignal): Promise<Response> {
  const res = await deps.fetch(url, { method, redirect: 'manual', signal, headers: { 'User-Agent': 'book-print (controle de lien)', Accept: '*/*' } });
  // Le corps n'est jamais lu : une annulation libère la connexion.
  await res.body?.cancel().catch(() => {});
  return res;
}

/** HEAD d'abord. Beaucoup de serveurs refusent HEAD ou y répondent mal : toute réponse d'erreur est reposée en GET. */
async function hop(url: string, deps: UrlDeps, signal: AbortSignal): Promise<Response> {
  const head = await ask(url, 'HEAD', deps, signal);
  return head.status >= 400 ? ask(url, 'GET', deps, signal) : head;
}

async function follow(start: string, deps: UrlDeps, signal: AbortSignal): Promise<number> {
  let target = start;
  for (let redirects = 0; ; redirects++) {
    const url = await assertPublic(target, deps);
    const res = await hop(url.href, deps, signal);
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || location === null) return res.status;
    if (redirects >= MAX_REDIRECTS) throw new UrlStop(`plus de ${MAX_REDIRECTS} redirections`);
    target = new URL(location, url).href;
  }
}

export async function checkUrl(url: string, deps: UrlDeps): Promise<UrlCheck> {
  const controller = new AbortController();
  const date = deps.now().toISOString();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new UrlStop(`aucune réponse en ${Math.round(deps.timeoutMs / 1000)} s`));
    }, deps.timeoutMs);
  });
  try {
    return { date, code: await Promise.race([follow(url, deps, controller.signal), timeout]), error: null };
  } catch (e) {
    return { date, code: null, error: e instanceof UrlStop ? e.message : 'aucune réponse du serveur' };
  } finally {
    clearTimeout(timer);
  }
}

/** Chaque URL une seule fois, `URL_CONCURRENCY` à la fois. */
export async function checkUrls(urls: string[], deps: UrlDeps): Promise<Map<string, UrlCheck>> {
  const queue = [...new Set(urls)];
  const results = new Map<string, UrlCheck>();
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) results.set(url, await checkUrl(url, deps));
  };
  await Promise.all(Array.from({ length: URL_CONCURRENCY }, worker));
  return results;
}
