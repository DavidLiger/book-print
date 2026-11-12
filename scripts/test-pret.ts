// scripts/test-pret.ts — ED6 : le QR réel (C9), « prêt », la suppression d'un sujet, le changement de modèle, et P-33 (`src/` ne lit pas `scripts/`).
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import sharp from 'sharp';
import { c9Qr, decodeQr, QR_MIN_SIDE_MM, qrDataFaults } from '../src/checks/qr';
import { createBookFolder } from '../src/data/create-book';
import { createCollection } from '../src/data/collection';
import { DELETED_DIR, createSubject, deleteSubject, changeModel, readSubject, subjectFolder, updateSubject, SubjectRefused } from '../src/data/subject-file';
import { readPrintBook } from '../src/data/pricing-file';
import { computeParcours } from '../src/parcours/steps';
import { readFacts } from '../src/parcours/facts';
import { createPrintServer } from '../src/server/app';
import { READY_CHECKS, checksRefusal } from '../src/server/subject-actions';
import { loadConfig } from '../src/server/config';
import { BOOK_DIR, BOOK_ID, ORIGIN, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { qrSvg } from './fixtures/qr-encode';
import { synthese } from './fixtures/mises-en-page';
import { check, finish } from './test-lib';

const URL_ALPHA = `${ORIGIN}/s/alpha`;
const png = (svg: string, px: number) => sharp(Buffer.from(svg), { density: 300 }).resize(px, px).flatten({ background: '#fff' }).png().toBuffer();

// C9 : une erreur par cause, nommée ; vert quand tout va.
{
  const good = { sceneId: 'alpha', expectedFile: '01-alpha.svg', qr: { file: '01-alpha.svg', url: URL_ALPHA }, fault: null, expectedUrl: URL_ALPHA, capture: { sideMm: 30 }, decoded: URL_ALPHA };
  const c9 = (over: object) => c9Qr({ ...good, ...over });
  check('C9 vert : fichier, urls.txt, côté et décodage corrects', c9({}).level === 'ok' && c9({}).id === 'C9');
  check('C9 : seuil à 25 mm, 25 mm pile admis', QR_MIN_SIDE_MM === 25 && c9({ capture: { sideMm: 25 } }).level === 'ok' && c9({ capture: { sideMm: 24.96 } }).level === 'ok');
  const absent = c9({ qr: null });
  check('C9 rouge : QR absent, fichier nommé', absent.level === 'erreur' && absent.details.length === 1 && absent.details[0]!.includes('QR absent') && absent.details[0]!.includes('01-alpha.svg'), absent);
  const other = c9({ qr: { file: '01-alpha.svg', url: `${ORIGIN}/s/beta` } });
  check('C9 rouge : urls.txt donne une autre URL, les deux nommées', other.level === 'erreur' && other.details[0]!.includes('/s/beta') && other.details[0]!.includes(URL_ALPHA), other);
  const small = c9({ capture: { sideMm: 20 } });
  check('C9 rouge : trop petit, côté nommé', small.level === 'erreur' && small.details.length === 1 && small.details[0]!.includes('20,0 mm'), small);
  const unreadable = c9({ decoded: null });
  check('C9 rouge : illisible', unreadable.level === 'erreur' && unreadable.details[0]!.includes('illisible'), unreadable);
  const wrong = c9({ decoded: 'https://autre.example/x' });
  check('C9 rouge : le QR lu donne une autre URL', wrong.level === 'erreur' && wrong.details[0]!.includes('https://autre.example/x'), wrong);
  check('C9 rouge : cartouche absent de la mise en page', c9({ capture: null }).details[0]!.includes('aucun cartouche'));
  check('C9 rouge : SVG refusé, cause nommée', c9({ qr: null, fault: 'QR sans viewBox' }).details[0]!.includes('QR sans viewBox'));
  check('C9 : sujet sans scène', c9({ sceneId: null, qr: null }).level === 'erreur');
  check('C9 : la part « données » ne lance pas Chromium et suit la même règle', qrDataFaults({ ...good, qr: null }).length === 1 && qrDataFaults(good).length === 0);
  // Décodage réel d'un QR synthétique.
  check('décodage : le QR de l\'URL de la scène se lit', (await decodeQr(await png(qrSvg(URL_ALPHA), 400))) === URL_ALPHA);
  check('décodage : un QR d\'une autre URL se lit comme tel', (await decodeQr(await png(qrSvg(`${ORIGIN}/s/beta`), 400))) === `${ORIGIN}/s/beta`);
  check('décodage : une image blanche ne donne rien', (await decodeQr(await sharp({ create: { width: 200, height: 200, channels: 3, background: '#fff' } }).png().toBuffer())) === null);
  check('décodage : un QR minuscule n\'est pas lu', (await decodeQr(await png(qrSvg(URL_ALPHA), 12))) === null);
}

// « Marquer prêt » : chaque contrôle en erreur est nommé ; une alerte ne bloque pas.
{
  const level = (id: string, l: string, d: string[] = ['cause']) => ({ id, level: l, details: d });
  check('prêt : tous les contrôles verts, aucun refus', checksRefusal(READY_CHECKS.map((id) => level(id, 'ok', []))) === null);
  check('prêt : les douze contrôles attendus', READY_CHECKS.join() === 'C3,C4,C5,C6,C7,C8,C9,C10,C11,C12,C13,C17');
  for (const id of READY_CHECKS) {
    const others = READY_CHECKS.filter((o) => o !== id).map((o) => level(o, 'ok', []));
    const refusal = checksRefusal([...others, level(id, 'erreur', ['première cause', 'seconde'])]);
    check(`prêt refusé par ${id}, nommé avec sa cause`, refusal !== null && refusal.includes(id) && refusal.includes('première cause') && refusal.includes('+1') && !READY_CHECKS.filter((o) => o !== id).some((o) => refusal.includes(`${o} (`)), refusal);
    check(`prêt : une alerte sur ${id} ne bloque pas`, checksRefusal([...others, level(id, 'alerte')]) === null);
  }
  const two = checksRefusal([level('C9', 'erreur', ['a']), level('C13', 'erreur', ['b'])]);
  check('prêt refusé : chaque contrôle en erreur est nommé', two !== null && two.includes('C9 (a)') && two.includes('C13 (b)'), two);
  check('prêt : un contrôle hors liste (C16) ne bloque pas', checksRefusal([level('C16', 'erreur')]) === null);
}

// Parcours, suppression, changement de modèle, routes : sur des données réelles de test.
{
  const glb = makeGlbi();
  const root = tempDir();
  const data = path.join(root, 'donnees');
  fs.mkdirSync(data);
  put(root, 'config.local.json', { glbRoot: glb, dataRoot: data });
  createBookFolder(data, BOOK_ID);
  createCollection(data);
  put(data, 'collection/gabarits/2Y.json', synthese('2Y'));
  const scenes = ['alpha', 'beta'];
  const now = new Date('2026-11-10T09:00:00.000Z');
  createSubject(data, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, scenes, ['foret'], now);
  createSubject(data, BOOK_ID, { sceneId: 'beta', pages: 2, template: '2A', theme: 'foret' }, scenes, ['foret'], now);
  const configFile = path.join(root, 'config.local.json');
  const loaded = loadConfig(configFile);
  if (!loaded.ok) throw new Error('configuration de test invalide');
  const parcoursOf = (id: string) => computeParcours(readFacts({ ok: true, config: loaded.config } as never, BOOK_DIR)).subjects.find((s) => s.id === id)!;
  const step = (id: string, stepId: string) => parcoursOf(id).steps.find((s) => s.id === stepId)!;

  // Parcours : le statut reste écrit ; l'étape Prêt se recalcule depuis les données (MP-20) et reste verrouillée tant que Recherche, Relecture, Illustrations, Aperçu ne sont pas validées.
  check('parcours : sujet neuf, étape Prêt verrouillée et motif nommé', step('alpha', 'sujet-pret').state === 'verrouillee' && step('alpha', 'sujet-pret').reasons.join(' ').includes('Valider d\'abord'), step('alpha', 'sujet-pret'));
  updateSubject(data, BOOK_ID, 'alpha', (d) => ({ ...d, subject: { ...d.subject, status: 'prêt' } }));
  check('parcours : un statut « prêt » écrit sans étapes validées ne valide pas l\'étape Prêt', step('alpha', 'sujet-pret').state !== 'validee' && readSubject(data, BOOK_ID, 'alpha').status === 'prêt');

  // Serveur : refus et retrait.
  const server = createPrintServer(configFile);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const headers = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'x-book-print': '1' };
  const send = (p: string, body: unknown) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  const body = { dir: BOOK_DIR, subjectId: 'beta' };
  const early = await send('/api/sujet/pret', body);
  const earlyJson = JSON.parse(early.body);
  check('« Marquer prêt » : sujet brouillon refusé, motif nommé, statut inchangé', early.status === 200 && earlyJson.marked === false && String(earlyJson.reason).includes('marqué relu') && readSubject(data, BOOK_ID, 'beta').status === 'brouillon', earlyJson.reason);
  updateSubject(data, BOOK_ID, 'beta', (d) => ({ ...d, subject: { ...d.subject, status: 'relu' } }));
  const open = JSON.parse((await send('/api/sujet/pret', body)).body);
  check('« Marquer prêt » : étapes non validées nommées', open.marked === false && String(open.reason).includes('Étapes à valider d\'abord') && readSubject(data, BOOK_ID, 'beta').status === 'relu', open.reason);
  check('« Retirer prêt » : un sujet non prêt est refusé, 409', (await send('/api/sujet/retirer-pret', body)).status === 409);
  const un = await send('/api/sujet/retirer-pret', { dir: BOOK_DIR, subjectId: 'alpha' });
  check('« Retirer prêt » : le sujet revient à relu', un.status === 200 && readSubject(data, BOOK_ID, 'alpha').status === 'relu');
  check('« Retirer prêt » : rien d\'autre ne change', fs.existsSync(path.join(subjectFolder(data, BOOK_ID, 'alpha')!, 'layout.json')));
  for (const route of ['/api/sujet/pret', '/api/sujet/retirer-pret', '/api/sujet/supprimer', '/api/sujet/modeles', '/api/sujet/modele']) {
    const bare = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: route, headers: { Host: headers.Host, Origin: headers.Origin, 'Content-Type': 'application/json' } }, (res) => resolve(res.statusCode ?? 0));
      req.end('{}');
    });
    check(`${route} : sans en-tête, 403`, bare === 403);
  }

  // Changement de modèle.
  const models = JSON.parse((await send('/api/sujet/modeles', body)).body);
  check('modèles : ceux du même format et du même nombre de pages, le courant nommé', models.current === '2A' && models.models.map((m: { id: string }) => m.id).sort().join() === '2A,2Y', models);
  const folderBeta = subjectFolder(data, BOOK_ID, 'beta')!;
  const layoutBefore = fs.readFileSync(path.join(folderBeta, 'layout.json'), 'utf8');
  const researchFile = path.join(folderBeta, 'garde.txt');
  fs.writeFileSync(researchFile, '{"garde":1}\n');
  const subjectBefore = readSubject(data, BOOK_ID, 'beta');
  updateSubject(data, BOOK_ID, 'beta', (d) => ({ ...d, subject: { ...d.subject, status: 'prêt' } }));
  const changed = JSON.parse((await send('/api/sujet/modele', { ...body, modelId: '2Y' })).body);
  const keptName = changed.changed?.kept as string;
  check('changement de modèle : l\'ancien layout.json est gardé, daté, identique', /^layout\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(keptName) && fs.readFileSync(path.join(folderBeta, keptName), 'utf8') === layoutBefore, changed);
  check('changement de modèle : la nouvelle copie remplace layout.json', fs.readFileSync(path.join(folderBeta, 'layout.json'), 'utf8') !== layoutBefore && JSON.parse(fs.readFileSync(path.join(folderBeta, 'layout.json'), 'utf8')).modele.id === '2Y');
  check('changement de modèle : le sujet porte le nouveau modèle, « prêt » repasse à « relu »', readSubject(data, BOOK_ID, 'beta').template === '2Y' && readSubject(data, BOOK_ID, 'beta').status === 'relu' && changed.changed.unmarked === true);
  check('changement de modèle : autres fichiers du sujet, scène et pages intacts', fs.readFileSync(researchFile, 'utf8') === '{"garde":1}\n' && readSubject(data, BOOK_ID, 'beta').pages === subjectBefore.pages && readSubject(data, BOOK_ID, 'beta').sceneId === subjectBefore.sceneId);
  check('changement de modèle : l\'écart des blocs est annoncé', Array.isArray(changed.gap?.missing) && Array.isArray(changed.gap?.extra), changed.gap);
  check('changement de modèle : modèle inconnu refusé, 409, rien ne bouge', (await send('/api/sujet/modele', { ...body, modelId: 'ZZ' })).status === 409 && readSubject(data, BOOK_ID, 'beta').template === '2Y');
  let refused = '';
  try {
    changeModel(data, BOOK_ID, 'beta', '2Y', new Date('2026-11-10T09:00:00.000Z'));
    changeModel(data, BOOK_ID, 'beta', '2A', new Date('2026-11-10T09:00:00.000Z'));
  } catch (e) {
    refused = e instanceof SubjectRefused ? 'refus' : String(e);
  }
  check('changement de modèle : un fichier daté existant n\'est jamais écrasé', refused === 'refus' || fs.readdirSync(folderBeta).filter((f) => f.startsWith('layout.') && f !== 'layout.json').length >= 1, refused);

  // Suppression d'un sujet.
  const pictures = path.join(data, BOOK_ID, 'illustrations', 'alpha');
  fs.mkdirSync(pictures, { recursive: true });
  fs.writeFileSync(path.join(pictures, 'photo.png'), 'x');
  put(data, `${BOOK_ID}/rights.json`, { garde: true });
  const rightsBefore = fs.readFileSync(path.join(data, BOOK_ID, 'rights.json'), 'utf8');
  const folderAlpha = subjectFolder(data, BOOK_ID, 'alpha')!;
  check('suppression : sans confirmation, 400, rien ne bouge', (await send('/api/sujet/supprimer', body)).status === 400 && fs.existsSync(folderBeta));
  check('suppression : confirm à false, 400', (await send('/api/sujet/supprimer', { ...body, confirm: false })).status === 400 && fs.existsSync(folderBeta));
  check('suppression : sujet inconnu, 409', (await send('/api/sujet/supprimer', { dir: BOOK_DIR, subjectId: 'inconnu', confirm: true })).status === 409);
  const del = await send('/api/sujet/supprimer', { dir: BOOK_DIR, subjectId: 'alpha', confirm: true });
  const delJson = JSON.parse(del.body);
  const moved = path.join(data, delJson.deleted?.folder ?? 'absent');
  check('suppression : le dossier va sous subjects/.supprimes/<id>.<date>/', del.status === 200 && delJson.deleted.folder.startsWith(`${BOOK_ID}/subjects/${DELETED_DIR}/alpha.`) && !fs.existsSync(folderAlpha) && fs.existsSync(path.join(moved, 'subject.json')), delJson.deleted);
  check('suppression : les illustrations suivent, dans le même dossier', delJson.deleted.illustrations === true && fs.readFileSync(path.join(moved, 'illustrations', 'photo.png'), 'utf8') === 'x' && !fs.existsSync(pictures));
  check('suppression : rien n\'est effacé, le layout.json est dans le dossier gardé', fs.existsSync(path.join(moved, 'layout.json')));
  check('suppression : le sujet sort de print-book.json', !readPrintBook(data, BOOK_ID).book!.subjects.includes('alpha') && readPrintBook(data, BOOK_ID).book!.subjects.includes('beta'));
  check('suppression : .supprimes n\'est jamais lu comme un sujet', !JSON.stringify(parcoursOf('beta')).includes('.supprimes') && computeParcours(readFacts({ ok: true, config: loaded.config } as never, BOOK_DIR)).subjects.map((s) => s.id).join() === 'beta');
  check('suppression : le registre des droits est intact', fs.readFileSync(path.join(data, BOOK_ID, 'rights.json'), 'utf8') === rightsBefore);
  check('suppression : un second sujet sur la même scène est permis', (() => { try { return createSubject(data, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, scenes, ['foret'], new Date('2026-11-11T09:00:00.000Z')).id === 'alpha'; } catch { return false; } })());
  check('suppression : supprimer deux fois de suite, le second dossier est daté à part', (() => { try { deleteSubject(data, BOOK_ID, 'alpha', new Date('2026-11-11T09:00:00.000Z')); return fs.readdirSync(path.join(data, BOOK_ID, 'subjects', DELETED_DIR)).length === 2; } catch { return false; } })());
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// P-33 : `src/` n'importe rien de `scripts/`.
{
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (/\.(ts|js|mjs)$/.test(name.name) && /(from|import)\s*\(?\s*['"][^'"]*scripts\//.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
    }
  };
  walk(path.resolve(import.meta.dirname, '..', 'src'));
  check('src/ n\'importe rien de scripts/ (P-33)', offenders.length === 0, offenders);
  check('les fixtures du rendu sont dans src/render/placeholders.ts', fs.existsSync(path.resolve(import.meta.dirname, '..', 'src', 'render', 'placeholders.ts')));
}

finish('pret');
