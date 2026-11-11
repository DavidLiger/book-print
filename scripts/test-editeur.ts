// scripts/test-editeur.ts — éditeur de mise en page (ED3, spec §24.8) : partie pure de `src/ui/editeur.js` (magnétisme, bornes, poignées,
// fond perdu aimanté, flèches, élément ajouté, historique), grille du style, « Miroir », écriture sûre et archive de la version 1, routes
// (`enregistrer`, `nouvelle`, `copier`, `miroir`, refus), premier enregistrement de 2A et d'un sujet d'avant ED1 à HTML identique, contenu de
// l'éditeur d'un sujet, C3 à l'encre, puis les gestes dans un vrai Chromium, fichier écrit comparé à l'attendu après chaque geste.
// Tout est synthétique.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { chromium, type Page } from 'playwright';
import { readPdfFacts } from '../src/checks/pdf-facts';
import { runChecks } from '../src/checks/rules';
import { createCollection, readCollection } from '../src/data/collection';
import { createBookFolder } from '../src/data/create-book';
import { createSubject, updateSubject } from '../src/data/subject-file';
import { archiveV1, layoutJson, LayoutConflict, sha256, writeIfUnchanged } from '../src/layout/files';
import { fromV1 } from '../src/layout/from-v1';
import { mirrored, mirrorLayout } from '../src/layout/mirror';
import { layoutSchema } from '../src/layout/schema';
import { placeLayout } from '../src/layout/place';
import { mergeImport } from '../src/research/import';
import { readBook } from '../src/glbi/read';
import { subjectContext } from '../src/render/subject';
import { packFonts } from '../src/render/essai';
import { templateContent } from '../src/render/gabarit';
import { renderHtml } from '../src/render/html';
import { renderPdf } from '../src/render/pdf';
import { DEFAULT_GRID, gridOf, styleSchema } from '../src/schema/style';
import { createPrintServer } from '../src/server/app';
import { readTemplates } from '../src/templates/files';
import { TEMPLATE_2A } from './fixtures/gabarits';
import { synthese } from './fixtures/mises-en-page';
import { BOOK_DIR, BOOK_ID, fileLink, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { makeResearch } from './fixtures/recherche';
import { check, finish } from './test-lib';

type Dict = Record<string, any>;
const SIX_NINE = { widthIn: 6, heightIn: 9 };
const W = 152.4;
const H = 228.6;
const BLEED = 3.175;
/** Petit fond de 20 mm : la bande du pli (15 mm) et la zone de sécurité ne se confondent pas, chaque repère du magnétisme se voit seul. */
const M = { outerMm: 12, topMm: 12, bottomMm: 12, gutterMm: 20 };
const near = (a: number, b: number, t = 1e-6) => Math.abs(a - b) <= t;
const UI = path.join(import.meta.dirname, '..', 'src', 'ui');

// Partie pure de l'éditeur, chargée telle quelle dans un contexte vide : aucun DOM n'y est touché.
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(UI, 'editeur.js'), 'utf8'), ctx);
const E = vm.runInContext('EDITEUR', ctx) as Dict;
check('éditeur : la partie de la page ne s’installe pas hors d’un navigateur', vm.runInContext('Editeur', ctx) === null);

/** Pages posées comme le serveur les rend : page gauche puis page droite, 6 × 9", marges `M`. */
const geometry = (sides: string[]) =>
  sides.map((side, i) => {
    const left = side === 'gauche' ? BLEED : 0;
    const trim = { left, top: BLEED, right: left + W, bottom: BLEED + H };
    const safe = { left: trim.left + (side === 'gauche' ? M.outerMm : M.gutterMm), top: trim.top + M.topMm, right: trim.right - (side === 'gauche' ? M.gutterMm : M.outerMm), bottom: trim.bottom - M.bottomMm };
    return { number: 6 + i, side, widthMm: W + BLEED, heightMm: H + 2 * BLEED, trim, safe, foldMm: side === 'gauche' ? trim.right : trim.left, zones: [] };
  });
const doc2 = { schemaVersion: 2, id: '2Y', pages: 2, start: 'gauche', trim: SIX_NINE, elements: [] as Dict[] };
const P = E.plan(doc2, geometry(['gauche', 'droite']), DEFAULT_GRID);

// Doubles pages et grille.
{
  check('plan : 2 pages depuis la gauche, une double page', JSON.stringify(P.spreads) === '[[0,1]]' && near(P.bleed, BLEED) && near(P.strip, 2 * (W + BLEED)));
  const four = E.plan({ ...doc2, pages: 4 }, geometry(['gauche', 'droite', 'gauche', 'droite']), DEFAULT_GRID);
  check('plan : 4 pages, deux doubles pages', JSON.stringify(four.spreads) === '[[0,1],[2,3]]');
  const three = E.plan({ ...doc2, pages: 3, start: 'droite' }, geometry(['droite', 'gauche', 'droite']), DEFAULT_GRID);
  check('plan : 3 pages depuis la droite, la première seule', JSON.stringify(three.spreads) === '[[0],[1,2]]');
  const cols = E.colonnes(P.pages[0], DEFAULT_GRID);
  const width = (W - M.outerMm - M.gutterMm - 2 * 5) / 3;
  check('grille par défaut : 3 colonnes, gouttière de 5 mm, dans la zone de sécurité', cols.length === 3 && near(cols[0].left, 12) && near(cols[2].right, W - 20) && cols.every((c: Dict) => near(c.right - c.left, width)) && near(cols[1].left - cols[0].right, 5), cols);
  check('grille : rien quand les colonnes ne tiennent pas', E.colonnes(P.pages[0], { colonnes: 12, gouttiereMm: 20 }).length === 0);
  check('grille du style : absente, 3 colonnes et 5 mm', gridOf({}).colonnes === 3 && gridOf({}).gouttiereMm === 5);
  const style = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'templates', 'defaults', 'style.json'), 'utf8'));
  check('grille du style : admise', styleSchema.safeParse({ ...style, grille: { colonnes: 4, gouttiereMm: 4 } }).success && gridOf(styleSchema.parse({ ...style, grille: { colonnes: 4, gouttiereMm: 4 } })).colonnes === 4);
  for (const [name, grille] of [['0 colonne', { colonnes: 0, gouttiereMm: 5 }], ['13 colonnes', { colonnes: 13, gouttiereMm: 5 }], ['gouttière négative', { colonnes: 3, gouttiereMm: -1 }], ['colonnes non entières', { colonnes: 2.5, gouttiereMm: 5 }], ['champ inconnu', { colonnes: 3, gouttiereMm: 5, marge: 1 }]] as const) {
    check(`grille du style refusée : ${name}`, !styleSchema.safeParse({ ...style, grille }).success);
  }
}

// Magnétisme : chaque sorte de repère, à 1,5 mm au plus, avec la valeur attendue ; puis la borne de la page. Bords de la grille (page gauche) :
// 12 ; 48,8 et 53,8 ; 90,6 et 95,6 ; 132,4. Bande du pli : 137,4. La boîte (33 mm) est choisie pour qu'un seul bord soit près d'un repère.
{
  const box = { id: 'a', type: 'encadre', page: 0, x: 30, y: 30, w: 33, h: 20, encadre: 'fiche', maxChars: 10 };
  const move = (e: Dict, dx: number, dy: number) => E.deplacer(P, e, dx, dy);
  let r = move(box, -16.8, 0);
  check('magnétisme : zone de sécurité (12 mm), repère affiché', r.x === 12 && r.guides.some((g: Dict) => g.axe === 'x' && g.kind === 'sécurité' && g.v === 12), r);
  r = move(box, -29.2, 0);
  check('magnétisme : bord de la page rognée', r.x === 0 && r.guides[0].kind === 'rogne', r);
  r = move(box, -32, 0);
  check('magnétisme : fond perdu, posé au bord de la page rognée', r.x === 0 && r.guides[0].kind === 'fond perdu' && near(r.guides[0].v, -BLEED), r);
  r = move({ ...box, x: 60 }, 43.6, 0);
  check('magnétisme : bande du pli (bord droit à 15 mm du pli)', near(r.x + box.w, W - 15) && r.guides[0].kind === 'pli', r);
  const col = E.colonnes(P.pages[0], DEFAULT_GRID)[1].left;
  r = move(box, col - 30 + 1.2, 0);
  check('magnétisme : colonne de la grille', near(r.x, col) && r.guides[0].kind === 'grille', r);
  r = move(box, 0, -17.1);
  check('magnétisme en y : zone de sécurité', r.y === 12 && r.guides[0].axe === 'y' && r.guides[0].kind === 'sécurité', r);
  r = move(box, 0, H - 50 - 0.9);
  check('magnétisme en y : bas de la page rognée', near(r.y + box.h, H) && r.guides[0].kind === 'rogne', r);
  r = move(box, -16.4, 0);
  check('magnétisme : hors des 1,5 mm, aucun repère, valeur au dixième', r.x === 13.6 && r.guides.length === 0, r);
  r = move(box, 0.03, 0.04);
  check('magnétisme : sans repère, arrondi au dixième de mm', r.x === 30 && r.y === 30, r);
  r = move(box, 500, 500);
  check('borne : page rognée', near(r.x, W - 33) && r.y === H - 20, r);
  r = move(box, -500, -500);
  check('borne : coin haut gauche', r.x === 0 && r.y === 0, r);
  const wide = { id: 'p', type: 'illustration', page: 0, x: 10, y: 0, w: 200, h: 50, double: true };
  r = move(wide, 500, 0);
  check('borne : double page pour un élément à cheval', near(r.x, 2 * W - 200), r);
  check('à cheval : le pli est un bord de page rognée, la bande de la page droite aussi', E.ciblesX(P, 0, true).some((c: Dict) => near(c.v, W) && c.kind === 'rogne') && E.ciblesX(P, 0, true).some((c: Dict) => near(c.v, W + 15) && c.kind === 'pli'));
  const right = { ...box, page: 1, x: 50 };
  r = move(right, -33.8, 0);
  check('page droite : bande du pli à 15 mm du bord gauche', near(r.x, 15) && r.guides[0].kind === 'pli', r);
  r = move(right, -30.8, 0);
  check('page droite : zone de sécurité au petit fond (20 mm)', near(r.x, 20) && r.guides[0].kind === 'sécurité', r);
  r = move({ ...right, x: 100 }, 18.6, 0);
  check('page droite : bord extérieur (droite) aimanté', near(r.x + 33, W) && r.guides[0].kind === 'rogne' && r.aimantes.includes('droite'), r);
}

