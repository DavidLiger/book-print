// src/server/app.ts — serveur local (node:http). Toute requête : `Host` et `Origin` contrôlés. Toute action : `POST` JSON
// avec `x-book-print: 1`. La page n'est servie que depuis une liste fermée : aucun chemin ne vient de l'URL.
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
import { ComfyError } from '../comfy/client';
import { QueueRefused } from '../comfy/queue';
import { WorkflowRefused } from '../comfy/workflow';
import { BadComfyRequest, candidateBytes, comfyActions, createComfyRuntime, depositEntry, ENTRY_ROUTE, WORKFLOW_MAX_BYTES, type ComfyRuntime } from './comfy-actions';
import { BadImageRequest, depositIllustration, DEPOSIT_ROUTE, ILLUSTRATION_ACTIONS, illustrationBytes, UploadTooLarge } from './illustration-actions';
import { BadPricingRequest, PRICING_ACTIONS } from './pricing-actions';
import { BadRightsRequest, RIGHTS_ACTIONS } from './rights-actions';
import { ACTION_HEADER, actionAllowed, hostAllowed, uploadAllowed } from './rules';
import { BadSubjectRequest, IMPORT_MAX_BYTES, SUBJECT_ACTIONS, subjectPreviewHtml } from './subject-actions';

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
/** L'icône de l'onglet : `print.ico`, à la racine du repo, à côté de `print.cmd`. */
export const ICON_FILE = fileURLToPath(new URL('../../print.ico', import.meta.url));
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
const MAX_BODY = 64 * 1024;
/** Limites propres à une route : toutes les autres restent à `MAX_BODY`. */
const BODY_LIMITS: Record<string, number> = { '/api/sujet/import': IMPORT_MAX_BYTES, '/api/droits/credits': IMPORT_MAX_BYTES, '/api/workflows/depot': WORKFLOW_MAX_BYTES };
const dirBody = z.strictObject({ dir: z.string() });
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
    Object.entries({ ...PRICING_ACTIONS, ...ESSAI_ACTIONS }).map(([route, run]) => [route, (body: unknown, configPath: string) => run(body, configured(loadConfig(configPath)).dataRoot)]),
  ),
  ...Object.fromEntries(Object.entries({ ...SUBJECT_ACTIONS, ...ILLUSTRATION_ACTIONS, ...RIGHTS_ACTIONS }).map(([route, run]) => [route, (body: unknown, configPath: string) => run(body, configured(loadConfig(configPath)))])),
};

async function handle(req: http.IncomingMessage, res: http.ServerResponse, port: number, configPath: string, comfy: ComfyRuntime, comfyRoutes: ReturnType<typeof comfyActions>): Promise<void> {
  if (!hostAllowed(req.headers.host, req.headers.origin, port)) return sendJson(res, 403, { error: 'Host ou Origin refusé' });
  const url = (req.url ?? '/').split('?')[0];

  // Dépôts à corps binaire : une illustration (MP4), un rendu ou une passe Mist (IC1). Le corps va en flux dans un temporaire.
  if (url === DEPOSIT_ROUTE || url === ENTRY_ROUTE) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'action : POST attendu' }, { Allow: 'POST' });
    const allowed = uploadAllowed(
      { method: req.method, contentType: req.headers['content-type'], actionHeader: req.headers[ACTION_HEADER], origin: req.headers.origin, host: req.headers.host },
      port,
    );
    if (!allowed) return sendJson(res, 403, { error: `dépôt refusé : POST image/png avec ${ACTION_HEADER}: 1 attendu` });
    const query = new URL(req.url ?? '/', 'http://local').searchParams;
    const config = configured(loadConfig(configPath));
    return sendJson(res, 200, url === ENTRY_ROUTE ? await depositEntry(query, req, config, comfy) : await depositIllustration(query, req, config));
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

  // Aperçu d'un sujet : le même HTML que le PDF, avec le texte réel, relu à chaque demande.
  if (url === '/apercu-sujet') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET attendu' }, { Allow: 'GET' });
    const query = new URL(req.url ?? '/', 'http://local').searchParams;
    const html = subjectPreviewHtml(query.get('dir'), query.get('subject'), configured(loadConfig(configPath)));
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
export function createPrintServer(configPath: string, comfy: ComfyRuntime = createComfyRuntime()): http.Server {
  const comfyRoutes = comfyActions(comfy);
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    handle(req, res, port, configPath, comfy, comfyRoutes).catch((e: unknown) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      // Le reste du corps n'est pas lu : la connexion se ferme après la réponse.
      if (e instanceof UploadTooLarge) {
        res.once('finish', () => req.destroy());
        return sendJson(res, 413, { error: e.message }, { Connection: 'close' });
      }
      if (e instanceof BadPricingRequest || e instanceof BadEssaiRequest || e instanceof BadSubjectRequest || e instanceof BadImageRequest || e instanceof BadRightsRequest || e instanceof BadComfyRequest) return sendJson(res, 400, { error: e.message });
      if (e instanceof CreateRefused || e instanceof PricingRefused || e instanceof CollectionRefused || e instanceof RenderRefused || e instanceof GeometryRefused || e instanceof SubjectRefused || e instanceof ResearchRefused || e instanceof RightsRefused || e instanceof CreditsRefused || e instanceof ImageRefused || e instanceof WorkflowRefused || e instanceof QueueRefused || e instanceof ComfyError) {
        return sendJson(res, 409, { error: e.message });
      }
      console.error('book-print :', e);
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });
  return server;
}
