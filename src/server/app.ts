// src/server/app.ts — serveur local (node:http). Toute requête : `Host` et `Origin` contrôlés. Toute action : `POST` JSON
// avec `x-book-print: 1`. La page n'est servie que depuis une liste fermée : aucun chemin ne vient de l'URL.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import '../schema/common';
import { CollectionRefused } from '../data/collection';
import { CreateRefused, createBookFolder } from '../data/create-book';
import { PricingRefused } from '../data/pricing-file';
import { SubjectRefused } from '../data/subject-file';
import { listBooks, readBook } from '../glbi/read';
import { readFacts } from '../parcours/facts';
import { computeParcours } from '../parcours/steps';
import { RenderRefused } from '../render/html';
import { ImageRefused } from '../images/clean';
import { ResearchRefused } from '../research/errors';
import { CreditsRefused } from '../rights/credits';
import { RightsRefused } from '../rights/registry';
import { GeometryRefused } from '../templates/geometry';
import { loadConfig, type ConfigState } from './config';
import { BadEssaiRequest, ESSAI_ACTIONS, previewHtml, PREVIEW_CSP } from './essai-actions';
import { BadGabaritRequest, GABARIT_ACTIONS, gabaritPreviewHtml } from './gabarit-actions';
import { ComfyError } from '../comfy/client';
import { QueueRefused } from '../comfy/queue';
import { WorkflowRefused } from '../comfy/workflow';
import { BadComfyRequest, candidateBytes, comfyActions, createComfyRuntime, depositEntry, ENTRY_ROUTE, WORKFLOW_MAX_BYTES, type ComfyRuntime } from './comfy-actions';
import { BadImageRequest, depositIllustration, DEPOSIT_ROUTE, ILLUSTRATION_ACTIONS, illustrationBytes, UploadTooLarge } from './illustration-actions';
import { BadPricingRequest, PRICING_ACTIONS } from './pricing-actions';
import { BadRightsRequest, RIGHTS_ACTIONS } from './rights-actions';
import { ACTION_HEADER, actionAllowed, hostAllowed, navigateurIntegre, uploadAllowed } from './rules';
import { BadSubjectRequest, IMPORT_MAX_BYTES, SUBJECT_ACTIONS, subjectPreviewHtml } from './subject-actions';
import { LAYOUT_ACTIONS, layoutPreviewHtml } from './layout-actions';
import { LayoutConflict, LayoutRefused } from '../layout/files';
import { StyleRefused } from '../styles/read';
import { BadStyleRequest, depositEssai, depositReference, ESSAI_ROUTE, previewBytes, REFERENCE_ROUTE, styleActions } from './style-actions';

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
/** L'icône de l'onglet : `print.ico`, à la racine du repo, à côté de `print.cmd`. */
export const ICON_FILE = fileURLToPath(new URL('../../print.ico', import.meta.url));
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  // Éditeur de mise en page (ED3), chargé par la page avant `app.js`.
  '/editeur.js': { file: 'editeur.js', type: 'text/javascript; charset=utf-8' },
};
const MAX_BODY = 64 * 1024;
/** Limites propres à une route : toutes les autres restent à `MAX_BODY`. */
const BODY_LIMITS: Record<string, number> = { '/api/sujet/import': IMPORT_MAX_BYTES, '/api/droits/credits': IMPORT_MAX_BYTES, '/api/workflows/depot': WORKFLOW_MAX_BYTES };
const dirBody = z.strictObject({ dir: z.string() });
const quitBody = z.strictObject({});
/**
 * « Tout arrêter et quitter » (LC1) : route à part, servie seulement si le serveur a reçu de quoi s'arrêter (`print` le lui donne,
 * les tests une fonction factice). La réponse part d'abord ; l'arrêt suit.
 */
