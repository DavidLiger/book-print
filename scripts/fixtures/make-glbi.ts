// scripts/fixtures/make-glbi.ts — faux repo GLBInterpreter et faux dossier de données, dans un dossier temporaire.
// Données synthétiques : aucun contenu réel. Depuis ED6, les SVG de `dist/qr/` sont de vrais QR, fabriqués par `qr-encode.ts` : ils portent l'URL de leur scène.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { qrSvg } from './qr-encode';

export const BOOK_DIR = 'livre-test';
export const BOOK_ID = 'livre-test';
export const ORIGIN = 'https://livre-test.example';

const name = (t: string) => ({ fr: `${t} fr`, en: `${t} en`, es: `${t} es` });

const temps: string[] = [];
process.on('exit', () => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true, maxRetries: 3 });
});

/** Dossier temporaire, retiré à la fin du test. */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'book-print-'));
  temps.push(dir);
  return dir;
}

/** Lien de dossier : `junction` n'exige aucun droit sous Windows, le type est ignoré ailleurs. */
export function dirLink(target: string, link: string): void {
  fs.symlinkSync(target, link, 'junction');
}

/** Lien de fichier : sous Windows, il exige le mode développeur. Sans lui, le test qui en dépend est sauté et annoncé. */
export function fileLink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
    console.log(`test sauté (lien de fichier non autorisé sur cette machine) : ${path.basename(link)}`);
    return false;
  }
}

export function put(root: string, rel: string, content: string | object): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

export const bookJson = () => ({
  bookId: BOOK_ID,
  title: name('Livre'),
  languages: ['fr', 'en', 'es'],
  scenes: ['alpha', 'beta'],
  origin: ORIGIN,
  legal: { year: 2026, text: name('Mentions') },
  game: { template: 'test' },
});

export const urlsTxt = () => `01-alpha.svg\t${ORIGIN}/s/alpha\n02-beta.svg\t${ORIGIN}/s/beta\njeu.svg\t${ORIGIN}/jeu\n`;

const scene = (id: string) => ({ scene: { id, name: name(id) }, build: { glb: `scenes/${id}.glb`, modelCredits: [{ name: 'Modèle', author: 'Auteur', license: 'CC0' }] } });

/** Livre valide, avec jeu : chaque test en casse un seul point. */
export function makeGlbi(): string {
  const root = tempDir();
  put(root, `books/${BOOK_DIR}/book.json`, bookJson());
  put(root, 'out/book.json', { ...bookJson(), files: [] });
  put(root, 'out/scenes/alpha.json', scene('alpha'));
  put(root, 'out/scenes/beta.json', scene('beta'));
  const qr: Record<string, string> = { '01-alpha.svg': `${ORIGIN}/s/alpha`, '02-beta.svg': `${ORIGIN}/s/beta`, 'jeu.svg': `${ORIGIN}/jeu` };
  for (const [f, url] of Object.entries(qr)) put(root, `dist/qr/${BOOK_ID}/${f}`, `${qrSvg(url)}\n`);
  put(root, `dist/qr/${BOOK_ID}/urls.txt`, urlsTxt());
  // Le dossier d'essai existe chez David : il ne doit jamais être lu.
  put(root, `dist/qr-essai/${BOOK_ID}/alpha.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(root, 'books', BOOK_DIR, 'book.json'), past, past);
  return root;
}