// Poignées : chaque bord, la taille minimale, le magnétisme du bord qui bouge, le rapport d'un détouré.
{
  const box = { id: 'a', type: 'texte', page: 0, x: 30, y: 30, w: 40, h: 20, maxChars: 10 };
  let r = E.redimensionner(P, box, 'e', 10.2, 0);
  check('poignée e : largeur', r.x === 30 && r.w === 50.2 && r.h === 20, r);
  r = E.redimensionner(P, box, 'w', -17.3, 0);
  check('poignée w : bord gauche aimanté, bord droit en place', r.x === 12 && near(r.x + r.w, 70) && r.guides[0].kind === 'sécurité', r);
  r = E.redimensionner(P, box, 's', 0, 5);
  check('poignée s : hauteur', r.y === 30 && r.h === 25, r);
  r = E.redimensionner(P, box, 'n', 0, -18.5);
  check('poignée n : bord haut aimanté', r.y === 12 && near(r.y + r.h, 50), r);
  r = E.redimensionner(P, box, 'se', 3, 4);
  check('poignée se : les deux', r.w === 43 && r.h === 24, r);
  r = E.redimensionner(P, box, 'nw', 100, 100);
  check('poignée nw : taille minimale de 1 mm', near(r.w, 1) && near(r.h, 1) && near(r.x + r.w, 70) && near(r.y + r.h, 50), r);
  r = E.redimensionner(P, box, 'e', 500, 0);
  check('poignée : bornée à la page rognée', near(r.x + r.w, W), r);
  const exact = { ...box, x: 60.466667, y: 14.333333 };
  r = E.redimensionner(P, exact, 's', 0, 5);
  check('poignée s : bords gauche et haut gardés tels quels, bord bas au dixième', r.x === 60.466667 && r.y === 14.333333 && r.w === 40 && near(r.y + r.h, 39.3), r);
  r = E.redimensionner(P, exact, 'e', 3.04, 0);
  check('poignée e : bord gauche gardé, bord droit au dixième', r.x === 60.466667 && near(r.x + r.w, 103.5), r);
  r = E.deplacer(P, exact, 0, 3.04);
  check('glisser en y seul : x gardé tel quel', r.x === 60.466667 && r.y === 17.4, r);
  r = E.redimensionner(P, box, 'ne', 6.4, 0);
  check('poignée ne : aucun bord vertical ne bouge en y', r.y === 30 && r.h === 20, r);
  const det = { id: 'd', type: 'illustration', page: 0, x: 30, y: 30, w: 40, h: 20, detoure: true, habillage: 'aucun' };
  r = E.redimensionner(P, det, 'e', 15, 0, 2);
  check('détouré déposé : rapport gardé à la poignée e', near(r.w, 55) && near(r.h, 27.5) && r.y === 30, r);
  r = E.redimensionner(P, det, 's', 0, 10, 2);
  check('détouré déposé : rapport gardé à la poignée s', near(r.h, 30) && near(r.w, 60) && r.x === 30, r);
  r = E.redimensionner(P, det, 'nw', -10, 0, 2);
  check('détouré déposé : rapport gardé à la poignée nw, coin opposé en place', near(r.w / r.h, 2) && near(r.x + r.w, 70) && near(r.y + r.h, 50), r);
  r = E.redimensionner(P, det, 'e', 500, 0, 2);
  check('détouré déposé : rapport gardé au bord de la page', near(r.w / r.h, 2) && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6, r);
  r = E.redimensionner(P, det, 'e', 15, 0);
  check('détouré sans image : rapport libre', near(r.w, 55) && r.h === 20, r);
}

// Fond perdu aimanté (décision de David, ED3) : coché sur le bord où l'élément est aimanté, retiré d'un bord qu'il ne touche plus.
{
  const fond = { id: 'f', type: 'fond', page: 0, x: 20, y: 0.8, w: 60, h: 40 };
  let r = E.deplacer(P, fond, 0, -1);
  let e = E.fondPerdu(P, { ...fond, x: r.x, y: r.y }, r.aimantes);
  check('fond aimanté en haut : fond perdu haut coché', e.y === 0 && JSON.stringify(e.fondPerdu) === '["haut"]', e);
  r = E.deplacer(P, { ...e }, -21, 0);
  e = E.fondPerdu(P, { ...e, x: r.x, y: r.y }, r.aimantes);
  check('fond aimanté à l’extérieur d’une page gauche : exterieur ajouté', e.x === 0 && JSON.stringify(e.fondPerdu) === '["haut","exterieur"]', e);
  r = E.deplacer(P, e, 0, 30);
  e = E.fondPerdu(P, { ...e, x: r.x, y: r.y }, r.aimantes);
  check('fond qui quitte le haut : fond perdu haut retiré, exterieur gardé', JSON.stringify(e.fondPerdu) === '["exterieur"]', e);
  const onRight = E.fondPerdu(P, { ...fond, page: 1, x: W - 60, y: 10 }, ['droite']);
  check('page droite : bord droit aimanté, exterieur', JSON.stringify(onRight.fondPerdu) === '["exterieur"]', onRight);
  const fold = E.fondPerdu(P, { ...fond, x: W - 60, y: 10 }, ['droite']);
  check('page gauche : bord du pli aimanté, aucun fond perdu', fold.fondPerdu === undefined, fold);
  const text = E.fondPerdu(P, { id: 't', type: 'texte', page: 0, x: 0, y: 0, w: 10, h: 10, maxChars: 5 }, ['haut', 'gauche']);
  check('texte au bord : aucun fond perdu', text.fondPerdu === undefined);
  const det = E.fondPerdu(P, { id: 'd', type: 'illustration', page: 0, x: 0, y: 0, w: 10, h: 10, detoure: true, habillage: 'aucun' }, ['haut']);
  check('détouré au bord : aucun fond perdu', det.fondPerdu === undefined);
  const kept = E.fondPerdu(P, { ...fond, y: 0, fondPerdu: ['haut'] }, []);
  check('flèche ou champ sans aimant : le fond perdu d’un bord touché reste', JSON.stringify(kept.fondPerdu) === '["haut"]');
  const none = E.fondPerdu(P, { ...fond, y: 0 }, []);
  check('bord touché sans aimant : rien n’est coché', none.fondPerdu === undefined);
  const banner = E.fondPerdu(P, { id: 'b', type: 'bandeau', page: 0, x: 0, y: H - 30, w: 2 * W, h: 30, double: true, maxChars: 30 }, ['bas', 'droite']);
  check('bandeau à cheval : bord bas et bord droit de la double page', JSON.stringify(banner.fondPerdu) === '["bas","exterieur"]', banner);
}

// Flèches, élément ajouté, historique, renommage.
{
  const box = { id: 'a', type: 'texte', page: 0, x: 30, y: 30, w: 40, h: 20, maxChars: 10 };
  check('flèche : 0,5 mm', JSON.stringify(E.pas(P, box, E.STEP_MM, 0)) === '{"x":30.5,"y":30}' && E.STEP_MM === 0.5);
  check('Maj et flèche : 5 mm', JSON.stringify(E.pas(P, box, 0, -E.BIG_STEP_MM)) === '{"x":30,"y":25}' && E.BIG_STEP_MM === 5);
  check('flèche : bornée à la page rognée', E.pas(P, { ...box, x: W - 40.2 }, 0.5, 0).x === W - 40 && E.pas(P, { ...box, y: 0.2 }, 0, -0.5).y === 0);
  const options = { boxes: ['fiche', 'savais-tu'], pictos: ['taille', 'poids'] };
  const doc = { ...doc2, elements: [{ ...box, id: 'texte-1' }] };
  const added = (type: string) => E.nouvelElement(doc, P, type, [0, 1], options);
  const t = added('texte');
  check('ajout : 60 × 30 mm au centre de la zone de sécurité de la page gauche', t.page === 0 && t.w === 60 && t.h === 30 && near(t.x, 42.2) && near(t.y, 99.3) && t.id === 'texte-2', t);
  check('ajout : maxChars 200, 40 pour un titre ou un bandeau', t.maxChars === 200 && added('titre').maxChars === 40 && added('bandeau').maxChars === 40 && added('legende').maxChars === 200);
  check('ajout : première couleur d’encadré, premier pictogramme', added('encadre').encadre === 'fiche' && added('picto').picto === 'taille');
  const qr = E.nouvelElement({ ...doc, pages: 4 }, E.plan({ ...doc2, pages: 4 }, geometry(['gauche', 'droite', 'gauche', 'droite']), DEFAULT_GRID), 'qr', [0, 1], options);
  check('ajout : le QR sur la dernière page, côté de 25 mm', qr.page === 3 && qr.qrSideMm === 25 && qr.maxChars === undefined);
  check('ajout : fond, illustration, fiche, folio sans champ de plus', ['fond', 'illustration', 'fiche', 'folio'].every((type) => Object.keys(added(type)).join() === 'id,type,page,x,y,w,h'));
  check('ajout : chaque type est valide au schéma', E.TYPES.filter((type: string) => type !== 'qr').every((type: string) => layoutSchema.safeParse({ ...doc2, elements: [added(type)] }).success) && layoutSchema.safeParse({ ...doc2, elements: [{ ...qr, page: 1 }] }).success);
  const h = E.historique();
  for (let i = 0; i < 105; i++) E.empiler(h.annuler, { n: i });
  check('historique : 100 pas au plus, les plus anciens oubliés', h.annuler.length === 100 && h.annuler[0].n === 5 && h.annuler[99].n === 104);
  const chained = { ...doc2, chaines: [{ id: 'corps', cadres: ['t1', 't2'], paragraphes: [{ id: 'p1', intertitre: false, maxChars: 10 }] }], elements: [{ id: 'img', type: 'illustration' }, { id: 'leg', type: 'legende', image: 'img' }, { id: 't1', type: 'texte', chaine: 'corps' }] };
  const renamed = E.renommer(chained, 't1', 'gauche');
  check('renommer : cadre de la chaîne suivi', renamed.chaines[0].cadres.join() === 'gauche,t2' && renamed.elements[2].id === 'gauche');
  check('renommer : image d’une légende suivie', E.renommer(chained, 'img', 'photo').elements[1].image === 'photo');
}