export const QUIT_ROUTE = '/api/quitter';
/**
 * Onglets de la page (LC1, comme le studio) : chaque onglet garde un flux d'événements ouvert sur `/evenements` et le relance seul
 * quand il est coupé. Le serveur y envoie son identifiant d'instance : un onglet qui voit un autre identifiant (Print relancé) se
 * recharge. Un seul onglet actif, comme le studio (ST2) : un onglet qui se connecte remplace les autres, qui reçoivent `remplace`
 * et se mettent en veille. `onglet` est appelé à chaque connexion : `main.ts` n'ouvre pas de page si un onglet s'est reconnecté.
 * `TABS_ROUTE` donne le nombre d'onglets actifs au lanceur unique, qui ouvre lui-même les pages.
 * LC2 : un onglet du navigateur intégré de Claude Desktop (`navigateurIntegre`) n'est pas compté (ni `onglet`, ni `TABS_ROUTE`), et
 * un seul onglet actif par sorte de navigateur : il ne remplace que les onglets du navigateur intégré, les autres que les autres.
 */
export const EVENTS_ROUTE = '/evenements';
export const TABS_ROUTE = '/api/onglets';
export type PrintServerOptions = { quitter?: () => void; onglet?: () => void };
/** Clients du flux, avec leur sorte : navigateur intégré de Claude Desktop (`true`) ou autre navigateur (`false`). */
type Onglets = { instance: string; clients: Map<http.ServerResponse, boolean> };
const parcoursBody = z.strictObject({ dir: z.string().nullable() });

type Json = Record<string, unknown>;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    ...extra,
  });
  res.end(body);
}
const sendJson = (res: http.ServerResponse, status: number, value: Json, extra?: Record<string, string>) =>
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', extra);

function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'corps trop long'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'corps JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function configured(state: ConfigState) {
  if (!state.ok) throw new HttpError(409, state.message);
  return state.config;
}

function parseDir(value: unknown): string {
  const body = dirBody.safeParse(value);
  if (!body.success) throw new HttpError(400, 'corps attendu : { "dir": "<dossier du livre>" }');
  return body.data.dir;
}

