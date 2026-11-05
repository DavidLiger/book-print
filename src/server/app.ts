// src/server/app.ts — serveur local (node:http). Toute requête : `Host` et `Origin` contrôlés. Toute action : `POST` JSON
// avec `x-book-print: 1`. La page n'est servie que depuis une liste fermée : aucun chemin ne vient de l'URL.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import '../schema/common';
import { CreateRefused, createBookFolder } from '../data/create-book';
import { PricingRefused } from '../data/pricing-file';
import { listBooks, readBook } from '../glbi/read';
import { loadConfig, type ConfigState } from './config';
import { BadPricingRequest, PRICING_ACTIONS } from './pricing-actions';
import { ACTION_HEADER, actionAllowed, hostAllowed } from './rules';

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
const MAX_BODY = 64 * 1024;
const dirBody = z.strictObject({ dir: z.string() });

type Json = Record<string, unknown>;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
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

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
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

const ACTIONS: Record<string, (body: unknown, configPath: string) => Json> = {
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
  ...Object.fromEntries(
    Object.entries(PRICING_ACTIONS).map(([route, run]) => [route, (body: unknown, configPath: string) => run(body, configured(loadConfig(configPath)).dataRoot)]),
  ),
};

async function handle(req: http.IncomingMessage, res: http.ServerResponse, port: number, configPath: string): Promise<void> {
  if (!hostAllowed(req.headers.host, req.headers.origin, port)) return sendJson(res, 403, { error: 'Host ou Origin refusé' });
  const url = (req.url ?? '/').split('?')[0];

  const action = Object.hasOwn(ACTIONS, url) ? ACTIONS[url] : undefined;
  if (action) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'action : POST attendu' }, { Allow: 'POST' });
    const allowed = actionAllowed(
      { method: req.method, contentType: req.headers['content-type'], actionHeader: req.headers[ACTION_HEADER], origin: req.headers.origin, host: req.headers.host },
      port,
    );
    if (!allowed) return sendJson(res, 403, { error: `action refusée : POST JSON avec ${ACTION_HEADER}: 1 attendu` });
    return sendJson(res, 200, action(await readBody(req), configPath));
  }

  const page = Object.hasOwn(STATIC, url) ? STATIC[url] : undefined;
  if (!page) return sendJson(res, 404, { error: 'introuvable' });
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET attendu' }, { Allow: 'GET' });
  send(res, 200, fs.readFileSync(`${UI_DIR}${page.file}`, 'utf8'), page.type);
}

/** Le port vient du serveur lui-même, pour que les tests puissent écouter sur un port libre. */
export function createPrintServer(configPath: string): http.Server {
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    handle(req, res, port, configPath).catch((e: unknown) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      if (e instanceof BadPricingRequest) return sendJson(res, 400, { error: e.message });
      if (e instanceof CreateRefused || e instanceof PricingRefused) return sendJson(res, 409, { error: e.message });
      console.error('book-print :', e);
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });
  return server;
}
