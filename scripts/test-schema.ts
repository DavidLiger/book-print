// scripts/test-schema.ts — schémas print-book et subject : le cas valide, puis chaque refus.
import fs from 'node:fs';
import { printBookSchema, newPrintBook } from '../src/schema/print-book';
import { rightsFileSchema } from '../src/schema/rights';
import { contrast, styleSchema } from '../src/schema/style';
import { subjectSchema } from '../src/schema/subject';
import { TEMPLATE_2A } from '../src/templates/2A';
import { TEMPLATES } from '../src/templates';
import { templateSchema } from '../src/templates/model';
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
check('sujet de 3 pages valide', subjectSchema.safeParse({ ...subject(), pages: 3, template: '3A' }).success);
check('sujet de 12 pages valide', subjectSchema.safeParse({ ...subject(), pages: 12, template: '12A' }).success);
noSubject('pages = 1', (s) => ((s.pages = 1), (s.template = '1A')));
noSubject('pages non entier', (s) => (s.pages = 2.5));
noSubject('pages en texte', (s) => (s.pages = '4'));
noSubject('gabarit mal formé', (s) => (s.template = 'B4'));
noSubject('gabarit sans lettre', (s) => (s.template = '4'));
noSubject('gabarit à zéro initial', (s) => (s.template = '04B'));
noSubject('gabarit d’un autre nombre de pages', (s) => (s.template = '2A'));
noSubject('12 pages, gabarit 1A : tout le nombre est comparé', (s) => ((s.pages = 12), (s.template = '1A')));
noSubject('12 pages, gabarit 2A', (s) => ((s.pages = 12), (s.template = '2A')));
noSubject('1 page, gabarit 12A', (s) => ((s.pages = 1), (s.template = '12A')));
noSubject('variante sans miroir', (s) => delete s.variant.mirror);
noSubject('thème invalide', (s) => (s.variant.theme = 'Vert Clair'));
noSubject('blocs non vides avant MP3', (s) => (s.blocks = [{}]));
noSubject('illustrations non vides avant MP4', (s) => (s.illustrations = [{}]));
noSubject('statut inconnu', (s) => (s.status = 'fini'));

// gabarits (§3.4)
const edge = (mm = 0) => ({ from: 'securite', mm });
const box = { outer: edge(), inner: edge(), top: edge(), heightMm: 20 };
const zone = (id: string, extra: Dict = {}): Dict => ({ id, type: 'texte', bleed: false, box, ...extra });
const tpl = (start: string, sheets: Dict[][], id = `${sheets.length}A`): Dict => ({ id, pages: sheets.length, start, sheets: sheets.map((zones) => ({ zones })) });
const qr = (extra: Dict = {}) => zone('qr', { type: 'qr', constraints: { qrSideMm: 25 }, ...extra });
const spread = zone('large', { type: 'illustration', spread: true });
const twoA = (): Dict => structuredClone(TEMPLATE_2A);
const goodTpl = (name: string, t: Dict) => check(`gabarit admis : ${name}`, templateSchema.safeParse(t).success, templateSchema.safeParse(t).error?.issues);
const noTpl = (name: string, t: Dict) => check(`gabarit refusé : ${name}`, !templateSchema.safeParse(t).success, t);

