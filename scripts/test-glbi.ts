// scripts/test-glbi.ts — lecture de GLBInterpreter : tous les garde-fous du §3.6, sur un faux repo.
import fs from 'node:fs';
import path from 'node:path';
import { PathMissing, PathRefused, resolveUnder } from '../src/glbi/paths';
import { listBooks, readBook } from '../src/glbi/read';
import { BOOK_DIR, BOOK_ID, bookJson, dirLink, fileLink, makeGlbi, ORIGIN, put, tempDir, urlsTxt } from './fixtures/make-glbi';
import { check, finish } from './test-lib';

const qr = (f = '') => `dist/qr/${BOOK_ID}/${f}`;
const has = (list: string[], text: string) => list.some((l) => l.includes(text));

/** Prépare un faux repo, casse un point, attend une erreur contenant `text`. */
function refused(name: string, text: string, breakIt: (root: string) => void): void {
  const root = makeGlbi();
  breakIt(root);
  const r = readBook(root, BOOK_DIR);
  check(`refus : ${name}`, has(r.errors, text), r.errors);
}
const rm = (root: string, rel: string) => fs.rmSync(path.join(root, ...rel.split('/')), { recursive: true });
const urls = (root: string, content: string) => put(root, qr('urls.txt'), content);
const book = (root: string, change: (b: Record<string, unknown>) => void) => {
  const b = bookJson() as Record<string, unknown>;
  change(b);
  put(root, `books/${BOOK_DIR}/book.json`, b);
};

// Cas valide
{
  const root = makeGlbi();
  const r = readBook(root, BOOK_DIR);
  check('livre valide : aucune erreur', r.errors.length === 0, r.errors);
  check('livre valide : aucune alerte', r.alerts.length === 0, r.alerts);
  check('bookId et origin lus', r.bookId === BOOK_ID && r.origin === ORIGIN);
  check('titre lu dans scene.name', r.scenes[0].title?.es === 'alpha es');
  check('crédits lus dans build.modelCredits', r.scenes[1].modelCredits.length === 1);
  check('QR préfixé par son rang', r.scenes[1].qr?.file === '02-beta.svg' && r.scenes[1].rank === 2);
  check('QR du jeu lu', r.gameQr?.url === `${ORIGIN}/jeu`);
  const list = listBooks(root);
  check('liste : le livre construit est signalé', list.length === 1 && list[0].built && list[0].dir === BOOK_DIR, list);
  urls(root, urlsTxt().replace(/\n/g, '\r\n'));
  check('urls.txt en fin de ligne Windows admis', readBook(root, BOOK_DIR).errors.length === 0);
}
{
  const root = makeGlbi();
  put(root, 'books/brouillon/notes.txt', 'pas un livre');
  check('dossier sans book.json ignoré', listBooks(root).length === 1);
  put(root, 'books/casse/book.json', '{');
  const list = listBooks(root);
  check('book.json illisible signalé dans la liste', list.some((b) => b.dir === 'casse' && b.error !== null), list);
  put(root, 'out/book.json', { bookId: BOOK_ID, scenes: [], fixture: true });
  check('une cartouche fixture n’est pas le dernier build', !listBooks(root).some((b) => b.built));
}

// Identifiants (motif de GLBInterpreter) et dossier du livre distinct du bookId
{
  const root = makeGlbi();
  fs.renameSync(path.join(root, 'books', BOOK_DIR), path.join(root, 'books', 'mon_dossier'));
  const r = readBook(root, 'mon_dossier');
  check('dossier du livre différent du bookId', r.errors.length === 0 && r.dir === 'mon_dossier' && r.bookId === BOOK_ID, r.errors);
  const list = listBooks(root);
  check('liste : dossier et bookId distincts', list[0].dir === 'mon_dossier' && list[0].bookId === BOOK_ID && list[0].built, list);
}
{
  const root = makeGlbi();
  const b = { ...bookJson(), bookId: 'Livre_1', scenes: ['Scene_A', 'beta'] };
  put(root, `books/${BOOK_DIR}/book.json`, b);
  put(root, 'out/book.json', { ...b, files: [] });
  const scene = JSON.parse(fs.readFileSync(path.join(root, 'out/scenes/alpha.json'), 'utf8'));
  scene.scene.id = 'Scene_A';
  put(root, 'out/scenes/Scene_A.json', scene);
  fs.renameSync(path.join(root, 'dist', 'qr', BOOK_ID), path.join(root, 'dist', 'qr', 'Livre_1'));
  fs.renameSync(path.join(root, 'dist', 'qr', 'Livre_1', '01-alpha.svg'), path.join(root, 'dist', 'qr', 'Livre_1', '01-Scene_A.svg'));
  put(root, 'dist/qr/Livre_1/urls.txt', urlsTxt().replace('01-alpha.svg', '01-Scene_A.svg').replace('/s/alpha', '/s/Scene_A'));
  const r = readBook(root, BOOK_DIR);
  check('majuscules et _ admis dans bookId et sceneId', r.errors.length === 0 && r.bookId === 'Livre_1' && r.scenes[0].qr?.file === '01-Scene_A.svg', r.errors);
}

