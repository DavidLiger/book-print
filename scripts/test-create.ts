// scripts/test-create.ts — création du dossier d'un livre : contenu, pas d'écrasement, aucune écriture hors de dataRoot.
import fs from 'node:fs';
import path from 'node:path';
import { CreateRefused, createBookFolder, DATA_GITIGNORE } from '../src/data/create-book';
import { printBookSchema } from '../src/schema/print-book';
import { fileLink, dirLink, put, tempDir } from './fixtures/make-glbi';
import { check, finish } from './test-lib';

const exists = (root: string, rel: string) => fs.existsSync(path.join(root, ...rel.split('/')));
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const tree = (root: string) => fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).sort();

// Création
const root = tempDir();
const first = createBookFolder(root, 'dinosaures');
for (const rel of ['dinosaures/print-book.json', 'dinosaures/rights.json', '.gitignore', 'dinosaures/subjects/', 'dinosaures/illustrations/', 'dinosaures/export/']) {
  check(`créé : ${rel}`, exists(root, rel) && first.created.includes(rel), first);
}
check('rien de conservé à la première création', first.kept.length === 0, first);
check('print-book.json valide', printBookSchema.safeParse(JSON.parse(read(root, 'dinosaures/print-book.json'))).success);
check('bookId écrit', JSON.parse(read(root, 'dinosaures/print-book.json')).bookId === 'dinosaures');
check('registre des droits vide', JSON.parse(read(root, 'dinosaures/rights.json')).entries.length === 0);
check('.gitignore des données complet', DATA_GITIGNORE.every((l) => read(root, '.gitignore').split('\n').includes(l)));
check('aucune alerte', first.alerts.length === 0, first.alerts);

// Pas d'écrasement
put(root, 'dinosaures/print-book.json', '{"modifie": "par David"}\n');
put(root, 'dinosaures/rights.json', '{"modifie": "par David"}\n');
const treeBefore = tree(root);
const second = createBookFolder(root, 'dinosaures');
check('seconde création : print-book.json intact', read(root, 'dinosaures/print-book.json').includes('par David'));
check('seconde création : rights.json intact', read(root, 'dinosaures/rights.json').includes('par David'));
check('seconde création : rien de créé', second.created.length === 0, second);
check('seconde création : tout conservé', second.kept.length === 7, second);
check('seconde création : arborescence inchangée', tree(root).join() === treeBefore.join());

// Deuxième livre : le .gitignore commun reste, le reste se crée.
const other = createBookFolder(root, 'avions');
check('autre livre créé à côté', exists(root, 'avions/print-book.json') && other.kept.includes('.gitignore'), other);

// Motif de GLBInterpreter : majuscules et _ admis pour un bookId.
{
  const r = tempDir();
  check('bookId avec majuscule et _ créé', createBookFolder(r, 'Livre_1').created.includes('Livre_1/print-book.json'));
}

// .gitignore existant
{
  const r = tempDir();
  put(r, '.gitignore', 'perso\n');
  const res = createBookFolder(r, 'livre');
  check('.gitignore existant intact', read(r, '.gitignore') === 'perso\n');
  check('.gitignore incomplet signalé', res.alerts.length === 1, res.alerts);
}

// Aucune écriture hors de dataRoot
const refuses = (name: string, f: () => void) => {
  try {
    f();
    check(`refus : ${name}`, false);
  } catch (e) {
    check(`refus : ${name}`, e instanceof CreateRefused, String(e));
  }
};
{
  const parent = tempDir();
  const r = path.join(parent, 'data');
  fs.mkdirSync(r);
  for (const id of ['../dehors', '..', 'a/b', 'a\\b', '', '.', 'CON', 'collection', 'Collection']) {
    refuses(`bookId ${JSON.stringify(id)}`, () => createBookFolder(r, id));
  }
  check('rien d’écrit à côté de dataRoot', tree(parent).join() === 'data');
  check('rien d’écrit dans dataRoot', tree(r).length === 0);
}
{
  const r = tempDir();
  const outside = tempDir();
  dirLink(outside, path.join(r, 'livre'));
  refuses('dossier du livre : lien hors de dataRoot', () => createBookFolder(r, 'livre'));
  check('lien : rien d’écrit dehors', tree(outside).length === 0);
}
{
  const r = tempDir();
  const outside = tempDir();
  fs.mkdirSync(path.join(r, 'livre'));
  dirLink(outside, path.join(r, 'livre', 'export'));
  refuses('sous-dossier : lien hors de dataRoot', () => createBookFolder(r, 'livre'));
  check('sous-dossier : rien d’écrit dehors', tree(outside).length === 0);
}
{
  const r = tempDir();
  const outside = tempDir();
  fs.mkdirSync(path.join(r, 'livre'));
  if (fileLink(path.join(outside, 'cible.json'), path.join(r, 'livre', 'print-book.json'))) {
    const res = createBookFolder(r, 'livre');
    check('fichier : un lien n’est jamais suivi', tree(outside).length === 0 && res.kept.includes('livre/print-book.json'), res);
  }
}
{
  const r = tempDir();
  put(r, 'livre', 'un fichier');
  refuses('le nom du livre est un fichier', () => createBookFolder(r, 'livre'));
  check('fichier gênant intact', read(r, 'livre') === 'un fichier');
}

finish('création du dossier');