check('gabarit 2A livré et valide', TEMPLATES['2A']?.id === '2A' && templateSchema.safeParse(twoA()).success);
goodTpl('à cheval, page gauche puis droite, start gauche', tpl('gauche', [[spread], []]));
goodTpl('à cheval sur les pages 2 et 3, start droite', tpl('droite', [[], [spread], []]));
goodTpl('libre, sans élément à cheval', tpl('libre', [[zone('a')], []]));
goodTpl('12 pages, 12A', tpl('gauche', Array.from({ length: 12 }, () => [])));
goodTpl('3 pages, 3A', tpl('droite', [[], [], []]));
noTpl('identifiant d’un autre nombre de pages', tpl('gauche', [[], []], '4A'));
noTpl('12 pages, identifiant 1A', tpl('gauche', Array.from({ length: 12 }, () => []), '1A'));
noTpl('identifiant mal formé', tpl('gauche', [[], []], 'A2'));
noTpl('pages et sheets différents', { ...tpl('gauche', [[], []]), pages: 4, id: '4A' });
noTpl('1 page', tpl('gauche', [[]], '1A'));
noTpl('start inconnu', tpl('haut', [[], []]));
noTpl('clé inconnue', { ...tpl('gauche', [[], []]), autre: 1 });
noTpl('niveau double page', { ...tpl('gauche', [[], []]), spreads: [] });
noTpl('type de zone inconnu', tpl('gauche', [[zone('a', { type: 'bulle' })], []]));
noTpl('identifiant de zone en double', tpl('gauche', [[zone('a')], [zone('a')]]));
noTpl('à cheval sur une page droite, start gauche', tpl('gauche', [[], [spread], []]));
noTpl('à cheval sur la première page, start droite', tpl('droite', [[spread], []]));
noTpl('à cheval dans un gabarit libre', tpl('libre', [[spread], []]));
noTpl('à cheval sur la dernière page', tpl('droite', [[], [spread]]));
noTpl('bleed sur un texte', tpl('gauche', [[zone('a', { bleed: true, box: { ...box, top: { from: 'rogne', mm: 0 } } })], []]));
noTpl('bleed sans bord rogné', tpl('gauche', [[zone('a', { type: 'illustration', bleed: true })], []]));
noTpl('bleed du seul côté du pli', tpl('gauche', [[zone('a', { type: 'illustration', bleed: true, box: { ...box, inner: { from: 'rogne', mm: 0 } } })], []]));
noTpl('trois valeurs en largeur', tpl('gauche', [[zone('a', { box: { ...box, widthMm: 10 } })], []]));
noTpl('une seule valeur en largeur', tpl('gauche', [[zone('a', { box: { outer: edge(), top: edge(), heightMm: 20 } })], []]));
noTpl('une seule valeur en hauteur', tpl('gauche', [[zone('a', { box: { outer: edge(), inner: edge(), top: edge() } })], []]));
noTpl('distance négative', tpl('gauche', [[zone('a', { box: { ...box, top: edge(-1) } })], []]));
noTpl('taille nulle', tpl('gauche', [[zone('a', { box: { outer: edge(), inner: edge(), top: edge(), heightMm: 0 } })], []]));
noTpl('QR ailleurs que sur la dernière page', tpl('gauche', [[qr()], []]));
noTpl('QR sans côté', tpl('gauche', [[], [zone('qr', { type: 'qr' })]]));
noTpl('QR de moins de 25 mm', tpl('gauche', [[], [qr({ constraints: { qrSideMm: 24 } })]]));
noTpl('deux QR', tpl('gauche', [[], [qr(), qr({ id: 'qr2' })]]));

// style de collection (§3.1)
const defaultStyle = JSON.parse(fs.readFileSync(new URL('../src/templates/defaults/style.json', import.meta.url), 'utf8'));
const style = (): Dict => structuredClone(defaultStyle);
const goodStyle = (name: string, change: (v: Dict) => void) => {
  const v = style();
  change(v);
  check(`style admis : ${name}`, styleSchema.safeParse(v).success, styleSchema.safeParse(v).error?.issues);
};
const noStyle = (name: string, change: (v: Dict) => void) => refused(styleSchema, `style, ${name}`, change, style);

