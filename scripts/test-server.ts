// scripts/test-server.ts — protection du serveur et configuration. Requêtes par node:http : `fetch` fixe lui-même `Host`.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createPrintServer } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { actionAllowed, hostAllowed } from '../src/server/rules';
import { BOOK_DIR, BOOK_ID, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { check, finish } from './test-lib';

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Règles pures
check('Host 127.0.0.1 admis', hostAllowed('127.0.0.1:4200', undefined, 4200));
check('Host localhost admis', hostAllowed('localhost:4200', undefined, 4200));
check('Host absent refusé', !hostAllowed(undefined, undefined, 4200));
check('Host autre port refusé', !hostAllowed('127.0.0.1:4000', undefined, 4200));
check('Host de rebinding refusé', !hostAllowed('attaque.example:4200', undefined, 4200));
check('Origin autre site refusée', !hostAllowed('127.0.0.1:4200', 'https://attaque.example', 4200));
check('Origin null refusée', !hostAllowed('127.0.0.1:4200', 'null', 4200));
check('Origin https locale refusée', !hostAllowed('127.0.0.1:4200', 'https://127.0.0.1:4200', 4200));
const good = { method: 'POST', contentType: 'application/json', actionHeader: '1', origin: 'http://127.0.0.1:4200', host: '127.0.0.1:4200' };
check('action complète admise', actionAllowed(good, 4200));
check('action sans Origin refusée', !actionAllowed({ ...good, origin: undefined }, 4200));
check('action en text/plain refusée', !actionAllowed({ ...good, contentType: 'text/plain' }, 4200));
check('action avec en-tête ≠ 1 refusée', !actionAllowed({ ...good, actionHeader: '0' }, 4200));

// Serveur réel sur un port libre
const glbRoot = makeGlbi();
const parent = tempDir();
const dataRoot = path.join(parent, 'donnees');
fs.mkdirSync(dataRoot);
const configPath = path.join(parent, 'config.local.json');
put(parent, 'config.local.json', { glbRoot, dataRoot });

const server = createPrintServer(configPath);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;
const action = { Host: host, Origin: origin, 'Content-Type': 'application/json', 'x-book-print': '1' };
const post = (p: string, body: unknown, headers: Record<string, string> = action) => request(port, { method: 'POST', path: p, headers, body: JSON.stringify(body) });

check('écoute sur 127.0.0.1', (server.address() as AddressInfo).address === '127.0.0.1');
check('page servie', (await request(port, { path: '/', headers: { Host: host } })).body.includes('book-print'));
check('script servi', (await request(port, { path: '/app.js', headers: { Host: host } })).status === 200);
check('page : Host refusé', (await request(port, { path: '/', headers: { Host: 'attaque.example' } })).status === 403);
check('page : Origin refusée', (await request(port, { path: '/', headers: { Host: host, Origin: 'https://attaque.example' } })).status === 403);
check('chemin hors liste : 404', (await request(port, { path: '/../config.local.json', headers: { Host: host } })).status === 404);

check('POST : Host refusé', (await post('/api/state', {}, { ...action, Host: 'attaque.example' })).status === 403);
check('POST : Origin refusée', (await post('/api/state', {}, { ...action, Origin: 'https://attaque.example' })).status === 403);
const { 'x-book-print': _h, ...noHeader } = action;
check('POST sans en-tête refusé', (await post('/api/state', {}, noHeader)).status === 403);
const { Origin: _o, ...noOrigin } = action;
check('POST sans Origin refusé', (await post('/api/state', {}, noOrigin)).status === 403);
check('POST en text/plain refusé', (await post('/api/state', {}, { ...action, 'Content-Type': 'text/plain' })).status === 403);
const getAction = await request(port, { path: '/api/state', headers: action });
check('GET d’action refusé', getAction.status === 405 && getAction.headers.allow === 'POST');
check('GET de création refusé', (await request(port, { path: '/api/create', headers: { Host: host } })).status === 405);
check('OPTIONS (préflight) refusé', (await request(port, { method: 'OPTIONS', path: '/api/state', headers: action })).status === 405);
check('corps JSON invalide : 400', (await request(port, { method: 'POST', path: '/api/read', headers: action, body: '{' })).status === 400);
check('corps sans dir : 400', (await post('/api/read', {})).status === 400);

const state = JSON.parse((await post('/api/state', {})).body);
check('état : configuration et livre', state.config.ok && state.books[0].dir === BOOK_DIR && state.books[0].built, state);
const reading = JSON.parse((await post('/api/read', { dir: BOOK_DIR })).body).reading;
check('lecture par action', reading.bookId === BOOK_ID && reading.errors.length === 0, reading);
const created = JSON.parse((await post('/api/create', { dir: BOOK_DIR })).body).result;
check('création par action', created.created.includes(`${BOOK_ID}/print-book.json`) && fs.existsSync(path.join(dataRoot, BOOK_ID, 'print-book.json')), created);
fs.rmSync(path.join(glbRoot, 'out', 'book.json'));
const blocked = await post('/api/create', { dir: BOOK_DIR });
check('création refusée si la lecture est en erreur', blocked.status === 409 && blocked.body.includes('out/book.json'), blocked);

put(parent, 'config.local.json', '{');
const bad = JSON.parse((await post('/api/state', {})).body);
check('configuration invalide : message dans la page, sans relance', !bad.config.ok && bad.config.message.includes('config.local.json'), bad);
check('configuration invalide : action refusée', (await post('/api/read', { dir: BOOK_DIR })).status === 409);
await new Promise((resolve) => server.close(resolve));

// Port occupé : `main.ts` lit ce code d'erreur pour afficher son message.
{
  const a = createPrintServer(configPath);
  await new Promise<void>((resolve) => a.listen(0, '127.0.0.1', resolve));
  const b = createPrintServer(configPath);
  const code = await new Promise<string | undefined>((resolve) => {
    b.on('error', (e: NodeJS.ErrnoException) => resolve(e.code));
    b.listen((a.address() as AddressInfo).port, '127.0.0.1');
  });
  check('port occupé : EADDRINUSE', code === 'EADDRINUSE', code);
  await new Promise((resolve) => a.close(resolve));
}

// Configuration
{
  const dir = tempDir();
  const file = path.join(dir, 'config.local.json');
  const glb = makeGlbi();
  const data = tempDir();
  const expectMessage = (name: string, text: string) => {
    const s = loadConfig(file);
    check(name, !s.ok && s.message.includes(text), s);
  };
  expectMessage('fichier absent : dit quoi faire', 'config.example.json');
  put(dir, 'config.local.json', '{');
  expectMessage('JSON invalide', 'JSON valide');
  put(dir, 'config.local.json', { glbRoot: glb });
  expectMessage('dataRoot manquant', 'dataRoot');
  put(dir, 'config.local.json', { glbRoot: glb, dataRoot: data, autre: 1 });
  expectMessage('clé inconnue', 'autre');
  put(dir, 'config.local.json', { glbRoot: 'relatif', dataRoot: data });
  expectMessage('chemin relatif', 'absolu');
  put(dir, 'config.local.json', { glbRoot: path.join(dir, 'rien'), dataRoot: data });
  expectMessage('glbRoot inexistant', 'glbRoot n\'existe pas');
  put(dir, 'config.local.json', { glbRoot: data, dataRoot: dir });
  expectMessage('glbRoot sans books/', 'books/');
  put(dir, 'config.local.json', { glbRoot: glb, dataRoot: path.join(dir, 'rien') });
  expectMessage('dataRoot inexistant', 'dataRoot n\'existe pas');
  put(dir, 'config.local.json', { glbRoot: glb, dataRoot: path.join(glb, 'books') });
  expectMessage('dataRoot sous glbRoot', 'l\'un dans l\'autre');
  put(dir, 'config.local.json', { glbRoot: glb, dataRoot: path.dirname(glb) });
  expectMessage('glbRoot sous dataRoot', 'l\'un dans l\'autre');
  const repo = path.resolve(import.meta.dirname, '..');
  put(dir, 'config.local.json', { glbRoot: glb, dataRoot: repo });
  expectMessage('dataRoot égal au repo book-print', 'repo book-print');
  put(dir, 'config.local.json', { glbRoot: glb, dataRoot: path.join(repo, 'scripts') });
  expectMessage('dataRoot sous le repo book-print', 'repo book-print');
  put(dir, 'config.local.json', { glbRoot: glb, dataRoot: path.dirname(repo) });
  expectMessage('repo book-print sous dataRoot', 'repo book-print');
  put(dir, 'config.local.json', { glbRoot: glb, dataRoot: data });
  check('configuration valide', loadConfig(file).ok);
}

finish('serveur');