const ACTIONS: Record<string, (body: unknown, configPath: string) => Json | Promise<Json>> = {
  '/api/state': (_body, configPath) => {
    const state = loadConfig(configPath);
    if (!state.ok) return { config: { ok: false, message: state.message }, books: [] };
    return { config: { ok: true, ...state.config }, books: listBooks(state.config.glbRoot) };
  },
  '/api/read': (body, configPath) => ({ reading: readBook(configured(loadConfig(configPath)).glbRoot, parseDir(body)) }),
  '/api/create': (body, configPath) => {
    const config = configured(loadConfig(configPath));
    const reading = readBook(config.glbRoot, parseDir(body));
    if (reading.errors.length > 0 || !reading.bookId) throw new HttpError(409, `Lecture de GLBInterpreter en erreur : ${reading.errors.join(' ; ')}`);
    return { result: createBookFolder(config.dataRoot, reading.bookId) };
  },
  // Une configuration invalide n'est pas un refus : le parcours la montre, en erreur sur la première étape.
  '/api/parcours': (value, configPath) => {
    const body = parcoursBody.safeParse(value);
    if (!body.success) throw new HttpError(400, 'corps attendu : { "dir": "<dossier du livre>" ou null }');
    return { ...computeParcours(readFacts(loadConfig(configPath), body.data.dir)) };
  },
  ...Object.fromEntries(
    Object.entries({ ...PRICING_ACTIONS, ...ESSAI_ACTIONS, ...GABARIT_ACTIONS }).map(([route, run]) => [route, (body: unknown, configPath: string) => run(body, configured(loadConfig(configPath)).dataRoot)]),
  ),
  ...Object.fromEntries(Object.entries({ ...SUBJECT_ACTIONS, ...LAYOUT_ACTIONS, ...ILLUSTRATION_ACTIONS, ...RIGHTS_ACTIONS }).map(([route, run]) => [route, (body: unknown, configPath: string) => run(body, configured(loadConfig(configPath)))])),
};

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  port: number,
  configPath: string,
  comfy: ComfyRuntime,
  comfyRoutes: ReturnType<typeof comfyActions>,
  options: PrintServerOptions,
  onglets: Onglets,
): Promise<void> {
  // `comfyRoutes` porte aussi les routes de l'étape Styles (IC2), qui partagent la file de ComfyUI.
  if (!hostAllowed(req.headers.host, req.headers.origin, port)) return sendJson(res, 403, { error: 'Host ou Origin refusé' });
  const url = (req.url ?? '/').split('?')[0];

  // Dépôts à corps binaire : une illustration (MP4), un rendu ou une passe Mist (IC1), une référence de style ou le rendu d'essai (IC2).
  // Le corps va en flux dans un temporaire. Seule la référence d'un style peut être un JPEG.
  if (url === DEPOSIT_ROUTE || url === ENTRY_ROUTE || url === REFERENCE_ROUTE || url === ESSAI_ROUTE) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'action : POST attendu' }, { Allow: 'POST' });
    const jpeg = url === REFERENCE_ROUTE;
    const allowed = uploadAllowed(
      { method: req.method, contentType: req.headers['content-type'], actionHeader: req.headers[ACTION_HEADER], origin: req.headers.origin, host: req.headers.host },
      port,
      jpeg,
    );
    if (!allowed) return sendJson(res, 403, { error: `dépôt refusé : POST ${jpeg ? 'image/png ou image/jpeg' : 'image/png'} avec ${ACTION_HEADER}: 1 attendu` });
    const query = new URL(req.url ?? '/', 'http://local').searchParams;
    const config = configured(loadConfig(configPath));
    if (url === REFERENCE_ROUTE) return sendJson(res, 200, await depositReference(query, req, config, comfy));
    if (url === ESSAI_ROUTE) return sendJson(res, 200, await depositEssai(query, req, config, comfy));
    return sendJson(res, 200, url === ENTRY_ROUTE ? await depositEntry(query, req, config, comfy) : await depositIllustration(query, req, config));
  }

  if (url === EVENTS_ROUTE) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET attendu' }, { Allow: 'GET' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.write(`retry: 1000\nevent: instance\ndata: ${onglets.instance}\n\n`);
    const integre = navigateurIntegre(req.headers['user-agent']);
    for (const [autre, sorte] of [...onglets.clients]) {
      if (sorte !== integre) continue;
      autre.write('event: remplace\ndata: {}\n\n');
      autre.end();
      onglets.clients.delete(autre);
    }
    onglets.clients.set(res, integre);
    req.on('close', () => onglets.clients.delete(res));
    if (!integre) options.onglet?.();
    return;
  }

  if (url === TABS_ROUTE) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'action : POST attendu' }, { Allow: 'POST' });
    const allowed = actionAllowed(
      { method: req.method, contentType: req.headers['content-type'], actionHeader: req.headers[ACTION_HEADER], origin: req.headers.origin, host: req.headers.host },
      port,
    );
    if (!allowed) return sendJson(res, 403, { error: `action refusée : POST JSON avec ${ACTION_HEADER}: 1 attendu` });
    if (!quitBody.safeParse(await readBody(req, MAX_BODY)).success) throw new HttpError(400, 'corps attendu : {}');
    return sendJson(res, 200, { onglets: [...onglets.clients.values()].filter((integre) => !integre).length });
  }

  if (url === QUIT_ROUTE) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'action : POST attendu' }, { Allow: 'POST' });
    const allowed = actionAllowed(
      { method: req.method, contentType: req.headers['content-type'], actionHeader: req.headers[ACTION_HEADER], origin: req.headers.origin, host: req.headers.host },
      port,
    );
    if (!allowed) return sendJson(res, 403, { error: `action refusée : POST JSON avec ${ACTION_HEADER}: 1 attendu` });
    if (!quitBody.safeParse(await readBody(req, MAX_BODY)).success) throw new HttpError(400, 'corps attendu : {}');
    const quitter = options.quitter;
    if (!quitter) throw new HttpError(409, 'arrêt indisponible : Print n\'a pas été lancé par npm run print');
    res.once('finish', quitter);
    return sendJson(res, 200, { ok: true });
  }

  const comfyAction = Object.hasOwn(comfyRoutes, url) ? comfyRoutes[url] : undefined;
  const action = Object.hasOwn(ACTIONS, url) ? ACTIONS[url] : comfyAction && ((body: unknown, path: string) => comfyAction(body, configured(loadConfig(path))));
  if (action) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'action : POST attendu' }, { Allow: 'POST' });
    const allowed = actionAllowed(
      { method: req.method, contentType: req.headers['content-type'], actionHeader: req.headers[ACTION_HEADER], origin: req.headers.origin, host: req.headers.host },
      port,
    );
    if (!allowed) return sendJson(res, 403, { error: `action refusée : POST JSON avec ${ACTION_HEADER}: 1 attendu` });
    const limit = Object.hasOwn(BODY_LIMITS, url) ? BODY_LIMITS[url]! : MAX_BODY;
    return sendJson(res, 200, await action(await readBody(req, limit), configPath));
  }

  // Aperçu : le HTML du PDF, dans un cadre de la page. Lecture seule, sur contenu d'essai : polices et images en `data:`, aucun script.
  if (url === '/apercu') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET attendu' }, { Allow: 'GET' });
    const query = new URL(req.url ?? '/', 'http://local').searchParams;
    const html = previewHtml(query.get('bookId'), query.get('theme'), configured(loadConfig(configPath)).dataRoot);
    return send(res, 200, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': PREVIEW_CSP });
  }

  // Aperçu d'un gabarit (GB1) : le même HTML que le PDF, texte de remplissage à la longueur maximale de chaque zone.
  if (url === '/apercu-gabarit') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET attendu' }, { Allow: 'GET' });
    const query = new URL(req.url ?? '/', 'http://local').searchParams;
    const html = await gabaritPreviewHtml(query.get('bookId'), query.get('id'), query.get('theme'), configured(loadConfig(configPath)).dataRoot);
    return send(res, 200, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': PREVIEW_CSP });
  }

  // Aperçu d'un sujet : le même HTML que le PDF, avec le texte réel, relu à chaque demande.
  if (url === '/apercu-sujet') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET attendu' }, { Allow: 'GET' });
    const query = new URL(req.url ?? '/', 'http://local').searchParams;
    const html = await subjectPreviewHtml(query.get('dir'), query.get('subject'), configured(loadConfig(configPath)));
    return send(res, 200, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': PREVIEW_CSP });
  }

  // Mise en page d'un sujet (ED1) : le même HTML que le PDF, au texte de remplissage maximal, comme l'aperçu d'un gabarit.
  if (url === '/apercu-mise-en-page') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET attendu' }, { Allow: 'GET' });
    const query = new URL(req.url ?? '/', 'http://local').searchParams;
    const html = await layoutPreviewHtml(query.get('dir'), query.get('subject'), configured(loadConfig(configPath)));
    return send(res, 200, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': PREVIEW_CSP });
  }

  // L'image gardée, pour la vignette de cadrage. Lecture seule : sujet et zone passent les mêmes refus que le dépôt.
  if (url === '/illustration') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET attendu' }, { Allow: 'GET' });
    const query = new URL(req.url ?? '/', 'http://local').searchParams;
    return send(res, 200, illustrationBytes(query, configured(loadConfig(configPath))), 'image/png');
  }

  // Une image corrigée de la vue « Générer », lue dans le cache. Lecture seule, mêmes refus que la vignette.
  if (url === '/candidat') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET attendu' }, { Allow: 'GET' });
    const query = new URL(req.url ?? '/', 'http://local').searchParams;
    return send(res, 200, candidateBytes(query, configured(loadConfig(configPath))), 'image/png');
  }

  // Aperçu d'un style (IC2), lu dans `collection/.cache/styles/`. Lecture seule.
  if (url === '/apercu-style') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET attendu' }, { Allow: 'GET' });
    const query = new URL(req.url ?? '/', 'http://local').searchParams;
    return send(res, 200, previewBytes(query, configured(loadConfig(configPath))), 'image/png');
  }

  // L'icône est binaire : lue en tampon, jamais en texte. Absente, 404 comme tout fichier hors liste.
  if (url === '/favicon.ico') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET attendu' }, { Allow: 'GET' });
    if (!fs.existsSync(ICON_FILE)) return sendJson(res, 404, { error: 'introuvable' });
    return send(res, 200, fs.readFileSync(ICON_FILE), 'image/x-icon');
  }

  const page = Object.hasOwn(STATIC, url) ? STATIC[url] : undefined;
  if (!page) return sendJson(res, 404, { error: 'introuvable' });
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET attendu' }, { Allow: 'GET' });
  send(res, 200, fs.readFileSync(`${UI_DIR}${page.file}`, 'utf8'), page.type);
}

