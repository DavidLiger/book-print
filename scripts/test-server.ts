// scripts/test-server.ts — protection du serveur et configuration. Requêtes par node:http : `fetch` fixe lui-même `Host`.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createPrintServer, ICON_FILE } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { actionAllowed, hostAllowed } from '../src/server/rules';
import { createCollection } from '../src/data/collection';
import { IMPORT_MAX_BYTES, checkSubjectUrls } from '../src/server/subject-actions';
import { MAX_UPLOAD_BYTES } from '../src/images/clean';
import { uploadAllowed } from '../src/server/rules';
import { BOOK_DIR, BOOK_ID, dirLink, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { makePng } from './fixtures/make-png';
import { makeResearch } from './fixtures/recherche';
import { check, finish } from './test-lib';

interface Reply {
  status: number;
  body: string;
  bytes: Buffer;
  headers: http.IncomingHttpHeaders;
}

function request(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), bytes: Buffer.concat(chunks), headers: res.headers }));
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
const png = { ...good, contentType: 'image/png' };
check('dépôt : image/png admis', uploadAllowed(png, 4200));
check('dépôt : le JSON n’y est pas admis', !uploadAllowed(good, 4200));
check('action : image/png n’y est pas admis', !actionAllowed(png, 4200));
check('dépôt : sans en-tête refusé', !uploadAllowed({ ...png, actionHeader: undefined }, 4200));
check('dépôt : sans Origin refusé', !uploadAllowed({ ...png, origin: undefined }, 4200));
check('dépôt : GET refusé', !uploadAllowed({ ...png, method: 'GET' }, 4200));
check('dépôt : autre site refusé', !uploadAllowed({ ...png, origin: 'https://attaque.example' }, 4200));

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
{
  const icon = await request(port, { path: '/favicon.ico', headers: { Host: host } });
  if (fs.existsSync(ICON_FILE)) check('icône : print.ico servi tel quel, en binaire', icon.status === 200 && icon.headers['content-type'] === 'image/x-icon' && icon.bytes.equals(fs.readFileSync(ICON_FILE)), icon.status);
  else check('icône : print.ico absent, 404 sans panne', icon.status === 404);
  check('icône : déclarée dans la page', (await request(port, { path: '/', headers: { Host: host } })).body.includes('<link rel="icon" href="/favicon.ico">'));
  check('icône : Host refusé', (await request(port, { path: '/favicon.ico', headers: { Host: 'attaque.example' } })).status === 403);
  check('icône : POST refusé', (await request(port, { method: 'POST', path: '/favicon.ico', headers: action, body: '{}' })).status === 405);
}

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

// Collection : état et création (l'étape Essai, son aperçu et son export ont disparu en ED6)
const collectionState = async () => JSON.parse((await post('/api/collection/state', { bookId: BOOK_ID })).body);
{
  const before = await collectionState();
  check('collection : absente, sans erreur', before.collection.exists === false && before.themes.length === 0, before);
  const firstMade = JSON.parse((await post('/api/collection/create', {})).body).result;
  check('collection créée par action', firstMade.created.includes('collection/style.json') && fs.existsSync(path.join(dataRoot, 'collection', 'pictos', 'lieu.svg')), firstMade);
  const secondMade = JSON.parse((await post('/api/collection/create', {})).body).result;
  check('seconde création : rien de créé', secondMade.created.length === 0 && secondMade.kept.includes('collection/style.json'), secondMade);
  const after = await collectionState();
  check('collection : thèmes lus dans le style', after.themes.length === 5 && after.theme === 'foret', after);
  check('collection : état sans bookId, 400', (await post('/api/collection/state', {})).status === 400);
  check('plus de route /api/essai/* ni de /apercu (ED6)', (await post('/api/essai/state', { bookId: BOOK_ID })).status === 404 && (await post('/api/essai/export', { bookId: BOOK_ID, theme: 'foret' })).status === 404 && (await request(port, { path: `/apercu?bookId=${BOOK_ID}&theme=foret`, headers: { Host: host } })).status === 404);
  check('création de collection sans en-tête refusée', (await post('/api/collection/create', {}, noHeader)).status === 403);
  put(dataRoot, 'collection/style.json', '{}');
  const broken = await collectionState();
  check('style invalide : message dans la page', broken.collection.error?.includes('collection/style.json invalide'), broken);
  fs.rmSync(path.join(dataRoot, 'collection', 'style.json'));
  (await post('/api/collection/create', {})).body;
}
const uiHtml = (await request(port, { path: '/', headers: { Host: host } })).body;
check('page : pages par sujet en saisie libre, 2 au moins', /id="p-par-sujet" type="number" min="2"/.test(uiHtml));
check('page : plus de section Essai (ED6)', !uiHtml.includes('id="essai"') && !uiHtml.includes('essai-exporter'));

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