// « Miroir » (spec §24.12).
{
  const base = layoutSchema.parse({ ...synthese('2Y', SIX_NINE, M), elements: synthese('2Y', SIX_NINE, M).elements.filter((e: Dict) => !e.double && e.id !== 'legende') });
  const m = mirrorLayout(base);
  check('miroir : valide', 'layout' in m, m);
  if ('layout' in m) {
    const by = (l: Dict, id: string) => l.elements.find((e: Dict) => e.id === id);
    const cap = by(base, 'capsule');
    check('miroir : x devient largeur rognée − x − w', near(by(m.layout, 'capsule').x, W - cap.x - cap.w));
    check('miroir : départ de l’autre côté', m.layout.start === 'droite');
    check('miroir : bandeau au bord extérieur, fond perdu exterieur gardé', near(by(m.layout, 'bandeau').x + by(m.layout, 'bandeau').w, W) && by(m.layout, 'bandeau').fondPerdu.join() === 'exterieur');
    const eti = by(base, 'etiquette');
    check('miroir : point de la flèche d’étiquette', near(by(m.layout, 'etiquette').fleche.x, W - eti.fleche.x) && by(m.layout, 'etiquette').fleche.y === eti.fleche.y);
    const back = mirrorLayout(m.layout);
    check('miroir deux fois : la mise en page de départ (au millionième de mm)', 'layout' in back && back.layout.start === base.start && back.layout.elements.every((e: Dict, i: number) => near(e.x, base.elements[i]!.x) && JSON.stringify({ ...e, x: 0 }) === JSON.stringify({ ...base.elements[i], x: 0 })));
    check('miroir : y, w, h et ordre inchangés', m.layout.elements.every((e: Dict, i: number) => e.id === base.elements[i]!.id && e.y === base.elements[i]!.y && e.w === base.elements[i]!.w && e.h === base.elements[i]!.h));
  }
  const wrap = (habillage: string) => layoutSchema.parse({ ...doc2, elements: [{ id: 'd', type: 'illustration', page: 0, x: 10, y: 10, w: 40, h: 40, detoure: true, habillage }] });
  check('miroir : habillage gauche ↔ droite, aucun inchangé', mirrored(wrap('gauche')).elements[0]!.habillage === 'droite' && mirrored(wrap('droite')).elements[0]!.habillage === 'gauche' && mirrored(wrap('aucun')).elements[0]!.habillage === 'aucun');
  const spread = mirrored(layoutSchema.parse(synthese('2Y', SIX_NINE, M)));
  check('miroir : élément à cheval, x sur deux largeurs', near(spread.elements[0]!.x, 0));
  const refused = mirrorLayout(layoutSchema.parse(synthese('2Y', SIX_NINE, M)));
  check('miroir refusé : élément à cheval sur une page droite, motif du schéma', 'issues' in refused && refused.issues.includes('à cheval sur une page droite'), refused);
}

// Écriture sûre et archive de la version 1.
{
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, '2A.json'), 'un');
  const first = sha256(Buffer.from('un'));
  const sha = writeIfUnchanged(dir, '2A.json', 'deux', first, 'collection/gabarits/2A.json');
  check('écriture sûre : fichier lu, réécrit, empreinte rendue', fs.readFileSync(path.join(dir, '2A.json'), 'utf8') === 'deux' && sha === sha256(Buffer.from('deux')));
  const refused = (name: string, fn: () => unknown, text: string) => {
    try {
      fn();
      check(name, false);
    } catch (e) {
      check(name, e instanceof LayoutConflict && (e as Error).message.includes(text), (e as Error).message);
    }
  };
  refused('écriture sûre : empreinte périmée, refusée', () => writeIfUnchanged(dir, '2A.json', 'trois', first, 'collection/gabarits/2A.json'), 'a changé depuis sa lecture');
  check('écriture sûre : rien d’écrit après un refus', fs.readFileSync(path.join(dir, '2A.json'), 'utf8') === 'deux' && fs.readdirSync(dir).length === 1);
  refused('écriture sûre : fichier apparu alors qu’il était absent', () => writeIfUnchanged(dir, '2A.json', 'trois', null, 'x/2A.json'), 'a changé');
  refused('écriture sûre : fichier disparu', () => writeIfUnchanged(dir, '9Z.json', 'trois', first, 'x/9Z.json'), 'a changé');
  writeIfUnchanged(dir, 'neuf.json', 'n', null, 'x/neuf.json');
  check('écriture sûre : fichier absent attendu, créé', fs.readFileSync(path.join(dir, 'neuf.json'), 'utf8') === 'n');
  if (fileLink(path.join(dir, 'neuf.json'), path.join(dir, 'lien.json'))) refused('écriture sûre : lien refusé, sans rien lire', () => writeIfUnchanged(dir, 'lien.json', 'x', sha256(Buffer.from('n')), 'x/lien.json'), 'fichier réel');
  const now = new Date('2026-11-10T15:04:05.123Z');
  const rel = archiveV1(dir, '2A', Buffer.from('v1'), now);
  check('archive : archives/<id>.<date>.json, octets identiques', rel === 'gabarits/archives/2A.2026-11-10T15-04-05-123Z.json' && fs.readFileSync(path.join(dir, 'archives', '2A.2026-11-10T15-04-05-123Z.json'), 'utf8') === 'v1');
  try {
    archiveV1(dir, '2A', Buffer.from('autre'), now);
    check('archive : rien n’est écrasé', false);
  } catch (e) {
    check('archive : rien n’est écrasé', (e as NodeJS.ErrnoException).code === 'EEXIST' && fs.readFileSync(path.join(dir, 'archives', '2A.2026-11-10T15-04-05-123Z.json'), 'utf8') === 'v1');
  }
  const other = tempDir();
  fs.mkdirSync(path.join(other, 'ailleurs'));
  fs.symlinkSync(path.join(other, 'ailleurs'), path.join(other, 'archives'), 'junction');
  refused('archive : dossier en lien refusé', () => archiveV1(other, '2A', Buffer.from('v1'), now), 'dossier réel');
  check('archive : rien dans le dossier visé par le lien', fs.readdirSync(path.join(other, 'ailleurs')).length === 0);
}

// C3 à l'encre (décision de David, ED3) : un titre posé au bord haut de la zone de sécurité est en règle ; dépassé de 1 mm, il ne l'est plus.
{
  const dataRoot = path.join(tempDir(), 'donnees');
  fs.mkdirSync(dataRoot);
  createBookFolder(dataRoot, BOOK_ID);
  createCollection(dataRoot);
  const read = readCollection(dataRoot)!;
  const m = read.style.margins;
  const layoutAt = (dy: number) =>
    layoutSchema.parse({
      ...doc2,
      elements: [
        // Titre d'une ligne (calé en bas, sa boîte à la hauteur de la ligne) et chapô, au bord haut de la zone de sécurité.
        { id: 'titre', type: 'titre', page: 0, x: m.outerMm, y: m.topMm + dy, w: 100, h: 11.2, maxChars: 8 },
        { id: 'chapeau', type: 'chapeau', page: 1, x: m.gutterMm, y: m.topMm, w: 100, h: 30, maxChars: 40 },
      ],
    });
  const c3 = async (dy: number) => {
    const l = layoutAt(dy);
    const pages = placeLayout(l, read.style.margins, 6);
    const { pdf, measures } = await renderPdf(renderHtml(pages, SIX_NINE, read.style, templateContent(l, read.style.fiche, 'foret', SIX_NINE), read.pictos), SIX_NINE);
    const facts = await readPdfFacts(pdf);
    return { c3: runChecks({ facts, measures, pages, pack: packFonts() }).find((c) => c.id === 'C3')!, measures, pages };
  };
  const atEdge = await c3(0);
  const lines = atEdge.measures.boxes.filter((b) => (b.zone === 'titre' || b.zone === 'chapeau') && b.kind === 'lignes');
  const inks = atEdge.measures.boxes.filter((b) => (b.zone === 'titre' || b.zone === 'chapeau') && b.kind === 'texte');
  const safeTop = atEdge.pages[0]!.safe.top;
  check('C3 : la boîte des lignes d’un titre et d’un chapô aimantés au haut de la zone de sécurité la dépasse', lines.length === 2 && lines.every((b) => b.rect.top < safeTop - 0.05), lines.map((b) => b.rect.top - safeTop));
  check('C3 : leur encre est dedans', inks.length === 2 && inks.every((b) => b.rect.top >= safeTop - 0.05), inks.map((b) => b.rect.top - safeTop));
  check('C3 à l’encre : titre et chapô aimantés au haut de la zone de sécurité en règle', atEdge.c3.level === 'ok', atEdge.c3);
  const over = await c3(-2);
  check('C3 à l’encre : le titre 2 mm plus haut, son encre dépasse, en faute', over.c3.level === 'erreur' && over.c3.details.some((d) => d.includes('titre')), over.c3);
  check('C3 : l’encre est plus étroite que la boîte des lignes', inks.every((ink) => lines.some((l) => ink.rect.left >= l.rect.left - 0.01 && ink.rect.right <= l.rect.right + 0.01)));
}

// Routes : état d'un modèle, enregistrement, refus, premier enregistrement de 2A et d'un sujet d'avant ED1, nouvelle, copie, miroir.
const glbRoot = makeGlbi();
const parent = tempDir();
const dataRoot = path.join(parent, 'donnees');
fs.mkdirSync(dataRoot);
createBookFolder(dataRoot, BOOK_ID);
createCollection(dataRoot);
{
  const stylePath = path.join(dataRoot, 'collection', 'style.json');
  put(dataRoot, 'collection/style.json', { ...JSON.parse(fs.readFileSync(stylePath, 'utf8')), margins: M });
}
const gabarit = (name: string) => path.join(dataRoot, 'collection', 'gabarits', name);
put(dataRoot, 'collection/gabarits/2Y.json', synthese('2Y', SIX_NINE, M));
const simple = () => ({ ...synthese('2M', SIX_NINE, M), elements: synthese('2M', SIX_NINE, M).elements.filter((e: Dict) => !e.double && e.id !== 'legende') });
put(dataRoot, 'collection/gabarits/2M.json', simple());
createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2Y', theme: 'foret' }, ['alpha', 'beta'], ['foret']);
createSubject(dataRoot, BOOK_ID, { sceneId: 'beta', pages: 2, template: '2A', theme: 'ocean' }, ['alpha', 'beta'], ['foret', 'ocean']);
fs.rmSync(path.join(dataRoot, BOOK_ID, 'subjects', 'beta', 'layout.json'));
put(parent, 'config.local.json', { glbRoot, dataRoot });
const server = createPrintServer(path.join(parent, 'config.local.json'));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
const host = `127.0.0.1:${port}`;
const headers = { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', 'x-book-print': '1' };
const request = (opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown }) =>
  new Promise<{ status: number; body: string; type: string | undefined }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path, headers: opts.headers ?? headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), type: res.headers['content-type'] }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
const post = async (route: string, body: unknown, h: Record<string, string> = headers) => {
  const r = await request({ path: route, headers: h, body });
  return { status: r.status, data: JSON.parse(r.body) as Dict };
};
const get = (p: string) => request({ method: 'GET', path: p, headers: { Host: host } });
const bytes = (file: string) => fs.readFileSync(file);
const expected = (doc: Dict) => layoutJson(layoutSchema.parse(doc));