check('style par défaut valide', styleSchema.safeParse(style()).success, styleSchema.safeParse(style()).error?.issues);
check('style par défaut : 5 thèmes et 5 informations', Object.keys(style().palette.themes).length === 5 && style().fiche.length === 5);
check('style par défaut : marges du §4.1', style().margins.outerMm === 12 && style().margins.gutterMm === 15);
check('contraste : noir sur blanc = 21', Math.round(contrast('#000000', '#ffffff')) === 21);
goodStyle('un sixième thème', (s) => (s.palette.themes.nuit = '#123456'));
goodStyle('un seul thème', (s) => {
  s.palette.themes = { nuit: '#123456' };
  s.variants.rotation = ['nuit'];
});
goodStyle('un nouveau pictogramme et une nouvelle information', (s) => {
  s.pictos.vitesse = { file: 'vitesse.svg', rights: 'pictos-maison' };
  s.fiche.push({ id: 'vitesse', picto: 'vitesse', label: { fr: 'Vitesse', en: 'Speed', es: 'Velocidad' } });
});
goodStyle('une fiche réduite à une information', (s) => (s.fiche = s.fiche.slice(0, 1)));
goodStyle('un nouveau type d’encadré', (s) => (s.palette.boxes.quiz = '#ffffff'));
goodStyle('numéros de page retirés', (s) => (s.folio.show = false));
goodStyle('texte courant à 14 pt', (s) => (s.fonts.body.sizePt = 14));
goodStyle('marges au minimum de KDP', (s) => (s.margins.outerMm = s.margins.topMm = s.margins.bottomMm = 9.6));
noStyle('version absente', (s) => delete s.schemaVersion);
noStyle('version inconnue', (s) => (s.schemaVersion = 2));
noStyle('clé inconnue', (s) => (s.autre = 1));
noStyle('couleur à alpha', (s) => (s.palette.themes.foret = '#1f6f5c80'));
noStyle('couleur rgba', (s) => (s.palette.text = 'rgba(0,0,0,0.5)'));
noStyle('couleur en majuscules', (s) => (s.palette.text = '#22262B'));
noStyle('nom de thème invalide', (s) => (s.palette.themes['Nuit Claire'] = '#123456'));
noStyle('aucun thème', (s) => (s.palette.themes = {}));
noStyle('thème trop clair pour un titre blanc', (s) => (s.palette.themes.foret = '#7fd19f'));
noStyle('encadré trop sombre pour le texte', (s) => (s.palette.boxes.fiche = '#444444'));
noStyle('texte trop clair sur le papier', (s) => (s.palette.text = '#aaaaaa'));
noStyle('encadré de la fiche manquant', (s) => delete s.palette.boxes.fiche);
noStyle('marge extérieure sous KDP', (s) => (s.margins.outerMm = 9));
noStyle('marge du haut sous KDP', (s) => (s.margins.topMm = 9));
noStyle('marge du bas sous KDP', (s) => (s.margins.bottomMm = 9));
noStyle('petit fond sous 15 mm', (s) => (s.margins.gutterMm = 14));
noStyle('texte courant sous 13 pt', (s) => (s.fonts.body.sizePt = 12));
noStyle('police hors du pack', (s) => (s.fonts.body.pack = 'comic-sans'));
noStyle('interligne sous 1', (s) => (s.fonts.body.lineHeight = 0.9));
noStyle('chapeau sans police', (s) => delete s.fonts.lead);
noStyle('pictogramme hors de collection/pictos/', (s) => (s.pictos.taille.file = '../taille.svg'));
noStyle('pictogramme sans droits', (s) => delete s.pictos.taille.rights);
noStyle('fiche vide', (s) => (s.fiche = []));
noStyle('fiche : pictogramme inconnu', (s) => (s.fiche[0].picto = 'vitesse'));
noStyle('fiche : information en double', (s) => s.fiche.push(s.fiche[0]));
noStyle('fiche : libellé manquant', (s) => delete s.fiche[0].label.es);
noStyle('rotation vide', (s) => (s.variants.rotation = []));
noStyle('rotation : thème inconnu', (s) => s.variants.rotation.push('nuit'));
noStyle('numéro de page sous 7 pt', (s) => (s.folio.sizePt = 6));

// registre commun
const defaultRights = JSON.parse(fs.readFileSync(new URL('../src/templates/defaults/rights.json', import.meta.url), 'utf8'));
check('droits par défaut valides', rightsFileSchema.safeParse(defaultRights).success);
check('droits par défaut : polices OFL et pictogrammes maison', defaultRights.entries.map((e: Dict) => e.id).join() === 'andika,baloo-2,pictos-maison');
check('droits : genre inconnu refusé', !rightsFileSchema.safeParse({ ...defaultRights, entries: [{ ...defaultRights.entries[0], kind: 'autre' }] }).success);
check('droits : licence manquante refusée', !rightsFileSchema.safeParse({ ...defaultRights, entries: [{ ...defaultRights.entries[0], license: '' }] }).success);

finish('schémas');