// book.json source
refused('book.json absent', 'absent', (r) => rm(r, `books/${BOOK_DIR}/book.json`));
refused('book.json invalide', 'scenes', (r) => book(r, (b) => (b.scenes = [])));
refused('bookId réservé : collection', 'réservé', (r) => book(r, (b) => (b.bookId = 'collection')));
refused('scène en double', 'en double', (r) => book(r, (b) => (b.scenes = ['alpha', 'alpha'])));
refused('origin avec / final', 'origin', (r) => book(r, (b) => (b.origin = `${ORIGIN}/`)));
{
  const r = readBook(makeGlbi(), '../dehors');
  check('refus : dossier de livre hors de books/', has(r.errors, 'refusé'), r.errors);
}

// out/
refused('out/book.json absent', 'construire le livre', (r) => rm(r, 'out/book.json'));
refused('bookId différent', 'pas « livre-test »', (r) => put(r, 'out/book.json', { ...bookJson(), bookId: 'autre' }));
refused('fixture: true', 'cartouche de test', (r) => put(r, 'out/book.json', { ...bookJson(), fixture: true }));
refused('scène non construite', 'alpha.json', (r) => rm(r, 'out/scenes/alpha.json'));
refused('scène sans scene.name', 'alpha.json', (r) => put(r, 'out/scenes/alpha.json', { scene: { id: 'alpha' }, build: { modelCredits: [] } }));
refused('scène portant un autre id', 'porte la scène', (r) => put(r, 'out/scenes/alpha.json', JSON.parse(fs.readFileSync(path.join(r, 'out/scenes/beta.json'), 'utf8'))));

// QR
refused('URL hors origin', 'hors de origin', (r) => urls(r, urlsTxt().replace(`${ORIGIN}/s/alpha`, 'https://autre.example/s/alpha')));
refused('URL d’un domaine qui prolonge origin', 'hors de origin', (r) => urls(r, urlsTxt().replace(`${ORIGIN}/s/alpha`, `${ORIGIN}.autre.fr/s/alpha`)));
refused('URL sous origin mais pas celle de la scène', 'attendu', (r) => urls(r, urlsTxt().replace('/s/alpha', '/s/beta')));
refused('URL d’un QR absente de urls.txt', 'absent de urls.txt', (r) => urls(r, urlsTxt().replace(/^01.*\n/, '')));
refused('ligne de urls.txt invalide', 'ligne invalide', (r) => urls(r, `sans-tabulation\n${urlsTxt()}`));
refused('chemin dans urls.txt', 'ligne invalide', (r) => urls(r, `../../qr-essai/livre-test/alpha.svg\t${ORIGIN}/s/alpha\n${urlsTxt()}`));
refused('urls.txt cite un fichier absent', 'fichier absent', (r) => urls(r, `${urlsTxt()}03-gamma.svg\t${ORIGIN}/s/gamma\n`));
refused('urls.txt en double', 'en double', (r) => urls(r, `${urlsTxt()}${urlsTxt()}`));
refused('urls.txt absent', 'QR illisibles', (r) => rm(r, qr('urls.txt')));
refused('dossier des QR absent', 'QR illisibles', (r) => rm(r, qr()));
refused('scène sans QR', 'sans QR', (r) => rm(r, qr('02-beta.svg')));
refused('QR sans scène', 'QR sans scène : 03-gamma.svg', (r) => put(r, qr('03-gamma.svg'), '<svg/>'));
refused('QR non préfixé', 'QR sans scène : alpha.svg', (r) => put(r, qr('alpha.svg'), '<svg/>'));
refused('QR au mauvais rang', 'mauvais rang', (r) => {
  fs.renameSync(path.join(r, qr('01-alpha.svg')), path.join(r, qr('03-alpha.svg')));
});
refused('scènes réordonnées après le build', 'mauvais rang', (r) => book(r, (b) => (b.scenes = ['beta', 'alpha'])));
refused('jeu.svg sans jeu', 'pas de jeu', (r) => book(r, (b) => delete b.game));
refused('jeu sans jeu.svg', 'jeu.svg attendu', (r) => rm(r, qr('jeu.svg')));
refused('jeu.svg vers une autre URL', 'attendu', (r) => urls(r, urlsTxt().replace('/jeu', '/autre')));
{
  const root = makeGlbi();
  book(root, (b) => delete b.game);
  rm(root, qr('jeu.svg'));
  urls(root, urlsTxt().replace(/^jeu.*\n/m, ''));
  const r = readBook(root, BOOK_DIR);
  check('livre sans jeu ni jeu.svg : valide', r.errors.length === 0 && r.gameQr === null, r.errors);
}