{
  const js = await get('/editeur.js');
  check('page : editeur.js servi, liste fermée', js.status === 200 && js.type?.startsWith('text/javascript') === true && js.body.includes('const EDITEUR'));
  check('page : editeur.js chargé avant app.js', (await get('/')).body.indexOf('/editeur.js') < (await get('/')).body.indexOf('/app.js') && (await get('/')).body.includes('/editeur.js'));

  // 2A, version 1 : l'éditeur reçoit sa conversion ; rien n'est écrit à la lecture.
  const twoA = await post('/api/mise-en-page/state', { bookId: BOOK_ID, id: '2A' });
  const v1 = bytes(gabarit('2A.json'));
  check('état d’un modèle version 1 : conversion, empreinte des octets lus', twoA.status === 200 && twoA.data.cible === 'modele' && twoA.data.version === 1 && twoA.data.document.schemaVersion === 2 && twoA.data.empreinte === sha256(v1) && twoA.data.layout.length === 2, twoA.data);
  check('état : grille, couleurs, pictogrammes, thèmes', twoA.data.grille.colonnes === 3 && twoA.data.options.boxes[0] === 'fiche' && twoA.data.options.pictos.includes('taille') && twoA.data.options.themes.length === 5);
  check('état : lecture sans écriture', bytes(gabarit('2A.json')).equals(v1) && !fs.existsSync(gabarit('archives')));

  // Premier enregistrement de 2A, sans changement : version 1 archivée, conversion écrite, HTML de l'essai identique aux cinq thèmes.
  const themes = ['foret', 'ocean', 'volcan', 'savane', 'crepuscule'];
  const essai = async () => Promise.all(themes.map(async (t) => (await get(`/apercu?bookId=${BOOK_ID}&theme=${t}`)).body));
  const before = await essai();
  const saved = await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '2A', empreinte: twoA.data.empreinte, document: twoA.data.document });
  const archives = fs.existsSync(gabarit('archives')) ? fs.readdirSync(gabarit('archives')) : [];
  check('premier enregistrement de 2A : version 1 gardée dans archives/, octet pour octet', saved.status === 200 && archives.length === 1 && /^2A\.\d{4}-\d\d-\d\dT[\d-]+Z\.json$/.test(archives[0]!) && bytes(path.join(gabarit('archives'), archives[0]!)).equals(v1), { status: saved.status, archives });
  check('premier enregistrement de 2A : conversion écrite, version 2', bytes(gabarit('2A.json')).toString() === expected(twoA.data.document) && saved.data.version === 2 && saved.data.empreinte === sha256(bytes(gabarit('2A.json'))));
  const after = await essai();
  check('premier enregistrement de 2A : HTML de l’essai identique aux cinq thèmes', before.every((h, i) => h === after[i] && h.length > 1000));
  check('archive : jamais lue comme modèle', !readTemplates(dataRoot, readCollection(dataRoot)!.style).entries.some((e) => e.id.includes('.') || e.file.includes('archives')));

  // Enregistrement d'un modèle version 2 : le fichier écrit est le document validé, rien n'est écrit sans changement.
  const y = (await post('/api/mise-en-page/state', { bookId: BOOK_ID, id: '2Y' })).data;
  const moved = structuredClone(y.document);
  moved.elements.find((e: Dict) => e.id === 'capsule').x = 20;
  const ok = await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '2Y', empreinte: y.empreinte, document: moved });
  check('enregistrer : écrit, identique au document validé', ok.status === 200 && bytes(gabarit('2Y.json')).toString() === expected(moved) && ok.data.document.elements.find((e: Dict) => e.id === 'capsule').x === 20);
  check('enregistrer : nouvelle empreinte, C17 dans les motifs', ok.data.empreinte === sha256(bytes(gabarit('2Y.json'))) && Array.isArray(ok.data.errors));
  check('enregistrer : sans archive pour une version 2', fs.readdirSync(gabarit('archives')).length === 1);
  const mtime = fs.statSync(gabarit('2Y.json')).mtimeMs;
  await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '2Y', empreinte: ok.data.empreinte, document: moved });
  check('enregistrer : rien n’est écrit quand rien ne change', fs.statSync(gabarit('2Y.json')).mtimeMs === mtime);

  // Refus : rien n'est écrit.
  const current = bytes(gabarit('2Y.json'));
  const stale = await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '2Y', empreinte: y.empreinte, document: moved });
  check('écriture concurrente : 409, conflit, fichier inchangé', stale.status === 409 && stale.data.conflit === true && stale.data.error.includes('a changé depuis sa lecture') && bytes(gabarit('2Y.json')).equals(current), stale);
  // Fichier devenu invalide ailleurs : c'est un conflit (relire), pas un refus du document.
  fs.writeFileSync(gabarit('2Y.json'), '{ cassé');
  const broken = await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '2Y', empreinte: ok.data.empreinte, document: moved });
  check('fichier devenu invalide ailleurs : 409, conflit, rien d’écrit', broken.status === 409 && broken.data.conflit === true && fs.readFileSync(gabarit('2Y.json'), 'utf8') === '{ cassé', broken.data);
  fs.writeFileSync(gabarit('2Y.json'), current);
  const refuse = async (name: string, change: (d: Dict) => void, text: string) => {
    const d = structuredClone(ok.data.document);
    change(d);
    const r = await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '2Y', empreinte: ok.data.empreinte, document: d });
    check(`refus au schéma : ${name}, 409, motif, rien d’écrit`, r.status === 409 && !r.data.conflit && r.data.error.includes(text) && bytes(gabarit('2Y.json')).equals(current), r.data);
  };
  await refuse('hors de la page rognée', (d) => (d.elements[1].x = 200), 'hors de la page rognée');
  await refuse('illustration d’une légende rattachée supprimée', (d) => (d.elements = d.elements.filter((e: Dict) => e.id !== 'panorama')), 'aucune illustration de ce nom');
  await refuse('couleur d’encadré inconnue du style', (d) => (d.elements.find((e: Dict) => e.id === 'capsule').encadre = 'inconnue'), 'couleur d\'encadré inconnue');
  await refuse('autre identifiant', (d) => (d.id = '2B'), 'identifiant 2B');
  await refuse('autre format', (d) => (d.trim = { widthIn: 8.5, heightIn: 11 }), 'format');
  await refuse('champ inconnu', (d) => (d.elements[0].bidule = 1), 'bidule');
  const chained = structuredClone(ok.data.document);
  chained.chaines = [{ id: 'corps', cadres: ['texte'], paragraphes: [{ id: 'p1', intertitre: false, maxChars: 200 }] }];
  const t = chained.elements.find((e: Dict) => e.id === 'texte');
  delete t.maxChars;
  t.chaine = 'corps';
  const withChain = await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '2Y', empreinte: ok.data.empreinte, document: chained });
  check('chaîne éditée : écrite', withChain.status === 200 && JSON.parse(bytes(gabarit('2Y.json')).toString()).chaines[0].cadres[0] === 'texte');
  const cut = structuredClone(chained);
  cut.elements = cut.elements.filter((e: Dict) => e.id !== 'texte');
  const noFrame = await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '2Y', empreinte: withChain.data.empreinte, document: cut });
  check('refus au schéma : cadre d’une chaîne supprimé, 409, motif', noFrame.status === 409 && noFrame.data.error.includes('cadre texte absent des éléments'), noFrame.data);
  check('route enregistrer : corps invalide, 400', (await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '2Y', empreinte: 'abc', document: {} })).status === 400);
  check('route enregistrer : sans document, 400', (await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '2Y', empreinte: null })).status === 400);
  check('route enregistrer : sans en-tête, 403', (await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '2Y', empreinte: null, document: {} }, { ...headers, 'x-book-print': '0' })).status === 403);
  check('route enregistrer : autre Origin, 403', (await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '2Y', empreinte: null, document: {} }, { ...headers, Origin: 'http://ailleurs.example' })).status === 403);
  check('route enregistrer : autre Host, 403', (await post('/api/mise-en-page/enregistrer', {}, { ...headers, Host: 'ailleurs.example' })).status === 403);
  for (const route of ['enregistrer', 'nouvelle', 'copier', 'miroir']) check(`route ${route} : GET, 405`, (await request({ method: 'GET', path: `/api/mise-en-page/${route}` })).status === 405);
  check('route enregistrer : modèle absent, 409', (await post('/api/mise-en-page/enregistrer', { bookId: BOOK_ID, id: '8Z', empreinte: null, document: {} })).status === 409);

  // Nouvelle mise en page et copie : jamais d'écrasement.
  const created = await post('/api/mise-en-page/nouvelle', { bookId: BOOK_ID, id: '4N', start: 'droite' });
  const n = JSON.parse(fs.readFileSync(gabarit('4N.json'), 'utf8'));
  check('nouvelle : vide, au format du livre, pages de l’identifiant, départ choisi', created.status === 200 && n.schemaVersion === 2 && n.pages === 4 && n.start === 'droite' && n.trim.widthIn === 6 && n.elements.length === 0 && created.data.document.id === '4N');
  const again = await post('/api/mise-en-page/nouvelle', { bookId: BOOK_ID, id: '4N', start: 'gauche' });
  check('nouvelle : identifiant pris, 409, rien d’écrasé', again.status === 409 && again.data.error.includes('existe déjà') && JSON.parse(fs.readFileSync(gabarit('4N.json'), 'utf8')).start === 'droite');
  check('nouvelle : 1 page, 409', (await post('/api/mise-en-page/nouvelle', { bookId: BOOK_ID, id: '1A', start: 'gauche' })).status === 409 && !fs.existsSync(gabarit('1A.json')));
  check('nouvelle : identifiant hors motif, 400', (await post('/api/mise-en-page/nouvelle', { bookId: BOOK_ID, id: '../2A', start: 'gauche' })).status === 400);
  const copied = await post('/api/mise-en-page/copier', { bookId: BOOK_ID, id: '2Y', nouvel: '2K' });
  check('copie : nouvel identifiant, même contenu', copied.status === 200 && JSON.stringify({ ...JSON.parse(fs.readFileSync(gabarit('2K.json'), 'utf8')), id: '2Y' }) === JSON.stringify(JSON.parse(bytes(gabarit('2Y.json')).toString())));
  check('copie : vers un identifiant pris, 409', (await post('/api/mise-en-page/copier', { bookId: BOOK_ID, id: '2Y', nouvel: '2A' })).status === 409);
  check('copie : autre nombre de pages, 409', (await post('/api/mise-en-page/copier', { bookId: BOOK_ID, id: '2Y', nouvel: '4C' })).status === 409 && !fs.existsSync(gabarit('4C.json')));

  // Miroir : modèle sans élément à cheval retourné ; avec, refusé ; empreinte périmée refusée.
  const mm = (await post('/api/mise-en-page/state', { bookId: BOOK_ID, id: '2M' })).data;
  const mir = await post('/api/mise-en-page/miroir', { bookId: BOOK_ID, id: '2M', empreinte: mm.empreinte });
  const written = JSON.parse(fs.readFileSync(gabarit('2M.json'), 'utf8'));
  check('miroir : écrit, départ à droite, x retourné', mir.status === 200 && written.start === 'droite' && near(written.elements.find((e: Dict) => e.id === 'capsule').x, W - mm.document.elements.find((e: Dict) => e.id === 'capsule').x - 62));
  check('miroir : fichier égal au miroir pur', fs.readFileSync(gabarit('2M.json'), 'utf8') === layoutJson((mirrorLayout(layoutSchema.parse(mm.document)) as Dict).layout));
  check('miroir : empreinte périmée, 409, conflit', (await post('/api/mise-en-page/miroir', { bookId: BOOK_ID, id: '2M', empreinte: mm.empreinte })).data.conflit === true);
  const yy = (await post('/api/mise-en-page/state', { bookId: BOOK_ID, id: '2Y' })).data;
  const keep = bytes(gabarit('2Y.json'));
  const mirSpread = await post('/api/mise-en-page/miroir', { bookId: BOOK_ID, id: '2Y', empreinte: yy.empreinte });
  check('miroir refusé : élément à cheval, motif, rien d’écrit', mirSpread.status === 409 && mirSpread.data.error.includes('à cheval') && bytes(gabarit('2Y.json')).equals(keep), mirSpread.data);
  check('miroir : réservé aux modèles (sujet refusé, 400)', (await post('/api/mise-en-page/miroir', { dir: BOOK_DIR, subjectId: 'alpha', empreinte: yy.empreinte })).status === 400);

  // Sujet d'avant ED1 : premier enregistrement, sans changement, à HTML identique ; `modele` noté.
  const beta = (await post('/api/mise-en-page/state', { dir: BOOK_DIR, subjectId: 'beta' })).data;
  check('sujet d’avant ED1 : conversion à éditer, aucune empreinte (pas encore de layout.json)', beta.cible === 'sujet' && beta.empreinte === null && beta.document.schemaVersion === 2 && beta.target.endsWith('subjects/beta/layout.json'));
  const html = async () => (await get(`/apercu-sujet?dir=${BOOK_DIR}&subject=beta`)).body;
  const htmlBefore = await html();
  const twoAsha = sha256(bytes(gabarit('2A.json')));
  const first = await post('/api/mise-en-page/enregistrer', { dir: BOOK_DIR, subjectId: 'beta', empreinte: null, document: beta.document });
  const layoutFile = path.join(dataRoot, BOOK_ID, 'subjects', 'beta', 'layout.json');
  const written2 = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
  check('sujet d’avant ED1 : layout.json écrit, converti, avec modele', first.status === 200 && written2.schemaVersion === 2 && written2.modele.id === '2A' && written2.modele.empreinte === twoAsha && first.data.source === 'layout.json', first.data);
  check('sujet d’avant ED1 : HTML de l’aperçu identique avant et après', htmlBefore === (await html()) && htmlBefore.length > 1000);
  check('sujet : seconde écriture comme absent, 409, conflit', (await post('/api/mise-en-page/enregistrer', { dir: BOOK_DIR, subjectId: 'beta', empreinte: null, document: beta.document })).data.conflit === true);
  const doc = structuredClone(first.data.document);
  doc.modele = { id: '9Z', empreinte: '0'.repeat(64), date: '2000-01-01T00:00:00.000Z' };
  doc.elements[1].y += 1;
  const second = await post('/api/mise-en-page/enregistrer', { dir: BOOK_DIR, subjectId: 'beta', empreinte: first.data.empreinte, document: doc });
  check('sujet : l’origine reste celle de la copie, jamais celle du document envoyé', second.status === 200 && JSON.parse(fs.readFileSync(layoutFile, 'utf8')).modele.id === '2A');
  const morePages = await post('/api/mise-en-page/enregistrer', { dir: BOOK_DIR, subjectId: 'beta', empreinte: second.data.empreinte, document: { ...doc, id: '4A', pages: 4 } });
  check('sujet : autre nombre de pages, 409', morePages.status === 409, morePages.data);

  // Éditeur d'un sujet : texte réel là où il existe (titre, blocs importés, légende du QR), remplissage ailleurs.
  const alphaCtx = subjectContext(dataRoot, BOOK_ID, 'alpha', readBook(glbRoot, BOOK_DIR).scenes);
  const research = makeResearch('alpha');
  (research as { schemaVersion: number }).schemaVersion = 2;
  research.blocks = alphaCtx.expected.map((b) => ({ zone: b.zone, type: b.type, ...(b.item ? { item: b.item } : {}), ...(b.heading ? { heading: `En-tête importé ${b.id}` } : {}), text: `Texte importé ${b.id}`, claims: ['c1'] })) as typeof research.blocks;
  const merged = mergeImport(research, null, alphaCtx.subject, alphaCtx.expected);
  // ED4 : l'en-tête de la question vidé dans la relecture, le temps de le récrire : l'éditeur y met le remplissage.
  const question = merged.subject.blocks.find((b) => b.id === 'question')!;
  question.heading = { fr: '' };
  updateSubject(dataRoot, BOOK_ID, 'alpha', () => ({ subject: merged.subject, research: merged.research }));
  const alphaHtml = (await get(`/apercu-mise-en-page?dir=${BOOK_DIR}&subject=alpha`)).body;
  check('éditeur d’un sujet : bloc importé en texte réel', alphaHtml.includes('Texte importé chapeau') && alphaHtml.includes('Texte importé capsule'), alphaCtx.expected.map((b) => b.id));
  check('éditeur d’un sujet : titre de la scène, légende du QR réelle', alphaHtml.includes('alpha fr') && alphaHtml.includes('Scanne-moi'));
  check('éditeur d’un sujet : en-tête importé en texte réel (ED4)', alphaHtml.includes('<b class="entete">En-tête importé capsule</b>'));
  check('éditeur d’un sujet : remplissage là où rien n’est écrit (en-tête vide)', alphaHtml.includes('Texte de remplissage'));
  const control = await post('/api/mise-en-page/controle', { dir: BOOK_DIR, subjectId: 'alpha' });
  check('éditeur d’un sujet : « Contrôler », sept contrôles', control.status === 200 && control.data.checks.map((c: Dict) => c.id).join() === 'C3,C4,C6,C7,C8,C12,C17', control.data);

  // Mise en page modifiée après la recherche : déplacer ne change pas les blocs ; ajouter un élément à texte crée l'écart.
  const alpha = (await post('/api/mise-en-page/state', { dir: BOOK_DIR, subjectId: 'alpha' })).data;
  const shifted = structuredClone(alpha.document);
  shifted.elements.find((e: Dict) => e.id === 'chapeau').y += 2;
  const s1 = await post('/api/mise-en-page/enregistrer', { dir: BOOK_DIR, subjectId: 'alpha', empreinte: alpha.empreinte, document: shifted });
  const parcours = async () => (await post('/api/parcours', { dir: BOOK_DIR })).data.subjects.find((s: Dict) => s.id === 'alpha').steps.find((s: Dict) => s.id === 'sujet-recherche');
  check('déplacer après la recherche : blocs inchangés', s1.status === 200 && (await parcours()).state !== 'erreur', await parcours());
  const plus = structuredClone(s1.data.document);
  plus.elements.push({ id: 'legende-2', type: 'legende', page: 1, x: 20, y: 172, w: 60, h: 10, maxChars: 80 });
  const s2 = await post('/api/mise-en-page/enregistrer', { dir: BOOK_DIR, subjectId: 'alpha', empreinte: s1.data.empreinte, document: plus });
  check('ajouter un élément à texte après la recherche : écart des blocs, Recherche en erreur', s2.status === 200 && (await parcours()).state === 'erreur' && JSON.stringify((await parcours()).reasons).includes('legende-2'), await parcours());
}

