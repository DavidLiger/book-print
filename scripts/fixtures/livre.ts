// scripts/fixtures/livre.ts — cadre de synthèse d'un livre de test (MP6a) : 5 pages liminaires vides (une copie de 5 pages, à droite) et une
// page de secours vide à la fin. Les sujets commencent ainsi en page 6, comme avant le plan réel, et un livre aux sujets pairs reste pair.
import fs from 'node:fs';
import path from 'node:path';

export const LIMINAIRES = 'liminaires';
export const SECOURS = 'secours';

const modele = { id: '5A', empreinte: '0'.repeat(64), date: '2026-11-17T00:00:00.000Z' };

export function cadreLivre(dataRoot: string, bookId: string): void {
  const bookFile = path.join(dataRoot, bookId, 'print-book.json');
  const book = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
  const trim = book.edition.trim;
  const write = (id: string, pages: number, start: 'gauche' | 'droite') => {
    const dir = path.join(dataRoot, bookId, 'pages', id);
    fs.mkdirSync(dir, { recursive: true });
    const layout = { schemaVersion: 2, id: `${pages}A`, pages, start, trim, elements: [], modele: { ...modele, id: `${pages}A` } };
    fs.writeFileSync(path.join(dir, 'layout.json'), `${JSON.stringify(layout, null, 2)}\n`);
  };
  write(LIMINAIRES, 5, 'droite');
  write(SECOURS, 1, 'gauche');
  fs.writeFileSync(bookFile, `${JSON.stringify({ ...book, frontMatter: [LIMINAIRES], backMatter: [SECOURS] }, null, 2)}\n`);
}