// Chemins
const throws = (name: string, type: new (m: string) => Error, f: () => void) => {
  try {
    f();
    check(name, false);
  } catch (e) {
    check(name, e instanceof type, String(e));
  }
};
{
  const root = makeGlbi();
  throws('refus : qr-essai', PathRefused, () => resolveUnder(root, `dist/qr-essai/${BOOK_ID}/alpha.svg`));
  throws('refus : QR-Essai, autre casse', PathRefused, () => resolveUnder(root, `dist/QR-Essai/${BOOK_ID}/alpha.svg`));
  throws('refus : ..', PathRefused, () => resolveUnder(root, 'out/../../dehors.json'));
  throws('refus : chemin absolu', PathRefused, () => resolveUnder(root, path.join(tempDir(), 'x.json')));
  throws('refus : lecteur Windows', PathRefused, () => resolveUnder(root, 'C:/Windows/win.ini'));
  throws('refus : anti-slash', PathRefused, () => resolveUnder(root, 'out\\book.json'));
  throws('fichier absent distingué', PathMissing, () => resolveUnder(root, 'out/rien.json'));
  check('chemin valide résolu', resolveUnder(root, 'out/book.json').endsWith(path.join('out', 'book.json')));

  const outside = tempDir();
  put(outside, 'secret.json', {});
  dirLink(outside, path.join(root, 'out', 'lien'));
  throws('refus : lien qui sort de la racine', PathRefused, () => resolveUnder(root, 'out/lien/secret.json'));
  dirLink(path.join(root, 'dist', 'qr-essai'), path.join(root, 'dist', 'essai'));
  throws('refus : lien vers qr-essai', PathRefused, () => resolveUnder(root, `dist/essai/${BOOK_ID}/alpha.svg`));

  // Système de fichiers insensible à la casse (Windows), simulé : `realpath` rend la casse réelle.
  const windowsLike = (p: string) => (p.includes(`${path.sep}Out${path.sep}`) ? p.replace(`${path.sep}Out${path.sep}`, `${path.sep}out${path.sep}`) : p);
  throws('refus : casse différente de la casse réelle', PathRefused, () => resolveUnder(root, 'Out/book.json', windowsLike));
  check('casse réelle admise', resolveUnder(root, 'out/book.json', windowsLike).length > 0);
}
{
  const root = makeGlbi();
  const outside = tempDir();
  put(outside, 'book.json', { ...bookJson(), files: [] });
  rm(root, 'out/book.json');
  if (fileLink(path.join(outside, 'book.json'), path.join(root, 'out', 'book.json'))) {
    const r = readBook(root, BOOK_DIR);
    check('refus : out/book.json hors de la racine', has(r.errors, 'hors de la racine'), r.errors);
  }
}
{
  const root = makeGlbi();
  put(root, `dist/qr/${BOOK_ID}/qr-essai.svg`, '<svg/>');
  check('refus : fichier qr-essai parmi les QR', has(readBook(root, BOOK_DIR).errors, "QR d'essai"));
}
{
  const root = makeGlbi();
  book(root, (b) => (b.bookId = 'qr-essai'));
  put(root, 'out/book.json', { ...bookJson(), bookId: 'qr-essai' });
  const r = readBook(root, BOOK_DIR);
  check('refus : bookId qui mène à qr-essai', has(r.errors, "QR d'essai"), r.errors);
}

// Alertes
const alerted = (name: string, text: string, change: (root: string) => void) => {
  const root = makeGlbi();
  change(root);
  const r = readBook(root, BOOK_DIR);
  check(`alerte : ${name}`, r.errors.length === 0 && has(r.alerts, text), { e: r.errors, a: r.alerts });
};
alerted('book.json plus récent que le build', 'plus récent', (r) => fs.utimesSync(path.join(r, 'books', BOOK_DIR, 'book.json'), new Date(), new Date(Date.now() + 60_000)));
alerted('scène sans crédit', 'sans crédit', (r) => put(r, 'out/scenes/beta.json', { scene: { id: 'beta', name: { fr: 'b', en: 'b', es: 'b' } }, build: { modelCredits: [] } }));
alerted('fichier inattendu parmi les QR', 'inattendu', (r) => put(r, qr('notes.txt'), 'x'));
alerted('scènes différentes du build', 'différentes', (r) => put(r, 'out/book.json', { ...bookJson(), scenes: ['alpha'] }));

// Aucune écriture : ni dans le code du module, ni dans le faux repo pendant une lecture.
{
  const dir = path.join(import.meta.dirname, '..', 'src', 'glbi');
  const forbidden = /\b(write|append|mkdir|mkdtemp|rm|rmdir|unlink|rename|copy|cp|truncate|utimes|chmod|chown|symlink|link|open|createWriteStream)(File)?(Sync)?\s*\(/;
  for (const f of fs.readdirSync(dir)) check(`aucune écriture dans src/glbi/${f}`, !forbidden.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  const snapshot = (root: string) => fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).sort().map((f) => {
    const s = fs.statSync(path.join(root, f));
    return `${f}:${s.size}:${s.mtimeMs}`;
  }).join('|');
  const root = makeGlbi();
  const before = snapshot(root);
  readBook(root, BOOK_DIR);
  listBooks(root);
  check('lecture : faux repo inchangé', snapshot(root) === before);
}

finish('lecture GLBI');