// Gestes dans Chromium : étape « Mises en page » sur 2Y, puis étape « Mise en page » d'un sujet.
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 650 } });
const pageErrors: string[] = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const url = `http://${host}/`;
async function until(expression: string, limit = 30_000): Promise<void> {
  const end = Date.now() + limit;
  while (!(await page.evaluate(expression))) {
    if (Date.now() > end) throw new Error(`attente trop longue : ${expression}`);
    await page.waitForTimeout(25);
  }
}
async function untilFile(file: string, test: (text: string) => boolean, limit = 15_000): Promise<string> {
  const end = Date.now() + limit;
  for (;;) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (test(text)) return text;
    if (Date.now() > end) return text;
    await page.waitForTimeout(50);
  }
}
/** Écritures finies : rien en attente dans la file de la page. */
const settled = () => page.waitForTimeout(400);
/** Un point en mm de la bande des pages, en pixels de la fenêtre. */
async function px(svg: string, x: number, y: number): Promise<{ x: number; y: number }> {
  return (await page.evaluate(`(() => { const s = document.getElementById('${svg}'); const p = s.createSVGPoint(); p.x = ${x}; p.y = ${y}; const r = p.matrixTransform(s.getScreenCTM()); return { x: r.x, y: r.y }; })()`)) as { x: number; y: number };
}
/** Abscisse d'un élément dans la bande des pages : la page gauche commence par son fond perdu ; la page droite suit, sans fond perdu à gauche. */
const stripX = (e: Dict) => (e.page === 0 ? BLEED : W + BLEED) + e.x;
const at = (e: Dict, dx = 0, dy = 0): [number, number] => [stripX(e) + dx, BLEED + e.y + dy];
async function drag(svg: string, from: [number, number], to: [number, number], before?: () => Promise<void>): Promise<void> {
  const a = await px(svg, from[0], from[1]);
  const b = await px(svg, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  if (before) await before();
  await page.mouse.up();
}
const guideKinds = () => page.evaluate(`[...document.querySelectorAll('#ga-reperes g[data-layer="guides"] line')].map((l) => l.dataset.kind).join()`) as Promise<string>;
const fileOf = (name: string) => JSON.parse(fs.readFileSync(gabarit(name), 'utf8')) as Dict;
const el = (doc: Dict, id: string) => doc.elements.find((e: Dict) => e.id === id) as Dict;
/** Le fichier attendu après un geste : le précédent, modifié, validé par le schéma. */
async function expectFile(name: string, base: Dict, label: string, change: (d: Dict) => void): Promise<Dict> {
  const prev = structuredClone(base);
  change(prev);
  const want = expected(prev);
  const got = await untilFile(gabarit(name), (t) => t === want);
  const at = [...want].findIndex((ch, i) => got[i] !== ch);
  check(`geste : ${label}, fichier écrit identique à l’attendu`, got === want, { got: got.slice(Math.max(0, at - 200), at + 200), want: want.slice(Math.max(0, at - 200), at + 200) });
  await settled();
  return JSON.parse(got || '{}');
}

{
  // Ouvrir l'étape : dossier créé, prix retenu, collection présente.
  put(dataRoot, 'collection/gabarits/2Y.json', synthese('2Y', SIX_NINE, M));
  await page.goto(url);
  await until(`document.querySelector('#choix').value !== ''`);
  await page.click('#etapes button[data-step="prix"]');
  await page.fill('#p-nom', 'Essai');
  await page.selectOption('#p-mode', 'saisi');
  await page.fill('#p-pages', '46');
  await page.click('#p-enregistrer');
  await page.click('#v-scenarios');
  await page.waitForSelector('#prix-scenarios table');
  await page.click('#prix-scenarios button:has-text("Retenir")');
  await until(`document.querySelector('#etapes button[data-step="gabarits"]').getAttribute('aria-disabled') !== 'true'`);
  await page.click('#etapes button[data-step="gabarits"]');
  await until(`document.querySelector('#ga-liste table') !== null`);
  await page.click('#ga-liste button:has-text("2Y")');
  await until(`document.querySelector('#ga-reperes rect.r-cible[data-id="capsule"]') !== null && document.querySelector('#ga-apercu').getAttribute('src')?.includes('id=2Y')`);
  for (const box of await page.$$('input[data-gabarit-layer]')) await box.check();
  check('page : éditeur ouvert sur 2Y, onze éléments, double page', (await page.locator('#ga-elements tr[data-element]').count()) === 11 && (await page.textContent('#ga-pages-texte'))!.includes('Pages 1–2 sur 2'));

  let doc = fileOf('2Y.json');
  // Glisser : sécurité, grille, pli (le repère affiché pendant le geste).
  const cap = el(doc, 'capsule'); // x = 14, y = 14
  let kinds = '';
  await drag('ga-reperes', at(cap, 10, 10), at(cap, 10 - 1.2, 10), async () => void (kinds = await guideKinds()));
  check('geste : repère affiché pendant le glissement (sécurité)', kinds.includes('sécurité'), kinds);
  doc = await expectFile('2Y.json', doc, 'glisser, aimanté à la zone de sécurité', (d) => (el(d, 'capsule').x = 12));
  const col = 12 + (W - 12 - 20 - 10) / 3 + 5; // bord gauche de la deuxième colonne
  await drag('ga-reperes', at(el(doc, 'capsule'), 10, 10), at(el(doc, 'capsule'), 10 + col - 12 - 0.9, 10), async () => void (kinds = await guideKinds()));
  check('geste : repère de la grille affiché', kinds.includes('grille'), kinds);
  doc = await expectFile('2Y.json', doc, 'glisser, aimanté à une colonne de la grille', (d) => (el(d, 'capsule').x = E.r6(col)));
  const toBand = W - 15 - 62 - el(doc, 'capsule').x - 0.8;
  await drag('ga-reperes', at(el(doc, 'capsule'), 10, 10), at(el(doc, 'capsule'), 10 + toBand, 10), async () => void (kinds = await guideKinds()));
  check('geste : repère de la bande du pli affiché', kinds.includes('pli'), kinds);
  doc = await expectFile('2Y.json', doc, 'glisser, aimanté à la bande du pli', (d) => (el(d, 'capsule').x = E.r6(W - 15 - 62)));
  check('geste : repères effacés après le lâcher', (await guideKinds()) === '');
  // Bandeau : bas de la page rognée (fond perdu bas coché), puis fond perdu haut (aimanté au-delà de la rogne).
  const band = el(doc, 'bandeau'); // y = 110, h = 30, fondPerdu exterieur
  await drag('ga-reperes', at(band, 40, 10), at(band, 40, 10 + (H - 140) - 0.6), async () => void (kinds = await guideKinds()));
  check('geste : repère de la page rognée affiché', kinds.includes('rogne'), kinds);
  doc = await expectFile('2Y.json', doc, 'bandeau aimanté en bas : fond perdu bas coché', (d) => Object.assign(el(d, 'bandeau'), { y: E.r6(H - 30), fondPerdu: ['bas', 'exterieur'] }));
  await drag('ga-reperes', at(el(doc, 'bandeau'), 40, 10), at(el(doc, 'bandeau'), 40, 10 - (H - 30) - 2.5), async () => void (kinds = await guideKinds()));
  check('geste : repère du fond perdu affiché', kinds.includes('fond perdu'), kinds);
  doc = await expectFile('2Y.json', doc, 'bandeau aimanté au fond perdu haut : posé au bord, fond perdu haut, bas retiré', (d) => Object.assign(el(d, 'bandeau'), { y: 0, fondPerdu: ['haut', 'exterieur'] }));
  // Poignées : w (aimantée à une colonne), puis s (aimantée au bas de la zone de sécurité).
  await page.click('#ga-elements tr[data-element="capsule"]');
  let c = el(doc, 'capsule');
  await drag('ga-reperes', [stripX(c), BLEED + c.y + c.h / 2], [stripX(c) - (c.x - (col + (W - 12 - 20 - 10) / 3 + 5)) - 0.5, BLEED + c.y + c.h / 2]);
  const third = col + (W - 12 - 20 - 10) / 3 + 5;
  doc = await expectFile('2Y.json', doc, 'poignée w aimantée à une colonne, bord droit en place', (d) => Object.assign(el(d, 'capsule'), { x: E.r6(third), w: E.r6(W - 15 - third) }));
  c = el(doc, 'capsule');
  await drag('ga-reperes', [stripX(c) + c.w / 2, BLEED + c.y + c.h], [stripX(c) + c.w / 2, BLEED + (H - 12) - 1]);
  doc = await expectFile('2Y.json', doc, 'poignée s aimantée au bas de la zone de sécurité', (d) => (el(d, 'capsule').h = E.r6(H - 12 - el(d, 'capsule').y)));
  c = el(doc, 'capsule');
  await drag('ga-reperes', [stripX(c) + c.w, BLEED + c.y], [stripX(c) + c.w - 3.3, BLEED + c.y + 4.2]);
  await untilFile(gabarit('2Y.json'), (t) => JSON.parse(t).elements.find((e: Dict) => e.id === 'capsule').y !== c.y);
  await settled();
  const ne = el(fileOf('2Y.json'), 'capsule');
  const tenth = (n: number) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-6;
  check('poignée ne : bord gauche et bord bas en place, nouveaux bords au dixième de mm', near(ne.x, c.x) && near(ne.y + ne.h, c.y + c.h) && tenth(ne.y) && tenth(ne.x + ne.w) && Math.abs(ne.w - (c.w - 3.3)) < 0.3 && Math.abs(ne.y - (c.y + 4.2)) < 0.3, { avant: c, apres: ne });
  doc = fileOf('2Y.json');
  // Clavier : flèche, Maj + flèche, Ctrl+Z, Ctrl+Y, Ctrl+Maj+Z.
  await page.keyboard.press('ArrowRight');
  doc = await expectFile('2Y.json', doc, 'flèche : 0,5 mm', (d) => (el(d, 'capsule').x = E.r6(el(d, 'capsule').x + 0.5)));
  const beforeShift = fs.readFileSync(gabarit('2Y.json'), 'utf8');
  await page.keyboard.press('Shift+ArrowUp');
  doc = await expectFile('2Y.json', doc, 'Maj + flèche : 5 mm', (d) => (el(d, 'capsule').y = E.r6(el(d, 'capsule').y - 5)));
  let afterShift = fs.readFileSync(gabarit('2Y.json'), 'utf8');
  await page.keyboard.press('Control+z');
  check('Ctrl+Z : fichier revenu au pas précédent', (await untilFile(gabarit('2Y.json'), (t) => t === beforeShift)) === beforeShift);
  await settled();
  await page.keyboard.press('Control+y');
  check('Ctrl+Y : rétabli', (await untilFile(gabarit('2Y.json'), (t) => t === afterShift)) === afterShift);
  await settled();
  await page.keyboard.press('Control+z');
  await untilFile(gabarit('2Y.json'), (t) => t === beforeShift);
  await settled();
  await page.keyboard.press('Control+Shift+Z');
  check('Ctrl+Maj+Z : rétabli', (await untilFile(gabarit('2Y.json'), (t) => t === afterShift)) === afterShift);
  await settled();
  doc = fileOf('2Y.json');
  // Réponses lentes du serveur (comme sous Windows, constat de la vérification) : un geste commencé pendant qu'une réponse arrive n'est pas
  // perdu ; Ctrl+Z pressé peu après annule le bon pas.
  await page.route('**/api/mise-en-page/enregistrer', async (route) => {
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 900));
    await route.fulfill({ response });
  });
  {
    // L'action qui précède change les motifs (C17 : la capsule ne chevauche plus rien) : leur zone change de contenu à l'arrivée de la réponse.
    const c0 = el(doc, 'capsule');
    const motifs0 = (await page.textContent('#ga-motifs')) ?? '';
    await page.fill('#ga-p-hauteur-mm-', '20');
    await page.press('#ga-p-hauteur-mm-', 'Enter');
    await untilFile(gabarit('2Y.json'), (t) => el(JSON.parse(t), 'capsule').h !== c0.h);
    await page.mouse.click(1, 1);
    await page.waitForTimeout(300);
    const c1 = el(fileOf('2Y.json'), 'capsule');
    const frameBefore = (await page.evaluate(`document.getElementById('ga-cadre').getBoundingClientRect().height`)) as number;
    // La poignée e glissée pendant que la réponse de la flèche arrive.
    // La main parcourt 7,3 mm à l'échelle du début du geste, quoi qu'il arrive au panneau pendant le geste.
    const a = await px('ga-reperes', stripX(c1) + c1.w, BLEED + c1.y + c1.h / 2);
    const z = await px('ga-reperes', stripX(c1) + c1.w - 7.3, BLEED + c1.y + c1.h / 2);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(a.x + ((z.x - a.x) * i) / 12, a.y);
      await page.waitForTimeout(60);
    }
    const frameDuring = (await page.evaluate(`document.getElementById('ga-cadre').getBoundingClientRect().height`)) as number;
    await page.mouse.up();
    const resized = el(JSON.parse(await untilFile(gabarit('2Y.json'), (t) => el(JSON.parse(t), 'capsule').w !== c1.w)), 'capsule');
    check('réponse lente : la poignée glissée pendant l’arrivée d’une réponse redimensionne de ce que le pointeur a parcouru', Math.abs(resized.w - (c1.w - 7.3)) < 0.3 && near(resized.x, c1.x), { avant: c1, apres: resized });
    check('réponse lente : le panneau a bougé pendant le geste (bandeau des motifs de l’étape), le geste a suivi le pointeur', !near(frameDuring, frameBefore, 0.5) && motifs0.includes('C17'), { frameBefore, frameDuring });
    await page.waitForTimeout(1500);
    const lentOne = fs.readFileSync(gabarit('2Y.json'), 'utf8');
    await page.keyboard.press('ArrowRight');
    await untilFile(gabarit('2Y.json'), (t) => t !== lentOne);
    await page.waitForTimeout(500);
    const lentTwo = fs.readFileSync(gabarit('2Y.json'), 'utf8');
    await page.keyboard.press('Shift+ArrowUp');
    await untilFile(gabarit('2Y.json'), (t) => t !== lentTwo);
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+z');
    check('réponse lente : Ctrl+Z annule le dernier pas', (await untilFile(gabarit('2Y.json'), (t) => t === lentTwo)) === lentTwo);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Control+z');
    check('réponse lente : Ctrl+Z encore, le pas d’avant', (await untilFile(gabarit('2Y.json'), (t) => t === lentOne)) === lentOne);
    await page.waitForTimeout(1500);
  }
  await page.unroute('**/api/mise-en-page/enregistrer');
  doc = fileOf('2Y.json');
  afterShift = fs.readFileSync(gabarit('2Y.json'), 'utf8');

  // Ctrl+Z pressé aussitôt, pendant l'écriture de l'action : c'est cette action qui est annulée.
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Control+z');
  await settled();
  check('Ctrl+Z pressé pendant l’écriture : annule cette action, pas la précédente', (await untilFile(gabarit('2Y.json'), (t) => t === afterShift)) === afterShift && (await untilFile(gabarit('2Y.json'), (t) => t === afterShift, 1500)) === afterShift);
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  await settled();
  const down = expected({ ...doc, elements: doc.elements.map((e: Dict) => (e.id === 'capsule' ? { ...e, y: E.r6(e.y + 5) } : e)) });
  check('Ctrl+Z puis Ctrl+Y aussitôt : l’action rétablie', (await untilFile(gabarit('2Y.json'), (t) => t === down)) === down);
  await page.keyboard.press('Control+z');
  await untilFile(gabarit('2Y.json'), (t) => t === afterShift);
  await settled();
  // Échap, Suppr, ordre.
  await page.keyboard.press('Escape');
  check('Échap : plus rien de choisi', (await page.evaluate(`document.querySelector('#ga-reperes g[data-selection]').getAttribute('display')`)) === 'none' && (await page.textContent('#ga-proprietes'))!.includes('Mise en page 2Y'));
  const unchanged = fs.readFileSync(gabarit('2Y.json'), 'utf8');
  await page.keyboard.press('ArrowLeft');
  await settled();
  check('flèche sans élément choisi : rien', fs.readFileSync(gabarit('2Y.json'), 'utf8') === unchanged);
  await page.click('#ga-elements tr[data-element="question"]');
  await page.keyboard.press('Delete');
  doc = await expectFile('2Y.json', doc, 'Suppr', (d) => (d.elements = d.elements.filter((e: Dict) => e.id !== 'question')));
  await page.click('#ga-elements tr[data-element="chapeau"]');
  await page.click('#ga-monter');
  doc = await expectFile('2Y.json', doc, 'Monter : au-dessus du suivant', (d) => {
    const i = d.elements.findIndex((e: Dict) => e.id === 'chapeau');
    [d.elements[i], d.elements[i + 1]] = [d.elements[i + 1], d.elements[i]];
  });
  await page.click('#ga-descendre');
  doc = await expectFile('2Y.json', doc, 'Descendre', (d) => {
    const i = d.elements.findIndex((e: Dict) => e.id === 'chapeau');
    [d.elements[i], d.elements[i - 1]] = [d.elements[i - 1], d.elements[i]];
  });
  // Propriétés : un champ au dixième de mm.
  await page.fill('#ga-p-x-mm-', '21,25');
  await page.press('#ga-p-x-mm-', 'Enter');
  doc = await expectFile('2Y.json', doc, 'champ x', (d) => (el(d, 'chapeau').x = 21.25));
  // Ajouter : un encadré au centre de la zone de sécurité de la page gauche.
  await page.selectOption('#ga-ajouter-type', 'encadre');
  doc = await expectFile('2Y.json', doc, 'Ajouter un encadré', (d) => d.elements.push({ id: 'encadre-1', type: 'encadre', page: 0, x: E.r1((12 + W - 20) / 2 - 30), y: E.r1((12 + H - 12) / 2 - 15), w: 60, h: 30, maxChars: 200, encadre: 'fiche' }));
  check('Ajouter : l’élément ajouté est choisi', (await page.getAttribute('#ga-elements tr[data-element="encadre-1"]', 'aria-current')) === 'true');
  check('Ajouter : le menu rend le curseur', (await page.evaluate('document.activeElement === document.body')) === true);
  // Un champ garde le curseur, puis un clic sur la page : le clavier revient à l'éditeur (constat de David au jugement).
  await page.focus('#ga-theme');
  const enc = el(doc, 'encadre-1');
  const p0 = await px('ga-reperes', stripX(enc) + 5, BLEED + enc.y + 5);
  await page.mouse.click(p0.x, p0.y);
  await page.keyboard.press('ArrowRight');
  doc = await expectFile('2Y.json', doc, 'flèche après un clic sur la page, un champ ayant gardé le curseur', (d) => (el(d, 'encadre-1').x = E.r6(el(d, 'encadre-1').x + 0.5)));
  check('clic sur la page : le thème n’a pas bougé', (await page.inputValue('#ga-theme')) === 'foret');
  // Chaîne : créée depuis un texte, paragraphe ajouté, lettrine.
  await page.click('#ga-elements tr[data-element="texte"]');
  await page.click('#ga-chaine-nouvelle');
  doc = await expectFile('2Y.json', doc, 'Nouvelle chaîne depuis un texte', (d) => {
    d.chaines = [{ id: 'chaine-1', cadres: ['texte'], paragraphes: [{ id: 'p1', intertitre: false, maxChars: 220 }] }];
    const t = el(d, 'texte');
    delete t.maxChars;
    t.chaine = 'chaine-1';
  });
  await page.click('#ga-proprietes button[aria-label="Ajouter un paragraphe"]');
  doc = await expectFile('2Y.json', doc, 'paragraphe ajouté', (d) => d.chaines[0].paragraphes.push({ id: 'p2', intertitre: false, maxChars: 200 }));
  await page.check('#ga-proprietes input[data-champ="Lettrine"]');
  doc = await expectFile('2Y.json', doc, 'lettrine', (d) => (d.chaines[0].lettrine = true));
  await page.check('#ga-proprietes input[aria-label="Intertitre de p2"]');
  doc = await expectFile('2Y.json', doc, 'intertitre', (d) => Object.assign(d.chaines[0].paragraphes[1], { intertitre: true, headingMaxChars: 30 }));
  // Refus au schéma : le cadre d'une chaîne supprimé ; rien n'est écrit ni gardé dans l'historique.
  const kept = fs.readFileSync(gabarit('2Y.json'), 'utf8');
  await page.click('#ga-elements tr[data-element="texte"]');
  await page.keyboard.press('Delete');
  await until(`document.querySelector('#ga-motifs').textContent.includes('absent des éléments')`);
  check('refus : motif du schéma affiché, fichier inchangé, élément toujours listé', fs.readFileSync(gabarit('2Y.json'), 'utf8') === kept && (await page.locator('#ga-elements tr[data-element="texte"]').count()) === 1);
  await page.keyboard.press('Control+z');
  doc = await expectFile('2Y.json', doc, 'Ctrl+Z après un refus : annule l’intertitre, pas le refus', (d) => {
    d.chaines[0].paragraphes[1].intertitre = false;
    delete d.chaines[0].paragraphes[1].headingMaxChars;
  });
  // Écriture concurrente : le fichier change ailleurs ; l'action suivante est refusée, le fichier relu, l'historique vidé.
  const outside = fileOf('2Y.json');
  el(outside, 'folio-g').h = 8;
  fs.writeFileSync(gabarit('2Y.json'), expected(outside));
  const foreign = fs.readFileSync(gabarit('2Y.json'), 'utf8');
  await page.click('#ga-elements tr[data-element="capsule"]');
  await page.keyboard.press('ArrowDown');
  await until(`document.querySelector('#ga-motifs').textContent.includes('a changé depuis sa lecture')`);
  check('écriture concurrente : refusée, fichier d’ailleurs gardé', fs.readFileSync(gabarit('2Y.json'), 'utf8') === foreign);
  await page.keyboard.press('Control+z');
  await settled();
  check('écriture concurrente : historique reparti de zéro (Ctrl+Z sans effet)', fs.readFileSync(gabarit('2Y.json'), 'utf8') === foreign);
  doc = JSON.parse(foreign);
  await page.click('#ga-elements tr[data-element="capsule"]');
  await page.keyboard.press('ArrowDown');
  await expectFile('2Y.json', doc, 'après relecture, l’action part du fichier relu', (d) => (el(d, 'capsule').y = E.r6(el(d, 'capsule').y + 0.5)));
  // « Recharger » : fichier relu, historique vidé.
  await settled();
  await Promise.all([page.waitForResponse((r) => r.url().includes('/api/mise-en-page/state')), page.click('#ga-recharger')]);
  await until(`document.querySelector('#ga-reperes rect.r-cible[data-id="capsule"]') !== null`);
  await settled();
  const reloaded = fs.readFileSync(gabarit('2Y.json'), 'utf8');
  await page.keyboard.press('Control+z');
  await settled();
  check('Recharger : historique reparti de zéro', fs.readFileSync(gabarit('2Y.json'), 'utf8') === reloaded);

  // Miroir : 2M retourné ; refusé sur 2Y (élément à cheval).
  await page.click('#ga-miroir');
  await until(`document.querySelector('#ga-motifs').textContent.includes('à cheval')`);
  check('Miroir refusé : motif, fichier inchangé', fs.readFileSync(gabarit('2Y.json'), 'utf8') === reloaded);
  put(dataRoot, 'collection/gabarits/2M.json', simple());
  await page.click('#ga-recharger');
  await until(`document.querySelector('#ga-liste button[data-gabarit], #ga-liste tr[data-gabarit="2M"] button') !== null`);
  await page.click('#ga-liste tr[data-gabarit="2M"] button');
  await until(`document.querySelector('#ga-apercu').getAttribute('src')?.includes('id=2M') && document.querySelector('#ga-reperes rect.r-cible') !== null`);
  const m0 = fileOf('2M.json');
  await page.click('#ga-miroir');
  const want = layoutJson((mirrorLayout(layoutSchema.parse(m0)) as Dict).layout);
  check('Miroir : fichier égal au miroir', (await untilFile(gabarit('2M.json'), (t) => t === want)) === want);
  await settled();
  await until(`document.querySelector('#ga-pages-texte').textContent.includes('Page 1 sur 2')`, 10_000).catch(() => undefined);
  check('Miroir : départ à droite, deux pages seules (recalculé sans rouvrir)', (await page.textContent('#ga-pages-texte'))!.includes('Page 1 sur 2'), await page.textContent('#ga-pages-texte'));
  await until(`document.querySelector('#ga-liste tr[data-gabarit="2M"]').textContent.includes('droite')`);
  check('Miroir : départ à droite dans la liste', (await page.textContent('#ga-liste tr[data-gabarit="2M"]'))!.includes('droite'));
  await page.keyboard.press('Control+z');
  check('Miroir annulé par Ctrl+Z', JSON.parse(await untilFile(gabarit('2M.json'), (t) => JSON.parse(t).start === 'gauche')).start === 'gauche');
  await settled();
  await until(`document.querySelector('#ga-pages-texte').textContent.includes('Pages 1–2 sur 2')`, 10_000).catch(() => undefined);
  check('Miroir annulé : de nouveau une double page', (await page.textContent('#ga-pages-texte'))!.includes('Pages 1–2 sur 2'), await page.textContent('#ga-pages-texte'));
  await page.click('#ga-miroir');
  await untilFile(gabarit('2M.json'), (t) => JSON.parse(t).start === 'droite');
  await settled();
  await page.click('#ga-miroir');
  await untilFile(gabarit('2M.json'), (t) => JSON.parse(t).start === 'gauche');
  await settled();
  await until(`document.querySelector('#ga-pages-texte').textContent.includes('Pages 1–2 sur 2')`, 10_000).catch(() => undefined);
  check('Miroir deux fois : double page, comme au départ', (await page.textContent('#ga-pages-texte'))!.includes('Pages 1–2 sur 2'), await page.textContent('#ga-pages-texte'));

  // Nouvelle mise en page et copie, par leurs fenêtres ; navigation par double page.
  await page.click('#ga-nouvelle');
  await page.fill('#ga-nouvelle-id', '4P');
  await page.click('#ga-nouvelle-form button[type="submit"]');
  await until(`document.querySelector('#ga-pages-texte').textContent.includes('sur 4')`);
  check('Nouvelle mise en page : écrite, choisie, 4 pages', fs.existsSync(gabarit('4P.json')) && fileOf('4P.json').pages === 4 && (await page.textContent('#ga-pages-texte'))!.includes('Pages 1–2 sur 4'));
  await page.click('#ga-suiv');
  check('navigation : double page suivante', (await page.textContent('#ga-pages-texte'))!.includes('Pages 3–4 sur 4') && (await page.isDisabled('#ga-suiv')));
  await page.selectOption('#ga-ajouter-type', 'texte');
  const p4 = await untilFile(gabarit('4P.json'), (t) => JSON.parse(t).elements.length === 1);
  check('Ajouter sur la double page affichée : page 3 (gauche)', JSON.parse(p4).elements[0].page === 2, p4);
  await settled();
  // Une page seule (départ à droite) : sa voisine ne se voit pas et ne se clique pas (remarque de David au jugement).
  put(dataRoot, 'collection/gabarits/2D.json', { schemaVersion: 2, id: '2D', pages: 2, start: 'droite', trim: SIX_NINE, elements: [{ id: 'a', type: 'fond', page: 0, x: 10, y: 10, w: 50, h: 50 }, { id: 'b', type: 'fond', page: 1, x: 10, y: 10, w: 50, h: 50 }] });
  await Promise.all([page.waitForResponse((r) => r.url().includes('/api/gabarits/state')), page.click('#ga-recharger')]);
  await until(`document.querySelector('#ga-liste tr[data-gabarit="2D"] button') !== null`);
  await page.click('#ga-liste tr[data-gabarit="2D"] button');
  await until(`document.querySelector('#ga-reperes rect.r-cible[data-id="b"]') !== null && document.querySelector('#ga-pages-texte').textContent.includes('Page 1 sur 2')`);
  const shown = (await page.evaluate(`(() => {
    const frame = document.getElementById('ga-cadre').getBoundingClientRect();
    const visible = (id) => { const r = document.querySelector('#ga-reperes rect.r-cible[data-id="' + id + '"]').getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; return x > frame.left && x < frame.right && document.elementFromPoint(x, y)?.dataset?.id === id; };
    const page2 = document.querySelector('#ga-reperes rect.r-cible[data-id="b"]').getBoundingClientRect();
    return { a: visible('a'), b: visible('b'), bInFrame: page2.left < frame.right, clip: getComputedStyle(document.getElementById('ga-echelle')).clipPath };
  })()`)) as Dict;
  check('page seule : la page affichée se clique, la voisine est masquée', shown.a === true && shown.b === false && shown.clip.startsWith('inset('), shown);
  await page.click('#ga-suiv');
  const second = (await page.evaluate(`(() => { const r = document.querySelector('#ga-reperes rect.r-cible[data-id="b"]').getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.dataset?.id ?? null; })()`)) as string | null;
  check('page seule suivante : son élément se clique', second === 'b', second);
  fs.rmSync(gabarit('2D.json'));
  await page.click('#ga-liste tr[data-gabarit="4P"] button');
  await until(`document.querySelector('#ga-pages-texte').textContent.includes('sur 4')`);
  await page.click('#ga-suiv');
  await page.click('#ga-prec');
  check('navigation : double page précédente', (await page.textContent('#ga-pages-texte'))!.includes('Pages 1–2') && (await page.isDisabled('#ga-prec')));
  await page.click('#ga-nouvelle');
  await page.fill('#ga-nouvelle-id', '4P');
  await page.click('#ga-nouvelle-form button[type="submit"]');
  await until(`document.querySelector('#ga-nouvelle-message').textContent !== ''`);
  check('Nouvelle mise en page : identifiant pris, refus dans la fenêtre', (await page.textContent('#ga-nouvelle-message'))!.includes('existe déjà'));
  await page.click('#ga-nouvelle-fenetre [data-fermer]');
  await page.click('#ga-copier');
  await page.fill('#ga-copie-id', '4Q');
  await page.click('#ga-copie-form button[type="submit"]');
  await until(`document.querySelector('#ga-apercu').getAttribute('src')?.includes('id=4Q')`);
  check('Copier : écrite et choisie', fs.existsSync(gabarit('4Q.json')) && fileOf('4Q.json').elements.length === 1);

  // Quarante éléments : aucun défilement de page, aux deux tailles.
  const forty = { schemaVersion: 2, id: '2F', pages: 2, start: 'gauche', trim: SIX_NINE, elements: Array.from({ length: 40 }, (_, i) => ({ id: `fond-${i + 1}`, type: 'fond', page: i % 2, x: 2 * (i % 10), y: 5 * i, w: 20, h: 4 })) };
  put(dataRoot, 'collection/gabarits/2F.json', forty);
  for (const size of [{ width: 1366, height: 650 }, { width: 1920, height: 950 }]) {
    await page.setViewportSize(size);
    await page.click('#ga-recharger');
    await until(`document.querySelector('#ga-liste tr[data-gabarit="2F"] button') !== null`);
    await page.click('#ga-liste tr[data-gabarit="2F"] button');
    await until(`document.querySelectorAll('#ga-elements tr[data-element]').length === 40`);
    await page.click('#ga-elements tr[data-element="fond-40"]');
    const fit = (await page.evaluate(`(() => {
      const root = document.documentElement;
      const clipped = [...document.querySelectorAll('.panneau, .colonne')].filter((e) => e.getClientRects().length && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)).map((e) => e.id || e.className);
      const list = document.querySelector('#ga-elements');
      return { sh: root.scrollHeight, h: innerHeight, sw: root.scrollWidth, w: innerWidth, clipped, scrolls: list.scrollHeight > list.clientHeight, controls: ['#ga-monter', '#ga-supprimer', '#ga-controler', '#ga-miroir', '#ga-proprietes'].every((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.bottom <= innerHeight && r.right <= innerWidth; }) };
    })()`)) as Dict;
    check(`${size.width} × ${size.height}, 40 éléments : aucun défilement de page, la liste défile dans son cadre`, fit.sh <= fit.h && fit.sw <= fit.w && fit.clipped.length === 0 && fit.scrolls && fit.controls, fit);
  }
  await page.setViewportSize({ width: 1366, height: 650 });

  // Les modèles du livre remis en règle (C17), pour ouvrir l'étape Sujets.
  for (const name of ['2F', '2K', '4N', '4P', '4Q', '2M']) fs.rmSync(gabarit(`${name}.json`), { force: true });
  put(dataRoot, 'collection/gabarits/2Y.json', synthese('2Y', SIX_NINE, M));
  await Promise.all([page.waitForResponse((r) => r.url().includes('/api/parcours')), page.click('#ga-recharger')]);
  await until(`document.querySelector('#etapes button[data-step="sujets"]').getAttribute('aria-disabled') !== 'true'`);

  // Étape « Mise en page » d'un sujet : même éditeur, sans Miroir ni Nouvelle ; une flèche écrit layout.json.
  await page.click('#etapes button[data-step="sujets"]');
  await until(`document.querySelector('#sujets-liste tr') !== null`);
  await page.click('#sujets-liste tr:has-text("alpha") button');
  await until(`document.querySelector('#sous-etapes button[data-step="sujet-mise-en-page"]') !== null`);
  await page.click('#sous-etapes button[data-step="sujet-mise-en-page"]');
  await until(`document.querySelector('#mp-reperes rect.r-cible[data-id="chapeau"]') !== null`);
  check('sujet : éditeur, sans Miroir ni Nouvelle', !(await page.isVisible('#ga-miroir')) && (await page.textContent('#mp-theme'))!.includes('foret'));
  const subjectFile = path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'layout.json');
  const sBefore = JSON.parse(fs.readFileSync(subjectFile, 'utf8'));
  await page.click('#mp-elements tr[data-element="chapeau"]');
  await page.keyboard.press('ArrowRight');
  const sAfter = JSON.parse(await untilFile(subjectFile, (t) => JSON.parse(t).elements.find((e: Dict) => e.id === 'chapeau').x !== sBefore.elements.find((e: Dict) => e.id === 'chapeau').x));
  check('sujet : flèche écrite dans layout.json, origine gardée', near(sAfter.elements.find((e: Dict) => e.id === 'chapeau').x, sBefore.elements.find((e: Dict) => e.id === 'chapeau').x + 0.5) && JSON.stringify(sAfter.modele) === JSON.stringify(sBefore.modele));
  await settled();
  check('page : aucune erreur dans la console', pageErrors.length === 0, pageErrors);
}

await browser.close();
server.close();
server.closeAllConnections();
finish('éditeur');
