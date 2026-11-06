// scripts/test-create.ts — création du dossier d'un livre : contenu, pas d'écrasement, aucune écriture hors de dataRoot.
import fs from 'node:fs';
import path from 'node:path';
import { CollectionRefused, createCollection, readCollection, svgFault } from '../src/data/collection';
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

// Collection : copie des valeurs par défaut, sans écrasement
{
  const data = tempDir();
  check('collection absente : null', readCollection(data) === null);
  const made = createCollection(data);
  for (const rel of ['collection/style.json', 'collection/rights.json', 'collection/pictos/taille.svg', 'collection/pictos/poids.svg', 'collection/pictos/epoque.svg', 'collection/pictos/regime.svg', 'collection/pictos/lieu.svg']) {
    check(`collection créée : ${rel}`, exists(data, rel) && made.created.includes(rel), made);
  }
  const read1 = readCollection(data)!;
  check('collection lue : 5 pictogrammes', Object.keys(read1.pictos).length === 5 && read1.pictos.taille!.includes('viewBox'));
  check('droits lus', read1.rights.entries.some((e) => e.id === 'pictos-maison'));

  put(data, 'collection/style.json', '{"modifie": "par David"}\n');
  put(data, 'collection/pictos/taille.svg', '<svg modifie="par David"/>\n');
  fs.rmSync(path.join(data, 'collection', 'rights.json'));
  const again = createCollection(data);
  check('seconde création : style.json intact', read(data, 'collection/style.json').includes('par David'));
  check('seconde création : pictogramme intact', read(data, 'collection/pictos/taille.svg').includes('par David'));
  check('seconde création : le fichier manquant revient, seul', again.created.join() === 'collection/rights.json', again);
  check('seconde création : le reste est conservé', again.kept.includes('collection/style.json') && again.kept.includes('collection/pictos/lieu.svg'), again);

  const refusedRead = (name: string, text: string) => {
    try {
      readCollection(data);
      check(name, false);
    } catch (e) {
      check(name, e instanceof CollectionRefused && e.message.includes(text), (e as Error).message);
    }
  };
  refusedRead('style.json invalide : message, fichier gardé', 'collection/style.json invalide');
  check('style.json invalide : jamais remplacé', read(data, 'collection/style.json').includes('par David'));
  put(data, 'collection/style.json', '{');
  refusedRead('style.json illisible', 'JSON valide');
  fs.rmSync(path.join(data, 'collection', 'style.json'));
  refusedRead('style.json absent', 'absent');
  createCollection(data);
  refusedRead('pictogramme invalide', 'Pictogramme taille');
  fs.rmSync(path.join(data, 'collection', 'pictos', 'taille.svg'));
  refusedRead('pictogramme absent', 'pictos/taille.svg absent');
  createCollection(data);
  const style = JSON.parse(read(data, 'collection/style.json'));
  style.pictos.taille.rights = 'inconnu';
  put(data, 'collection/style.json', style);
  refusedRead('pictogramme sans entrée de droits', 'droits inconnu');
  style.pictos.taille.rights = 'pictos-maison';
  style.palette.themes.nuit = '#123456';
  style.pictos.vitesse = { file: 'vitesse.svg', rights: 'pictos-maison' };
  style.fiche.push({ id: 'vitesse', picto: 'vitesse', label: { fr: 'Vitesse', en: 'Speed', es: 'Velocidad' } });
  put(data, 'collection/style.json', style);
  put(data, 'collection/pictos/vitesse.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24"/></svg>');
  const tuned = readCollection(data)!;
  check('paramétrage : nouveau thème, pictogramme et information lus sans rien changer au code', 'nuit' in tuned.style.palette.themes && 'vitesse' in tuned.pictos && tuned.style.fiche.length === 6);

  const linked = tempDir();
  const elsewhere = tempDir();
  dirLink(elsewhere, path.join(linked, 'collection'));
  let linkRefused = false;
  try {
    createCollection(linked);
  } catch (e) {
    linkRefused = e instanceof CreateRefused;
  }
  check('collection/ par lien refusée', linkRefused && fs.readdirSync(elsewhere).length === 0);
  try {
    readCollection(linked);
    check('lecture de collection/ par lien refusée', false);
  } catch (e) {
    check('lecture de collection/ par lien refusée', e instanceof CollectionRefused);
  }
}

// SVG d'un pictogramme : il va tel quel dans le HTML imprimé
{
  const good = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0"/></svg>';
  check('SVG admis', svgFault(good) === null);
  check('SVG refusé : pas un SVG', svgFault('<div></div>') !== null);
  check('SVG refusé : prologue XML', svgFault(`<?xml version="1.0"?>${good}`) !== null);
  check('SVG refusé : sans viewBox', svgFault('<svg><path/></svg>') !== null);
  for (const [name, inner] of [['script', '<script>x</script>'], ['image', '<image/>'], ['foreignObject', '<foreignObject/>'], ['style', '<style>a{}</style>'], ['use', '<use/>'], ['événement', '<path onclick="x"/>'], ['lien', '<a href="x"/>']] as const) {
    check(`SVG refusé : ${name}`, svgFault(`<svg viewBox="0 0 1 1">${inner}</svg>`) !== null);
  }
}

finish('création du dossier');