/** Le port vient du serveur lui-même, pour que les tests puissent écouter sur un port libre. La file de ComfyUI vit avec le serveur. */
export function createPrintServer(configPath: string, comfy: ComfyRuntime = createComfyRuntime(), options: PrintServerOptions = {}): http.Server {
  const comfyRoutes = { ...comfyActions(comfy), ...styleActions(comfy) };
  const onglets: Onglets = { instance: crypto.randomUUID(), clients: new Map() };
  const server = http.createServer((req, res) => {
    // Serveur fermé (LC1 : relance, « Tout arrêter et quitter ») : une connexion encore ouverte peut porter une dernière requête.
    const address = server.address() as AddressInfo | null;
    if (!address) return sendJson(res, 503, { error: 'Print s\'arrête' }, { Connection: 'close' });
    const { port } = address;
    handle(req, res, port, configPath, comfy, comfyRoutes, options, onglets).catch((e: unknown) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      // Le reste du corps n'est pas lu : la connexion se ferme après la réponse.
      if (e instanceof UploadTooLarge) {
        res.once('finish', () => req.destroy());
        return sendJson(res, 413, { error: e.message }, { Connection: 'close' });
      }
      // Une mise en page changée ailleurs depuis sa lecture (ED3) : la page la relit et repart d'un historique vide.
      if (e instanceof LayoutConflict) return sendJson(res, 409, { error: e.message, conflit: true });
      if (e instanceof BadPricingRequest || e instanceof BadEssaiRequest || e instanceof BadGabaritRequest || e instanceof BadSubjectRequest || e instanceof BadImageRequest || e instanceof BadRightsRequest || e instanceof BadComfyRequest || e instanceof BadStyleRequest) return sendJson(res, 400, { error: e.message });
      if (e instanceof CreateRefused || e instanceof PricingRefused || e instanceof CollectionRefused || e instanceof RenderRefused || e instanceof GeometryRefused || e instanceof SubjectRefused || e instanceof ResearchRefused || e instanceof RightsRefused || e instanceof CreditsRefused || e instanceof ImageRefused || e instanceof WorkflowRefused || e instanceof QueueRefused || e instanceof ComfyError || e instanceof StyleRefused || e instanceof LayoutRefused) {
        return sendJson(res, 409, { error: e.message });
      }
      console.error('book-print :', e);
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });
  // Les flux des onglets ne finissent jamais d'eux-mêmes : fermés avec le serveur.
  const close = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const c of onglets.clients.keys()) c.end();
    onglets.clients.clear();
    const r = close(cb);
    server.closeIdleConnections();
    return r;
  }) as typeof server.close;
  return server;
}