// Sujets : routes, refus, limite de l'import (la page complète est dans test-ui, le détail des règles dans test-research)
{
  const glb = makeGlbi();
  const dir = tempDir();
  const data = path.join(dir, 'donnees');
  fs.mkdirSync(data);
  put(dir, 'config.local.json', { glbRoot: glb, dataRoot: data });
  const second = createPrintServer(path.join(dir, 'config.local.json'));
  await new Promise<void>((resolve) => second.listen(0, '127.0.0.1', resolve));
  const secondPort = (second.address() as AddressInfo).port;
  const secondHost = `127.0.0.1:${secondPort}`;
  const headers = { Host: secondHost, Origin: `http://${secondHost}`, 'Content-Type': 'application/json', 'x-book-print': '1' };
  const send = (p: string, body: unknown, h: Record<string, string> = headers) => request(secondPort, { method: 'POST', path: p, headers: h, body: JSON.stringify(body) });
  const json = async (p: string, body: unknown) => JSON.parse((await send(p, body)).body);
  const body = { dir: BOOK_DIR, subjectId: 'alpha' };

  check('sujets : livre absent, 409', (await send('/api/sujets/state', { dir: BOOK_DIR })).status === 409);
  await send('/api/create', { dir: BOOK_DIR });
  check('sujets : collection absente, 409', (await send('/api/sujets/state', { dir: BOOK_DIR })).status === 409);
  createCollection(data);
  const sceneList = await json('/api/sujets/state', { dir: BOOK_DIR });
  check('sujets : scènes, gabarits, thème proposé', sceneList.scenes.length === 2 && sceneList.templates[0].id === '2A' && sceneList.templates[0].fits && sceneList.proposedTheme === 'foret' && sceneList.firstPage === 6 && sceneList.subjectPages === 0, sceneList);
  const make = (over = {}) => send('/api/sujets/create', { dir: BOOK_DIR, sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret', ...over });
  check('création : pages en texte, 400', (await make({ pages: '2' })).status === 400);
  check('création : pages sous 2, 400', (await make({ pages: 1 })).status === 400);
  check('création : clé inconnue, 400', (await make({ plus: 1 })).status === 400);
  check('création : chemin refusé, 409', (await send('/api/sujets/create', { dir: '../..', sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' })).status === 409);
  const made = JSON.parse((await make()).body);
  check('création : le total suit', made.subject.id === 'alpha' && made.subjectPages === 2 && made.firstPage === 8 && made.scenes[0].used && made.proposedTheme === 'ocean', made);
  check('création : second essai, 409 et message', (await make()).status === 409 && (await make()).body.includes('existe déjà'));
  const noHeaders = { Host: secondHost, Origin: `http://${secondHost}`, 'Content-Type': 'application/json' };
  for (const route of ['/api/sujets/state', '/api/sujets/create', '/api/sujet/state', '/api/sujet/prompt', '/api/sujet/import', '/api/sujet/claim', '/api/sujet/block', '/api/sujet/fields', '/api/sujet/urls', '/api/sujet/check']) {
    check(`${route} : sans en-tête, 403`, (await send(route, body, noHeaders)).status === 403);
    check(`${route} : GET, 405`, (await request(secondPort, { path: route, headers })).status === 405);
    check(`${route} : Origin d'un autre site, 403`, (await send(route, body, { ...headers, Origin: 'https://attaque.example' })).status === 403);
    check(`${route} : corps invalide, 400`, (await send(route, { dir: 1 })).status === 400);
  }
  const prompt = await json('/api/sujet/prompt', body);
  check('prompt : titre de la scène et blocs du gabarit', prompt.prompt.includes('alpha fr') && prompt.prompt.includes('"zone": "chapeau"'));
  check('sujet : sujet inconnu, 409', (await send('/api/sujet/state', { dir: BOOK_DIR, subjectId: 'inconnu' })).status === 409);
  check('sujet : identifiant refusé, 400', (await send('/api/sujet/state', { dir: BOOK_DIR, subjectId: '../alpha' })).status === 400);

  // Limites de taille
  const filler = (bytes: number) => JSON.stringify({ ...body, content: 'x'.repeat(bytes) });
  const raw = (p: string, payload: string) => request(secondPort, { method: 'POST', path: p, headers, body: payload }).catch(() => ({ status: 413 }));
  check('import : plus de 64 Kio, admis par cette route', (await raw('/api/sujet/import', filler(100 * 1024))).status === 409);
  check('import : limite de 2 Mio', IMPORT_MAX_BYTES === 2097152);
  check('import : au-delà de 2 Mio, refusé', (await raw('/api/sujet/import', filler(IMPORT_MAX_BYTES + 1024))).status === 413);
  check('autres routes : toujours 64 Kio', (await raw('/api/sujet/fields', filler(100 * 1024))).status === 413);
  check('autres routes : 64 Kio aussi pour le parcours', (await raw('/api/parcours', JSON.stringify({ dir: 'x'.repeat(70 * 1024) }))).status === 413);

  // Import
  const refused = await send('/api/sujet/import', { ...body, content: JSON.stringify({ ...makeResearch(), lang: 'es' }) });
  check('import : mauvaise langue, 409, champ nommé', refused.status === 409 && refused.body.includes('champ lang'));
  check('import : rien écrit après un refus', !fs.existsSync(path.join(data, BOOK_ID, 'subjects', 'alpha', 'research.json')));
  check('claim : avant import, 409', (await send('/api/sujet/claim', { ...body, claimId: 'c1', action: { kind: 'valider' } })).status === 409);
  const done = await json('/api/sujet/import', { ...body, content: JSON.stringify(makeResearch()) });
  check('import : écrit', done.imported === true && done.summary.claimsChanged === 3 && done.kept.length === 0, done);
  const again = await json('/api/sujet/import', { ...body, content: JSON.stringify(makeResearch()) });
  check('second import : confirmation, rien d’écrit', again.needsConfirm === true && again.same === true && fs.readdirSync(path.join(data, BOOK_ID, 'subjects', 'alpha')).length === 3, again);
  const replaced = await json('/api/sujet/import', { ...body, content: JSON.stringify(makeResearch()), confirm: true });
  check('second import confirmé : anciens fichiers datés', replaced.kept.length === 2 && fs.readdirSync(path.join(data, BOOK_ID, 'subjects', 'alpha')).length === 5, replaced);

  // Relecture
  const view = await json('/api/sujet/state', body);
  check('état du sujet : blocs, limites, géométrie', view.claims.length === 3 && view.subject.blocks.length === 7 && view.expected.length === 7 && view.titleMax === 40 && view.legendMax === 44 && view.layout.length === 2 && view.title === 'alpha fr', view);
  check('claim : action inconnue, 400', (await send('/api/sujet/claim', { ...body, claimId: 'c1', action: { kind: 'effacer' } })).status === 400);
  check('claim : affirmation inconnue, 409', (await send('/api/sujet/claim', { ...body, claimId: 'c9', action: { kind: 'valider' } })).status === 409);
  check('block : affirmations non validées, 409', (await send('/api/sujet/block', { ...body, blockId: 'chapeau', action: { kind: 'valider' } })).status === 409);
  const validated = await json('/api/sujet/claim', { ...body, claimId: 'c1', action: { kind: 'valider' } });
  check('claim : validée, état rendu', validated.claims[0].status === 'valide');
  check('fields : thème inconnu, 409', (await send('/api/sujet/fields', { ...body, theme: 'rose' })).status === 409);
  check('fields : légende vide, 409', (await send('/api/sujet/fields', { ...body, legend: ' ' })).status === 409);
  const titled = await json('/api/sujet/fields', { ...body, title: 'Autre titre', legend: 'Autre légende', theme: 'ocean' });
  check('fields : titre, légende, thème', titled.title === 'Autre titre' && titled.titleOverride === 'Autre titre' && titled.legend === 'Autre légende' && titled.subject.variant.theme === 'ocean');
  check('fields : surcharge retirée', (await json('/api/sujet/fields', { ...body, title: null })).title === 'alpha fr');

  // URL : `fetch` et DNS injectés, seuls les `urlCheck` sont posés
  const config = { glbRoot: glb, dataRoot: data };
  const urlView = await checkSubjectUrls(config, BOOK_DIR, 'alpha', {
    fetch: async (url) => new Response(null, { status: url.includes('source-2') ? 404 : 200 }),
    lookup: async () => ['93.184.216.34'],
    now: () => new Date('2026-11-06T12:00:00.000Z'),
    timeoutMs: 100,
  }) as { claims: { status: string; sources: { urlCheck: { code: number }; urlDead: boolean }[] }[] };
  check('URL : résultat par source', urlView.claims[0]!.sources[0]!.urlCheck.code === 200 && urlView.claims[1]!.sources[0]!.urlCheck.code === 404 && urlView.claims[1]!.sources[0]!.urlDead);
  check('URL : le statut ne bouge pas', urlView.claims[0]!.status === 'valide' && urlView.claims[1]!.status === 'propose');

  // Aperçu
  const sujetApercu = (query: string, h: Record<string, string> = { Host: secondHost }) => request(secondPort, { path: `/apercu-sujet?${query}`, headers: h });
  const page = await sujetApercu(`dir=${BOOK_DIR}&subject=alpha`);
  check('aperçu du sujet : texte réel, sans script', page.status === 200 && page.body.includes('Fictivore') && !/<script/.test(page.body));
  check('aperçu du sujet : CSP propre', /default-src 'none'/.test(String(page.headers['content-security-policy'])));
  check('aperçu du sujet : POST refusé', (await request(secondPort, { method: 'POST', path: '/apercu-sujet', headers })).status === 405);
  check('aperçu du sujet : Host refusé', (await sujetApercu(`dir=${BOOK_DIR}&subject=alpha`, { Host: 'attaque.example' })).status === 403);
  check('aperçu du sujet : paramètres manquants', (await sujetApercu('')).status === 400);

  // Illustrations : route binaire, cadrage, rattachement
  const imageHeaders = { ...headers, 'Content-Type': 'image/png' };
  const zoneQuery = (zone = 'illustration', extra = '') => `dir=${BOOK_DIR}&subject=alpha&zone=${zone}${extra}`;
  const deposit = (payload: Buffer | string, query = zoneQuery(), h: Record<string, string> = imageHeaders) => request(secondPort, { method: 'POST', path: `/api/sujet/illustration?${query}`, headers: h, body: payload });
  const illustrations = path.join(data, BOOK_ID, 'illustrations', 'alpha');
  const kept = path.join(illustrations, 'illustration.png');
  const subjectFile = path.join(data, BOOK_ID, 'subjects', 'alpha', 'subject.json');
  const rightsFile = path.join(data, BOOK_ID, 'rights.json');
  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const image = makePng(120, 180, 4, (x) => [10, 20, 30, x < 60 ? 0 : 255]);
  const noTemp = () => !fs.existsSync(illustrations) || fs.readdirSync(illustrations).every((f) => !f.endsWith('.tmp'));

  check('dépôt : GET, 405', (await request(secondPort, { path: `/api/sujet/illustration?${zoneQuery()}`, headers })).status === 405);
  const { 'x-book-print': _x, ...withoutAction } = imageHeaders;
  check('dépôt : sans en-tête, 403', (await deposit(image, zoneQuery(), withoutAction)).status === 403);
  const { Origin: _origin, ...withoutOrigin } = imageHeaders;
  check('dépôt : sans Origin, 403', (await deposit(image, zoneQuery(), withoutOrigin)).status === 403);
  check('dépôt : Origin d’un autre site, 403', (await deposit(image, zoneQuery(), { ...imageHeaders, Origin: 'https://attaque.example' })).status === 403);
  check('dépôt : Host refusé, 403', (await deposit(image, zoneQuery(), { ...imageHeaders, Host: 'attaque.example' })).status === 403);
  check('dépôt : type JSON, 403', (await deposit(image, zoneQuery(), headers)).status === 403);
  check('dépôt : type multipart, 403', (await deposit(image, zoneQuery(), { ...imageHeaders, 'Content-Type': 'multipart/form-data' })).status === 403);
  check('dépôt : paramètres manquants, 400', (await deposit(image, `dir=${BOOK_DIR}`)).status === 400);
  check('dépôt : identifiant de sujet refusé, 400', (await deposit(image, `dir=${BOOK_DIR}&subject=../alpha&zone=illustration`)).status === 400);
  check('dépôt : zone refusée, 400', (await deposit(image, `dir=${BOOK_DIR}&subject=alpha&zone=../x`)).status === 400);
  check('dépôt : paramètre inconnu, 400', (await deposit(image, zoneQuery('illustration', '&plus=1'))).status === 400);
  check('dépôt : sujet inconnu, 409', (await deposit(image, `dir=${BOOK_DIR}&subject=inconnu&zone=illustration`)).status === 409);
  check('dépôt : zone qui n’est pas une illustration, 409', (await deposit(image, zoneQuery('texte'))).status === 409);
  check('dépôt : chemin de livre refusé, 409', (await deposit(image, `dir=../..&subject=alpha&zone=illustration`)).status === 409);
  const notPng = await deposit(Buffer.from('ce fichier n\'est pas un PNG'));
  check('dépôt : signature refusée, 409 et message', notPng.status === 409 && notPng.body.includes('pas un PNG'), notPng.body);
  const declared = await request(secondPort, { method: 'POST', path: `/api/sujet/illustration?${zoneQuery()}`, headers: { ...imageHeaders, 'Content-Length': String(MAX_UPLOAD_BYTES + 1) } }).catch(() => ({ status: 0 }));
  check('dépôt : taille annoncée trop grande, 413', declared.status === 413, declared.status);
  const streamed = await request(secondPort, { method: 'POST', path: `/api/sujet/illustration?${zoneQuery()}`, headers: imageHeaders, body: Buffer.alloc(MAX_UPLOAD_BYTES + 1024) }).catch(() => ({ status: 413 }));
  check('dépôt : corps trop gros, sans taille annoncée, 413', streamed.status === 413, streamed.status);
  check('dépôt : un refus ne laisse rien', !fs.existsSync(kept) && noTemp() && readJson(subjectFile).illustrations.length === 0);
  const rightsBefore = fs.readFileSync(rightsFile);
  fs.writeFileSync(rightsFile, '{');
  check('dépôt : registre illisible, 409, rien d’écrit', (await deposit(image)).status === 409 && !fs.existsSync(kept) && readJson(subjectFile).illustrations.length === 0);
  fs.writeFileSync(rightsFile, rightsBefore);

  const statusBefore = readJson(subjectFile).status;
  const first = await deposit(image);
  const firstView = JSON.parse(first.body);
  check('dépôt : accepté, dimensions relues', first.status === 200 && firstView.deposited === true && firstView.width === 120 && firstView.height === 180, first.body.slice(0, 300));
  check('dépôt : fichier gardé, aucun temporaire', fs.existsSync(kept) && noTemp() && fs.readdirSync(illustrations).join() === 'illustration.png');
  check('dépôt : subject.json porte zone, fichier, dimensions, cadrage', JSON.stringify(readJson(subjectFile).illustrations) === JSON.stringify([{ zone: 'illustration', file: 'illustrations/alpha/illustration.png', width: 120, height: 180, framing: { focusX: 0.5, focusY: 0.5, zoom: 1 } }]));
  check('dépôt à la main : rights.json porte le lien, aiGenerated faux (ED5)', JSON.stringify(readJson(rightsFile).illustrations) === JSON.stringify([{ subject: 'alpha', zone: 'illustration', file: 'illustrations/alpha/illustration.png', rights: [], aiGenerated: false }]));
  check('dépôt : le statut du sujet ne bouge pas', readJson(subjectFile).status === statusBefore);
  check('dépôt : vue, taille cible calculée', firstView.zones[0].target.width === 1838 && firstView.zones[0].target.height === 2775 && firstView.zones[0].ppi < 300, firstView.zones[0]);
  const stored = fs.readFileSync(kept);
  const replaceLater = makePng(240, 360, 3, () => [1, 2, 3]);
  const asked = JSON.parse((await deposit(replaceLater)).body);
  check('second dépôt : confirmation, rien d’écrit', asked.needsConfirm === true && fs.readFileSync(kept).equals(stored) && noTemp());
  const wrongAgain = await deposit(Buffer.from('toujours pas un PNG'));
  check('second dépôt, fichier refusé : refus immédiat, sans confirmation', wrongAgain.status === 409 && wrongAgain.body.includes('pas un PNG') && fs.readFileSync(kept).equals(stored));

  // Cadrage
  const framing = { focusX: 0.2, focusY: 0.8, zoom: 1.5 };
  const zoneBody = { ...body, zone: 'illustration' };
  const framed = await json('/api/sujet/cadrage', { ...zoneBody, framing });
  check('cadrage : enregistré, résolution recalculée', JSON.stringify(readJson(subjectFile).illustrations[0].framing) === JSON.stringify(framing) && framed.zones[0].ppi < firstView.zones[0].ppi, framed.zones[0]);
  check('cadrage : zoom sous 1, 400', (await send('/api/sujet/cadrage', { ...zoneBody, framing: { ...framing, zoom: 0.5 } })).status === 400);
  check('cadrage : point focal hors image, 400', (await send('/api/sujet/cadrage', { ...zoneBody, framing: { ...framing, focusX: 2 } })).status === 400);
  check('cadrage : zone sans image, 409', (await send('/api/sujet/cadrage', { ...body, zone: 'texte', framing })).status === 409);
  check('cadrage : le statut du sujet ne bouge pas', readJson(subjectFile).status === statusBefore);

  // Rattachement : seules les entrées du registre
  check('droits : les entrées proposées excluent polices, pictogrammes et extensions', framed.entries.some((e: { id: string }) => e.id === 'sdxl-base-1-0') && !framed.entries.some((e: { kind: string }) => ['police', 'picto', 'extension'].includes(e.kind)), framed.entries);
  check('droits : entrée inconnue, 409', (await send('/api/sujet/droits-image', { ...zoneBody, rights: ['fantome'] })).status === 409);
  check('droits : police refusée, 409', (await send('/api/sujet/droits-image', { ...zoneBody, rights: ['andika'] })).status === 409);
  check('droits : extension refusée, 409', (await send('/api/sujet/droits-image', { ...zoneBody, rights: ['comfyui-ipadapter-plus'] })).status === 409);
  check('droits : identifiant invalide, 400', (await send('/api/sujet/droits-image', { ...zoneBody, rights: ['A B'] })).status === 400);
  const linked = await json('/api/sujet/droits-image', { ...zoneBody, rights: ['sdxl-base-1-0'] });
  check('droits : rattachés, C11 au vert ou en alerte', linked.zones[0].rights.join() === 'sdxl-base-1-0' && linked.checks.find((c: { id: string }) => c.id === 'C11').level === 'alerte', linked.checks);
  check('droits : C5 rouge sur cette petite image', linked.checks.find((c: { id: string }) => c.id === 'C5').level === 'erreur');

  // Remplacement confirmé
  const replaced2 = JSON.parse((await deposit(replaceLater, zoneQuery('illustration', '&confirm=1'))).body);
  check('remplacement : fichier neuf, ancien non gardé', replaced2.width === 240 && fs.readdirSync(illustrations).join() === 'illustration.png');
  check('remplacement : cadrage remis à zéro', JSON.stringify(readJson(subjectFile).illustrations[0].framing) === '{"focusX":0.5,"focusY":0.5,"zoom":1}' && readJson(subjectFile).illustrations.length === 1);
  check('remplacement : les droits restent', readJson(rightsFile).illustrations[0].rights.join() === 'sdxl-base-1-0' && readJson(rightsFile).illustrations.length === 1);

  // L'image gardée, pour la vignette, et l'aperçu
  const thumb = (query: string, h: Record<string, string> = { Host: secondHost }) => request(secondPort, { path: `/illustration?${query}`, headers: h });
  const served = await thumb(zoneQuery('illustration', '&t=1'));
  check('vignette : le fichier gardé', served.status === 200 && served.headers['content-type'] === 'image/png' && served.bytes.equals(fs.readFileSync(kept)));
  check('vignette : Host refusé', (await thumb(zoneQuery(), { Host: 'attaque.example' })).status === 403);
  check('vignette : Origin d’un autre site refusée', (await thumb(zoneQuery(), { Host: secondHost, Origin: 'https://attaque.example' })).status === 403);
  check('vignette : POST refusé', (await request(secondPort, { method: 'POST', path: `/illustration?${zoneQuery()}`, headers })).status === 405);
  check('vignette : paramètres manquants, 400', (await thumb('')).status === 400);
  check('vignette : zone qui n’est pas une illustration, 409', (await thumb(zoneQuery('texte'))).status === 409);
  const previewed = await sujetApercu(`dir=${BOOK_DIR}&subject=alpha`);
  check('aperçu : image réelle en data:, plus d’aplat', previewed.status === 200 && previewed.body.includes('data:image/png;base64,') && !previewed.body.includes('venir'));
  check('aperçu : aucun chemin de fichier dans le HTML', !previewed.body.includes('illustrations/alpha'));
  fs.rmSync(kept);
  const lost = await sujetApercu(`dir=${BOOK_DIR}&subject=alpha`);
  check('fichier absent : l’aperçu garde l’aplat', lost.status === 200 && lost.body.includes('venir'));
  check('fichier absent : dit dans la vue', (await json('/api/sujet/images', body)).zones[0].fault.includes('absent du disque'));
  check('fichier absent : vignette, 409', (await thumb(zoneQuery())).status === 409);
  fs.writeFileSync(kept, stored.subarray(0, 40));
  check('fichier abîmé : 8 bits RVB relus, l’aperçu répond', (await sujetApercu(`dir=${BOOK_DIR}&subject=alpha`)).status === 200);
  fs.writeFileSync(kept, 'pas un png');
  check('fichier remplacé à la main : signalé', (await json('/api/sujet/images', body)).zones[0].fault.includes('pas un PNG'));
  fs.writeFileSync(kept, makePng(10, 10, 4, () => [0, 0, 0, 0]));
  check('fichier RVBA posé à la main : refusé', (await json('/api/sujet/images', body)).zones[0].fault.includes('RVB 8 bits'));
  check('fichier RVBA posé à la main : pas dans l’aperçu', !(await sujetApercu(`dir=${BOOK_DIR}&subject=alpha`)).body.includes('data:image/png'));
  fs.rmSync(illustrations, { recursive: true });
  const outside = tempDir();
  dirLink(outside, illustrations);
  check('lien à la place du dossier : dépôt refusé, rien n’y entre', (await deposit(image, zoneQuery('illustration', '&confirm=1'))).status === 409 && fs.readdirSync(outside).length === 0);
  try {
    fs.unlinkSync(illustrations);
  } catch {
    fs.rmdirSync(illustrations); // Windows : une jonction se retire comme un dossier.
  }

  // Droits du livre
  for (const route of ['/api/droits/state', '/api/droits/completer', '/api/droits/enregistrer', '/api/droits/credits', '/api/sujet/images', '/api/sujet/cadrage', '/api/sujet/droits-image']) {
    check(`${route} : sans en-tête, 403`, (await send(route, body, noHeaders)).status === 403);
    check(`${route} : GET, 405`, (await request(secondPort, { path: route, headers })).status === 405);
    check(`${route} : Origin d'un autre site, 403`, (await send(route, body, { ...headers, Origin: 'https://attaque.example' })).status === 403);
    check(`${route} : corps invalide, 400`, (await send(route, { dir: 1 })).status === 400);
  }
  const rightsState = await json('/api/droits/state', { dir: BOOK_DIR });
  check('droits : les deux registres, rien ne manque', rightsState.collection.length === 11 && rightsState.book.length === 0 && rightsState.missing.length === 0 && rightsState.error === null, rightsState);
  check('droits : compléter un registre complet ne change rien', (await json('/api/droits/completer', { dir: BOOK_DIR })).completed.added.length === 0);
  const newEntry = { kind: 'modele-3d', name: 'Modèle à la main', author: 'Auteur', license: 'CC BY 4.0', url: '', credit: 'Crédit', commercialOk: 'oui' };
  const added = await json('/api/droits/enregistrer', { dir: BOOK_DIR, scope: 'livre', entry: newEntry });
  check('droits : ajout, identifiant calculé, URL vide retirée', added.saved === 'auteur-modele-a-la-main' && added.book.length === 1 && !('url' in added.book[0]), added.book);
  check('droits : second ajout, 409', (await send('/api/droits/enregistrer', { dir: BOOK_DIR, scope: 'livre', entry: newEntry })).status === 409);
  check('droits : registre inconnu, 400', (await send('/api/droits/enregistrer', { dir: BOOK_DIR, scope: 'autre', entry: newEntry })).status === 400);
  check('droits : sans nom ni auteur, 409', (await send('/api/droits/enregistrer', { dir: BOOK_DIR, scope: 'livre', entry: { ...newEntry, name: '', author: '' } })).status === 409);
  const edited = await json('/api/droits/enregistrer', { dir: BOOK_DIR, scope: 'livre', id: 'auteur-modele-a-la-main', entry: { ...newEntry, commercialOk: 'non', credit: '' } });
  check('droits : modification, fautes dites', edited.book.length === 1 && edited.book[0].commercialOk === 'non' && edited.book[0].faults.join() === 'crédit vide', edited.book);
  const credits = { entries: [{ asset: '', src_name: 'Forêt de synthèse', author: 'Auteur Fictif', license: 'C.C by 4.0', url: 'https://exemple.test/f', original: false }, { asset: '', src_name: 'Mien', author: 'David', license: '', url: '', original: true }] };
  const imported = await json('/api/droits/credits', { dir: BOOK_DIR, content: JSON.stringify(credits) });
  check('credits.json : entrée créée, original ignoré', imported.imported.added.length === 1 && imported.imported.originals === 1 && imported.book.length === 2 && imported.book[1].commercialOk === 'oui', imported.imported);
  const importedRights = fs.readFileSync(rightsFile);
  check('credits.json : second dépôt, aucune modification', (await json('/api/droits/credits', { dir: BOOK_DIR, content: JSON.stringify(credits) })).imported.added.length === 0 && fs.readFileSync(rightsFile).equals(importedRights));
  check('credits.json : fichier invalide, 409', (await send('/api/droits/credits', { dir: BOOK_DIR, content: '{' })).status === 409);
  check('credits.json : plus de 64 Kio, admis par cette route', (await raw('/api/droits/credits', JSON.stringify({ dir: BOOK_DIR, content: JSON.stringify({ entries: [], pad: 'x'.repeat(100 * 1024) }) }))).status === 200);
  check('credits.json : au-delà de 2 Mio, refusé', (await raw('/api/droits/credits', JSON.stringify({ dir: BOOK_DIR, content: 'x'.repeat(IMPORT_MAX_BYTES + 1024) }))).status === 413);
  fs.writeFileSync(rightsFile, '{');
  const brokenRights = await json('/api/droits/state', { dir: BOOK_DIR });
  check('droits : registre illisible, message dans la page, fichier conservé', brokenRights.error.includes('conservé tel quel') && fs.readFileSync(rightsFile, 'utf8') === '{');
  await new Promise((resolve) => second.close(resolve));
}

finish('serveur');
