// scripts/test-schema.ts — schémas print-book et subject : le cas valide, puis chaque refus.
import { printBookSchema, newPrintBook } from '../src/schema/print-book';
import { subjectSchema } from '../src/schema/subject';
import { check, finish } from './test-lib';

type Dict = Record<string, any>;
const book = (): Dict => structuredClone(newPrintBook('dinosaures'));
const subject = (): Dict => ({
  schemaVersion: 1,
  id: 't-rex',
  sceneId: 'Trex_1',
  title: {},
  pages: 4,
  template: '4B',
  variant: { mirror: false, theme: 'vert' },
  blocks: [],
  illustrations: [],
  status: 'brouillon',
});

const refused = (schema: { safeParse(v: unknown): { success: boolean } }, name: string, change: (v: Dict) => void, make: () => Dict) => {
  const v = make();
  change(v);
  check(`refus : ${name}`, !schema.safeParse(v).success, v);
};
const noBook = (name: string, change: (v: Dict) => void) => refused(printBookSchema, `print-book, ${name}`, change, book);
const noSubject = (name: string, change: (v: Dict) => void) => refused(subjectSchema, `subject, ${name}`, change, subject);

// print-book
check('print-book neuf valide', printBookSchema.safeParse(book()).success);
check('valeurs provisoires : 6 × 9, 46 pages', book().edition.trim.widthIn === 6 && book().edition.trim.heightIn === 9 && book().pageBudget === 46);
check('ISBN avec tirets admis', printBookSchema.safeParse({ ...book(), edition: { ...book().edition, isbn: '978-2-1234-5678-9' } }).success);
check('bookId au motif de GLBInterpreter admis', printBookSchema.safeParse({ ...book(), bookId: 'Livre_1' }).success);
noBook('version absente', (b) => delete b.schemaVersion);
noBook('version inconnue', (b) => (b.schemaVersion = 2));
noBook('clé inconnue', (b) => (b.autre = 1));
noBook('bookId invalide', (b) => (b.bookId = '../sortie'));
noBook('bookId réservé par Windows', (b) => (b.bookId = 'CON'));
noBook('bookId réservé : collection', (b) => (b.bookId = 'collection'));
noBook('bookId réservé : Collection, autre casse', (b) => (b.bookId = 'Collection'));
noBook('langue inconnue', (b) => (b.edition.lang = 'de'));
noBook('largeur nulle', (b) => (b.edition.trim.widthIn = 0));
noBook('hauteur manquante', (b) => delete b.edition.trim.heightIn);
noBook('sans fond perdu', (b) => (b.edition.bleed = false));
noBook('autre encre', (b) => (b.edition.ink = 'black'));
noBook('autre papier', (b) => (b.edition.paper = 'cream'));
noBook('ISBN invalide', (b) => (b.edition.isbn = '123'));
noBook('budget impair', (b) => (b.pageBudget = 47));
noBook('budget non entier', (b) => (b.pageBudget = 46.5));
noBook('budget nul', (b) => (b.pageBudget = 0));
noBook('sujet en double', (b) => (b.subjects = ['t-rex', 't-rex']));
noBook('identifiant de sujet invalide', (b) => (b.subjects = ['T Rex']));
noBook('page liminaire en double', (b) => (b.frontMatter = ['titre', 'titre']));
noBook('page finale en double', (b) => (b.backMatter = ['credits', 'credits']));

// subject
check('sujet valide', subjectSchema.safeParse(subject()).success);
check('sujet sans scène avec titre valide', subjectSchema.safeParse({ ...subject(), sceneId: undefined, title: { fr: 'Fossiles' } }).success);
noSubject('version absente', (s) => delete s.schemaVersion);
noSubject('clé inconnue', (s) => (s.autre = 1));
noSubject('id en majuscules', (s) => (s.id = 'T-Rex'));
noSubject('sceneId invalide', (s) => (s.sceneId = 'a/b'));
noSubject('titre vide', (s) => (s.title = { fr: ' ' }));
noSubject('langue de titre inconnue', (s) => (s.title = { de: 'Titel' }));
noSubject('sans scène ni titre', (s) => delete s.sceneId);
noSubject('pages = 3', (s) => (s.pages = 3));
noSubject('gabarit mal formé', (s) => (s.template = 'B4'));
noSubject('gabarit d’un autre nombre de pages', (s) => (s.template = '2A'));
noSubject('variante sans miroir', (s) => delete s.variant.mirror);
noSubject('thème invalide', (s) => (s.variant.theme = 'Vert Clair'));
noSubject('blocs non vides avant MP3', (s) => (s.blocks = [{}]));
noSubject('illustrations non vides avant MP4', (s) => (s.illustrations = [{}]));
noSubject('statut inconnu', (s) => (s.status = 'fini'));

finish('schémas');
