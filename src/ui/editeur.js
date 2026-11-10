// src/ui/editeur.js — éditeur visuel de mise en page (ED3, spec §24.8), sans bibliothèque : un calque SVG par-dessus la double page (le même
// HTML que le PDF, dans un cadre `sandbox`), des événements de pointeur, un historique d'annulation en mémoire. Le même éditeur sert à l'étape
// du livre « Mises en page » (les modèles) et à l'étape « Mise en page » d'un sujet (sa copie). Le serveur fait foi : chaque action finie est
// écrite par la file d'écritures de la page, avec l'empreinte lue ; une action que le schéma refuse n'est ni écrite ni gardée dans
// l'historique ; un fichier changé ailleurs est relu, et l'historique repart de zéro. Pendant un glissement, seul le calque bouge ; le rendu
// réel est refait après l'écriture. Les textes viennent de fichiers : ils passent toujours par textContent.
//
// Coordonnées : celles de la mise en page, en mm sur la page rognée de l'élément (sur la double page pour un élément à cheval) ; le calque
// dessine dans les mm de la bande des pages du PDF, fond perdu compris, posées côte à côte comme dans l'aperçu.

/* exported EDITEUR, Editeur */

// Partie pure, sans DOM : chargée telle quelle par scripts/test-editeur.ts.
const EDITEUR = (() => {
  const SNAP_MM = 1.5;
  const STEP_MM = 0.5;
  const BIG_STEP_MM = 5;
  const HISTORY_MAX = 100;
  const FOLD_BAND_MM = 15;
  const MIN_MM = 1;
  const MM_PER_IN = 25.4;
  const EDGE_TYPES = ['fond', 'bandeau', 'illustration'];
  const TEXT_TYPES = ['titre', 'chapeau', 'texte', 'encadre', 'chiffre-cle', 'legende', 'etiquette', 'bandeau'];
  const TYPES = ['fond', 'bandeau', 'titre', 'chapeau', 'texte', 'encadre', 'illustration', 'legende', 'chiffre-cle', 'fiche', 'picto', 'etiquette', 'qr', 'folio'];
  const BORDS = ['haut', 'bas', 'exterieur'];
  const TOLERANCE = 1e-6;

  const r1 = (n) => Math.round(n * 10) / 10;
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
  const near = (a, b) => Math.abs(a - b) <= TOLERANCE;
  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** Les pages vues par l'éditeur, depuis la géométrie posée par le serveur, et les doubles pages qu'elles forment. */
  function plan(document, layout, grille) {
    const W = document.trim.widthIn * MM_PER_IN;
    const H = document.trim.heightIn * MM_PER_IN;
    let offset = 0;
    const pages = layout.map((p, index) => {
      const page = {
        index,
        number: p.number,
        side: p.side,
        offset,
        trimLeft: p.trim.left,
        trimTop: p.trim.top,
        width: p.widthMm,
        height: p.heightMm,
        safe: { left: p.safe.left - p.trim.left, right: p.safe.right - p.trim.left, top: p.safe.top - p.trim.top, bottom: p.safe.bottom - p.trim.top },
      };
      offset += p.widthMm;
      return page;
    });
    const bleed = layout.length ? (layout[0].heightMm - H) / 2 : 0;
    const spreads = [];
    for (let i = 0; i < pages.length; ) {
      if (pages[i].side === 'gauche' && pages[i + 1]) {
        spreads.push([i, i + 1]);
        i += 2;
      } else {
        spreads.push([i]);
        i += 1;
      }
    }
    return { W, H, bleed, pages, spreads, grille, strip: offset };
  }

  /** Colonnes de la grille dans la zone de sécurité d'une page, en mm sur la page rognée ; aucune si elles ne tiennent pas. */
  function colonnes(page, grille) {
    const { colonnes: n, gouttiereMm: g } = grille;
    const width = (page.safe.right - page.safe.left - (n - 1) * g) / n;
    if (!(width > 0)) return [];
    return Array.from({ length: n }, (_, k) => {
      const left = page.safe.left + k * (width + g);
      return { left, right: left + width };
    });
  }

  /** Repères du magnétisme en x, pour un élément de la page `index` (et de la suivante s'il est à cheval). */
  function ciblesX(p, index, double) {
    const out = [];
    (double ? [index, index + 1] : [index]).forEach((pi, k) => {
      const page = p.pages[pi];
      if (!page) return;
      const o = k * p.W;
      out.push({ v: o, kind: 'rogne' }, { v: o + p.W, kind: 'rogne' });
      out.push(page.side === 'gauche' ? { v: o - p.bleed, kind: 'fond perdu' } : { v: o + p.W + p.bleed, kind: 'fond perdu' });
      out.push({ v: o + page.safe.left, kind: 'sécurité' }, { v: o + page.safe.right, kind: 'sécurité' });
      out.push({ v: page.side === 'gauche' ? o + p.W - FOLD_BAND_MM : o + FOLD_BAND_MM, kind: 'pli' });
      for (const c of colonnes(page, p.grille)) out.push({ v: o + c.left, kind: 'grille' }, { v: o + c.right, kind: 'grille' });
    });
    return out;
  }

  function ciblesY(p, index) {
    const page = p.pages[index];
    return [
      { v: 0, kind: 'rogne' },
      { v: p.H, kind: 'rogne' },
      { v: -p.bleed, kind: 'fond perdu' },
      { v: p.H + p.bleed, kind: 'fond perdu' },
      ...(page ? [{ v: page.safe.top, kind: 'sécurité' }, { v: page.safe.bottom, kind: 'sécurité' }] : []),
    ];
  }

  /** Le repère le plus proche d'un des bords, à `SNAP_MM` au plus : le décalage qui y amène le bord. */
  function aimanter(bords, cibles, seuil = SNAP_MM) {
    let best = null;
    for (const b of bords) {
      for (const c of cibles) {
        const d = c.v - b.v;
        if (Math.abs(d) <= seuil + TOLERANCE && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, cible: c, bord: b.bord };
      }
    }
    return best;
  }

  /** Bords de la page rognée que l'élément touche (comme le schéma) : `exterieur` selon le côté de sa page. */
  function bordsTouches(p, e) {
    const out = [];
    if (near(e.y, 0)) out.push('haut');
    if (near(e.y + e.h, p.H)) out.push('bas');
    const side = p.pages[e.page]?.side;
    const outer = e.double ? near(e.x, 0) || near(e.x + e.w, 2 * p.W) : side === 'gauche' ? near(e.x, 0) : near(e.x + e.w, p.W);
    if (outer) out.push('exterieur');
    return out;
  }

  /** Le bord extérieur de la page de l'élément : celui qui, aimanté, coche le fond perdu `exterieur`. */
  const outerBords = (p, e) => (e.double ? ['gauche', 'droite'] : p.pages[e.page]?.side === 'gauche' ? ['gauche'] : ['droite']);

  /**
   * Fond perdu après un geste (décision de David, ED3) : un fond, un bandeau ou une illustration rectangulaire aimanté sur le bord haut, bas
   * ou extérieur de la page rognée prend le fond perdu de ce bord ; un bord que l'élément ne touche plus perd le sien (le schéma le refuserait).
   * `aimantes` : les bords de l'élément aimantés sur la rogne ou le fond perdu pendant le geste.
   */
  function fondPerdu(p, e, aimantes = []) {
    if (!EDGE_TYPES.includes(e.type) || e.detoure === true) return e;
    const touched = bordsTouches(p, e);
    const add = new Set();
    if (aimantes.includes('haut')) add.add('haut');
    if (aimantes.includes('bas')) add.add('bas');
    if (outerBords(p, e).some((b) => aimantes.includes(b))) add.add('exterieur');
    const kept = BORDS.filter((s) => touched.includes(s) && ((e.fondPerdu ?? []).includes(s) || add.has(s)));
    const out = { ...e };
    if (kept.length) out.fondPerdu = kept;
    else delete out.fondPerdu;
    return out;
  }

  const spanOf = (p, e) => (e.double ? 2 * p.W : p.W);
  const EDGE_KINDS = ['rogne', 'fond perdu'];

  /** Déplacement d'un élément de (dx, dy) mm : magnétisme, puis borne à la page rognée (à la double page pour un élément à cheval). */
  function deplacer(p, e, dx, dy) {
    let x = e.x + dx;
    let y = e.y + dy;
    const sx = aimanter([{ v: x, bord: 'gauche' }, { v: x + e.w, bord: 'droite' }], ciblesX(p, e.page, e.double));
    const sy = aimanter([{ v: y, bord: 'haut' }, { v: y + e.h, bord: 'bas' }], ciblesY(p, e.page));
    if (sx) x += sx.d;
    if (sy) y += sy.d;
    x = clamp(x, 0, spanOf(p, e) - e.w);
    y = clamp(y, 0, p.H - e.h);
    const guides = [];
    const aimantes = [];
    if (sx) {
      guides.push({ axe: 'x', v: sx.cible.v, kind: sx.cible.kind });
      if (EDGE_KINDS.includes(sx.cible.kind)) aimantes.push(sx.bord);
    }
    if (sy) {
      guides.push({ axe: 'y', v: sy.cible.v, kind: sy.cible.kind });
      if (EDGE_KINDS.includes(sy.cible.kind)) aimantes.push(sy.bord);
    }
    // Un axe que le pointeur n'a pas bougé garde sa valeur (pas d'arrondi d'une valeur aimantée).
    const fx = sx ? r6(x) : dx === 0 && x === e.x ? e.x : r1(x);
    const fy = sy ? r6(y) : dy === 0 && y === e.y ? e.y : r1(y);
    return { x: fx, y: fy, w: e.w, h: e.h, guides, aimantes };
  }

  /** Redimensionnement par une poignée (`nw`, `n`, `ne`, `e`, `se`, `s`, `sw`, `w`). `ratio` : largeur / hauteur gardée (détouré déposé). */
  function redimensionner(p, e, handle, dx, dy, ratio) {
    const span = spanOf(p, e);
    let L = e.x;
    let R = e.x + e.w;
    let T = e.y;
    let B = e.y + e.h;
    const guides = [];
    const aimantes = [];
    const snapped = new Set();
    const snap = (v, bord, cibles) => {
      const s = aimanter([{ v, bord }], cibles);
      if (!s) return v;
      guides.push({ axe: bord === 'gauche' || bord === 'droite' ? 'x' : 'y', v: s.cible.v, kind: s.cible.kind });
      if (EDGE_KINDS.includes(s.cible.kind)) aimantes.push(bord);
      snapped.add(bord);
      return v + s.d;
    };
    const cx = ciblesX(p, e.page, e.double);
    const cy = ciblesY(p, e.page);
    if (handle.includes('w')) L = clamp(snap(L + dx, 'gauche', cx), 0, R - MIN_MM);
    if (handle.includes('e')) R = clamp(snap(R + dx, 'droite', cx), L + MIN_MM, span);
    if (handle.includes('n')) T = clamp(snap(T + dy, 'haut', cy), 0, B - MIN_MM);
    if (handle.includes('s')) B = clamp(snap(B + dy, 'bas', cy), T + MIN_MM, p.H);
    if (ratio) {
      // Le rapport de l'image est gardé : la largeur décide quand la poignée agit en x, la hauteur sinon ; le bord opposé reste en place.
      if (handle.includes('e') || handle.includes('w')) {
        let w = R - L;
        let h = w / ratio;
        const room = handle.includes('n') ? B : p.H - T;
        if (h > room) {
          h = room;
          w = h * ratio;
          if (handle.includes('w')) L = R - w;
          else R = L + w;
        }
        if (handle.includes('n')) T = B - h;
        else B = T + h;
      } else {
        let h = B - T;
        let w = h * ratio;
        if (L + w > span) {
          w = span - L;
          h = w / ratio;
          if (handle.includes('n')) T = B - h;
          else B = T + h;
        }
        R = L + w;
      }
    }
    // Au dixième de mm, sauf un bord aimanté (valeur du repère) ou un bord que la poignée ne bouge pas (valeur gardée telle quelle).
    const moved = { gauche: handle.includes('w'), droite: handle.includes('e'), haut: handle.includes('n'), bas: handle.includes('s') };
    const round = (v, bord) => (!moved[bord] || snapped.has(bord) ? r6(v) : r1(v));
    const x = round(L, 'gauche');
    const y = round(T, 'haut');
    const w = ratio ? r6(R - L) : r6(round(R, 'droite') - x);
    const h = ratio ? r6(B - T) : r6(round(B, 'bas') - y);
    return { x: ratio ? r6(L) : x, y: ratio ? r6(T) : y, w, h, guides, aimantes };
  }

  /** Flèches du clavier : 0,5 mm, ou 5 mm avec Maj ; bornées comme un glissement, sans magnétisme. */
  function pas(p, e, dx, dy) {
    return { x: r6(clamp(e.x + dx, 0, spanOf(p, e) - e.w)), y: r6(clamp(e.y + dy, 0, p.H - e.h)) };
  }

  /** Identifiant libre : `<type>-<n>`. */
  function freeId(doc, base) {
    const used = new Set([...doc.elements.map((e) => e.id), ...(doc.chaines ?? []).map((c) => c.id)]);
    for (let n = 1; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  /**
   * Élément ajouté (décision de David, ED3), valide dès sa création : 60 × 30 mm au centre de la zone de sécurité de la page gauche affichée
   * (le QR sur la dernière page, à son côté minimal de 25 mm) ; `maxChars` 200 (40 pour un titre ou un bandeau), première couleur de
   * `palette.boxes`, premier pictogramme du style.
   */
  function nouvelElement(doc, p, type, spread, options) {
    const page = type === 'qr' ? doc.pages - 1 : spread[0];
    const pg = p?.pages[page];
    const safe = pg ? pg.safe : { left: 0, right: doc.trim.widthIn * MM_PER_IN, top: 0, bottom: doc.trim.heightIn * MM_PER_IN };
    const w = 60;
    const h = 30;
    const e = { id: freeId(doc, type), type, page, x: r1((safe.left + safe.right) / 2 - w / 2), y: r1((safe.top + safe.bottom) / 2 - h / 2), w, h };
    if (TEXT_TYPES.includes(type)) e.maxChars = type === 'titre' || type === 'bandeau' ? 40 : 200;
    if (type === 'encadre') e.encadre = options.boxes[0];
    if (type === 'picto') e.picto = options.pictos[0];
    if (type === 'qr') e.qrSideMm = 25;
    return e;
  }

  /** Historique d'annulation en mémoire : 100 pas, perdu au rechargement (le fichier fait foi). */
  function historique() {
    return { annuler: [], retablir: [] };
  }
  function empiler(pile, doc) {
    pile.push(clone(doc));
    if (pile.length > HISTORY_MAX) pile.shift();
  }

  /** Un élément renommé : ses mentions dans la même mise en page suivent (cadres d'une chaîne, image d'une légende). */
  function renommer(doc, from, to) {
    const out = clone(doc);
    for (const e of out.elements) {
      if (e.id === from) e.id = to;
      if (e.image === from) e.image = to;
    }
    for (const c of out.chaines ?? []) c.cadres = c.cadres.map((id) => (id === from ? to : id));
    return out;
  }

  return { SNAP_MM, STEP_MM, BIG_STEP_MM, HISTORY_MAX, FOLD_BAND_MM, EDGE_TYPES, TEXT_TYPES, TYPES, BORDS, plan, colonnes, ciblesX, ciblesY, aimanter, bordsTouches, fondPerdu, deplacer, redimensionner, pas, nouvelElement, historique, empiler, renommer, freeId, clone, r1, r6 };
})();

// Partie de la page : DOM, pointeur, clavier, écritures.
const Editeur = (() => {
  if (typeof document === 'undefined') return null;
  const SVG = 'http://www.w3.org/2000/svg';
  const PX = 96 / 25.4;
  const E = EDITEUR;
  const $ = (id) => document.getElementById(id);
  const instances = [];

  function node(tag, text, className) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (className) n.className = className;
    return n;
  }
  function svg(tag, attrs, text) {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = text;
    return n;
  }
  const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1).replace('.', ',');
  const num = (text) => Number.parseFloat(String(text).replace(',', '.'));

  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-book-print': '1' }, body: JSON.stringify(body) });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  }

  const TYPE_LABELS = { fond: 'fond', bandeau: 'bandeau', titre: 'titre', chapeau: 'chapô', texte: 'texte', encadre: 'encadré', illustration: 'illustration', legende: 'légende', 'chiffre-cle': 'chiffre-clé', fiche: 'fiche', picto: 'pictogramme', etiquette: 'étiquette', qr: 'QR', folio: 'folio' };

  /** Champs propres de chaque type (spec §24.4), dans l'ordre des propriétés. */
  const FIELDS = {
    fond: ['double', 'fondPerdu'],
    bandeau: ['maxChars', 'alignement', 'double', 'fondPerdu'],
    titre: ['maxChars'],
    chapeau: ['maxChars'],
    texte: ['maxChars', 'colonnes', 'gouttiereMm'],
    encadre: ['encadre', 'sorte', 'icone', 'entete', 'maxChars', 'alignement'],
    illustration: ['detoure', 'habillage', 'double', 'fondPerdu', 'ratio'],
    legende: ['maxChars', 'image', 'consigne'],
    'chiffre-cle': ['maxChars', 'sizePt'],
    fiche: ['maxPictos', 'itemMaxChars'],
    picto: ['picto'],
    etiquette: ['maxChars', 'alignement', 'consigne', 'fleche'],
    qr: ['qrSideMm', 'maxChars'],
    folio: [],
  };

  function creer(config) {
    const p = config.prefixe;
    const ed = {
      config,
      state: null,
      doc: null,
      saved: null,
      empreinte: null,
      plan: null,
      spread: 0,
      selected: null,
      chain: null,
      history: E.historique(),
      pending: 0,
      drag: null,
      redraw: false,
      notice: null,
      frame: $(`${p}-cadre`),
      inner: $(`${p}-echelle`),
      iframe: $(config.iframe),
      svg: $(`${p}-reperes`),
      boxes: config.couches,
      attr: config.attr,
    };
    instances.push(ed);
    // Un refus ou une relecture : dit sous les motifs jusqu'à l'action suivante.
    const message = (text, cls = 'erreur') => {
      ed.notice = text ? { text, cls } : null;
      showErrors();
    };

    // Dessin

    const pageOf = (e) => ed.plan.pages[e.page];
    function rectOf(e) {
      const pg = pageOf(e);
      if (!pg) return null;
      const left = pg.offset + pg.trimLeft + e.x;
      const top = pg.trimTop + e.y;
      return { left, top, right: left + e.w, bottom: top + e.h };
    }
    const scaleOf = () => (ed.svg.getScreenCTM()?.a ?? 1) || 1;

    function layers() {
      const out = {};
      for (const name of ['bleed', 'safe', 'fold', 'grille', 'zones', 'edition', 'guides']) {
        out[name] = svg('g', { 'data-layer': name });
        ed.svg.append(out[name]);
      }
      return out;
    }

    function draw() {
      ed.svg.replaceChildren();
      if (!ed.plan || !ed.doc) return;
      const P = ed.plan;
      ed.svg.setAttribute('viewBox', `0 0 ${P.strip} ${P.pages[0].height}`);
      const L = layers();
      for (const pg of P.pages) {
        const x = pg.offset;
        const t = { left: pg.trimLeft, top: pg.trimTop, right: pg.trimLeft + P.W, bottom: pg.trimTop + P.H };
        L.bleed.append(svg('path', { d: `M${x} 0h${pg.width}v${pg.height}h${-pg.width}zM${t.left + x} ${t.top}H${t.right + x}V${t.bottom}H${t.left + x}z`, 'fill-rule': 'evenodd', class: 'r-bleed' }));
        L.safe.append(svg('rect', { x: x + t.left + pg.safe.left, y: t.top + pg.safe.top, width: pg.safe.right - pg.safe.left, height: pg.safe.bottom - pg.safe.top, class: 'r-safe' }));
        const fold = pg.side === 'gauche' ? x + t.right : x + t.left;
        L.fold.append(svg('line', { x1: fold, x2: fold, y1: 0, y2: pg.height, class: 'r-fold' }));
        const band = pg.side === 'gauche' ? fold - E.FOLD_BAND_MM : fold + E.FOLD_BAND_MM;
        L.fold.append(svg('line', { x1: band, x2: band, y1: t.top, y2: t.bottom, class: 'r-bande' }));
        for (const c of E.colonnes(pg, P.grille)) L.grille.append(svg('rect', { x: x + t.left + c.left, y: t.top + pg.safe.top, width: c.right - c.left, height: pg.safe.bottom - pg.safe.top, class: 'r-colonne' }));
      }
      // Fond cliquable : un clic hors des éléments ne choisit rien.
      L.edition.append(svg('rect', { x: 0, y: 0, width: P.strip, height: P.pages[0].height, class: 'r-fond' }));
      for (const e of ed.doc.elements) {
        const r = rectOf(e);
        if (!r) continue;
        L.zones.append(svg('rect', { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, class: 'r-zone' }));
        L.zones.append(svg('text', { x: r.left + 1, y: r.top + 4, class: 'r-label' }, e.id));
        L.edition.append(svg('rect', { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, class: 'r-cible', 'data-id': e.id }));
      }
      const sel = svg('g', { 'data-selection': '1' });
      sel.append(svg('rect', { class: 'r-choix' }));
      for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) sel.append(svg('rect', { class: 'r-poignee', 'data-handle': h }));
      L.edition.append(sel);
      placeSelection();
      showLayers();
      fit();
    }

    function placeSelection(rect) {
      const sel = ed.svg.querySelector('g[data-selection]');
      if (!sel) return;
      const e = ed.doc?.elements.find((x) => x.id === ed.selected);
      const r = rect ?? (e && rectOf(e));
      sel.setAttribute('display', r ? 'inline' : 'none');
      if (!r) return;
      const box = sel.querySelector('.r-choix');
      box.setAttribute('x', r.left);
      box.setAttribute('y', r.top);
      box.setAttribute('width', r.right - r.left);
      box.setAttribute('height', r.bottom - r.top);
      const s = 8 / (scaleOf());
      const mx = (r.left + r.right) / 2;
      const my = (r.top + r.bottom) / 2;
      const at = { nw: [r.left, r.top], n: [mx, r.top], ne: [r.right, r.top], e: [r.right, my], se: [r.right, r.bottom], s: [mx, r.bottom], sw: [r.left, r.bottom], w: [r.left, my] };
      for (const h of sel.querySelectorAll('.r-poignee')) {
        const [hx, hy] = at[h.dataset.handle];
        h.setAttribute('x', hx - s / 2);
        h.setAttribute('y', hy - s / 2);
        h.setAttribute('width', s);
        h.setAttribute('height', s);
      }
    }

    function showGuides(guides, e) {
      const g = ed.svg.querySelector('g[data-layer="guides"]');
      if (!g) return;
      g.replaceChildren();
      const pg = e && pageOf(e);
      if (!pg) return;
      for (const guide of guides) {
        if (guide.axe === 'x') {
          const x = pg.offset + pg.trimLeft + guide.v;
          g.append(svg('line', { x1: x, x2: x, y1: 0, y2: pg.height, class: 'r-guide', 'data-kind': guide.kind }));
          g.append(svg('text', { x: x + 0.8, y: 6, class: 'r-guide-texte' }, guide.kind));
        } else {
          const y = pg.trimTop + guide.v;
          g.append(svg('line', { x1: 0, x2: ed.plan.strip, y1: y, y2: y, class: 'r-guide', 'data-kind': guide.kind }));
          g.append(svg('text', { x: pg.offset + 1, y: y - 0.8, class: 'r-guide-texte' }, guide.kind));
        }
      }
    }

    function showLayers() {
      for (const box of document.querySelectorAll(ed.boxes)) {
        const layer = ed.svg.querySelector(`g[data-layer="${box.dataset[ed.attr]}"]`);
        if (layer) layer.setAttribute('display', box.checked ? 'inline' : 'none');
      }
    }

    /** La double page affichée, réduite à la place disponible ; les autres pages sont hors du cadre. */
    function fit() {
      const { frame, inner } = ed;
      if (!ed.plan || frame.clientWidth === 0) return;
      const P = ed.plan;
      const spread = P.spreads[ed.spread] ?? P.spreads[0];
      const first = P.pages[spread[0]];
      const width = spread.reduce((sum, i) => sum + P.pages[i].width, 0) * PX;
      const height = first.height * PX;
      const scale = Math.min(1, frame.clientWidth / width, frame.clientHeight / height);
      inner.style.width = `${P.strip * PX}px`;
      inner.style.height = `${height}px`;
      inner.style.left = `${(frame.clientWidth - width * scale) / 2 - first.offset * PX * scale}px`;
      inner.style.transform = `scale(${scale})`;
      // Seule la page ou la double page affichée se voit (et se clique) : une page seule ne montre pas un morceau de sa voisine.
      inner.style.clipPath = `inset(0px ${(P.strip * PX - first.offset * PX - width).toFixed(2)}px 0px ${(first.offset * PX).toFixed(2)}px)`;
      placeSelection();
      const label = $(`${p}-pages-texte`);
      if (label) {
        const numbers = spread.map((i) => i + 1).join('–');
        label.textContent = `${spread.length > 1 ? 'Pages' : 'Page'} ${numbers} sur ${P.pages.length}`;
        $(`${p}-prec`).disabled = ed.spread === 0;
        $(`${p}-suiv`).disabled = ed.spread >= P.spreads.length - 1;
      }
    }

    // Listes

    function listElements() {
      const box = $(`${p}-elements`);
      if (!ed.doc) return box.replaceChildren();
      const table = node('table');
      const head = node('tr');
      for (const t of ['Type', 'Élément']) head.append(node('th', t));
      table.append(head);
      // Du dessus au dessous : le dernier élément du fichier est posé au-dessus des autres.
      for (const e of [...ed.doc.elements].reverse()) {
        const row = node('tr');
        row.dataset.element = e.id;
        if (e.id === ed.selected) row.setAttribute('aria-current', 'true');
        row.append(node('td', `${TYPE_LABELS[e.type] ?? e.type}${e.double ? ', à cheval' : ''}`), node('td', e.id));
        row.addEventListener('click', () => select(e.id));
        table.append(row);
      }
      box.replaceChildren(table);
      const chosen = ed.doc.elements.find((e) => e.id === ed.selected);
      $(`${p}-monter`).disabled = !chosen || ed.doc.elements.at(-1) === chosen;
      $(`${p}-descendre`).disabled = !chosen || ed.doc.elements[0] === chosen;
      $(`${p}-supprimer`).disabled = !chosen;
      $(`${p}-chaine-nouvelle`).disabled = !(chosen && chosen.type === 'texte' && chosen.chaine === undefined);
    }

    function listChains() {
      const box = $(`${p}-chaines`);
      const chains = ed.doc?.chaines ?? [];
      if (!chains.length) return box.replaceChildren();
      const ul = node('ul', undefined, 'chaines');
      for (const c of chains) {
        const li = node('li');
        const b = node('button', `${c.id} (${c.cadres.length} cadre${c.cadres.length > 1 ? 's' : ''}, ${c.paragraphes.length} §)`, 'secondaire petit');
        b.type = 'button';
        b.dataset.chaine = c.id;
        if (c.id === ed.chain) b.setAttribute('aria-pressed', 'true');
        b.addEventListener('click', () => selectChain(c.id));
        li.append(b);
        ul.append(li);
      }
      box.replaceChildren(ul);
    }

    function select(id) {
      ed.selected = id;
      ed.chain = null;
      listElements();
      listChains();
      placeSelection();
      properties();
    }
    function selectChain(id) {
      ed.chain = id;
      ed.selected = null;
      listElements();
      listChains();
      placeSelection();
      properties();
    }

    // Propriétés

    function field(label, input) {
      const div = node('div', undefined, 'champ');
      const l = node('label', label);
      input.id = `${p}-p-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
      l.htmlFor = input.id;
      div.append(l, input);
      return div;
    }
    function numberInput(value, step, onChange) {
      const input = node('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.value = value === undefined ? '' : String(step === 1 ? value : fmt(value));
      input.addEventListener('change', () => onChange(input.value.trim() === '' ? undefined : num(input.value)));
      return input;
    }
    function selectInput(options, value, onChange) {
      const s = node('select');
      for (const [v, label] of options) {
        const o = node('option', label);
        o.value = v;
        s.append(o);
      }
      s.value = value ?? '';
      s.addEventListener('change', () => onChange(s.value));
      return s;
    }
    function check(label, value, onChange) {
      const l = node('label', undefined, 'case');
      const input = node('input');
      input.type = 'checkbox';
      input.checked = Boolean(value);
      input.dataset.champ = label;
      input.addEventListener('change', () => onChange(input.checked));
      l.append(input, document.createTextNode(` ${label}`));
      return l;
    }

    /** Une action sur l'élément choisi : le document modifié est validé et écrit par le serveur. */
    function changeElement(change, { aimantes = [], auto = true } = {}) {
      const doc = E.clone(ed.doc);
      const at = doc.elements.findIndex((e) => e.id === ed.selected);
      if (at < 0) return;
      let e = change(doc.elements[at], doc);
      // Un fond perdu ne reste que sur un bord touché ; aimanté, il est coché (décision de David, ED3). Coché à la main : tel quel.
      if (ed.plan && auto) e = E.fondPerdu(ed.plan, e, aimantes);
      doc.elements[at] = e;
      commit(doc);
    }
    const setField = (key, value) =>
      changeElement((e) => {
        const out = { ...e };
        if (value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value))) delete out[key];
        else out[key] = value;
        return out;
      });

    function properties() {
      const box = $(`${p}-proprietes`);
      box.replaceChildren();
      if (!ed.doc) return;
      if (ed.chain) return chainProperties(box);
      const e = ed.doc.elements.find((x) => x.id === ed.selected);
      if (!e) return modelInfo(box);
      box.append(node('h3', `${TYPE_LABELS[e.type] ?? e.type} ${e.id}`));
      const id = node('input');
      id.value = e.id;
      id.addEventListener('change', () => {
        const to = id.value.trim();
        if (to === e.id) return;
        ed.selected = to;
        commit(E.renommer(ed.doc, e.id, to));
      });
      box.append(field('Identifiant', id));
      const grid = node('div', undefined, 'grille deux');
      grid.append(field('Page', selectInput(Array.from({ length: ed.doc.pages }, (_, i) => [String(i), String(i + 1)]), String(e.page), (v) => changeElement((x) => {
        const out = { ...x, page: Number(v) };
        if (ed.plan) Object.assign(out, E.pas(ed.plan, out, 0, 0));
        return out;
      }))));
      for (const [k, label] of [['x', 'x (mm)'], ['y', 'y (mm)'], ['w', 'Largeur (mm)'], ['h', 'Hauteur (mm)']]) {
        grid.append(field(label, numberInput(e[k], 0.1, (v) => changeElement((x) => ({ ...x, [k]: v === undefined ? x[k] : E.r6(v) })))));
      }
      box.append(grid);
      const own = node('div', undefined, 'grille deux');
      for (const f of FIELDS[e.type] ?? []) ownField(own, e, f);
      box.append(own);
    }

    function ownField(box, e, f) {
      const o = ed.state.options;
      const int = (label) => box.append(field(label, numberInput(e[f], 1, (v) => setField(f, v === undefined ? undefined : Math.round(v)))));
      switch (f) {
        case 'maxChars':
          if (e.type === 'texte' && e.chaine !== undefined) box.append(node('p', `Cadre de la chaîne ${e.chaine} : longueurs par paragraphe.`, 'note large'));
          else int(e.type === 'qr' ? 'Légende, caractères' : 'Caractères au plus');
          return;
        case 'itemMaxChars':
          return int('Caractères par information');
        case 'maxPictos':
          return int('Informations au plus');
        case 'colonnes':
          if (e.chaine !== undefined) int('Colonnes');
          return;
        case 'gouttiereMm':
          if (e.chaine !== undefined) box.append(field('Gouttière (mm)', numberInput(e[f], 0.1, (v) => setField(f, v))));
          return;
        case 'sizePt':
          return box.append(field('Corps (pt)', numberInput(e[f], 0.1, (v) => setField(f, v))));
        case 'ratio':
          return box.append(field('Rapport l/h', numberInput(e[f], 0.1, (v) => setField(f, v))));
        case 'qrSideMm':
          return box.append(field('Côté du QR (mm)', numberInput(e[f], 0.1, (v) => setField(f, v))));
        case 'alignement':
          return box.append(field('Alignement', selectInput([['', '—'], ['haut', 'haut'], ['milieu', 'milieu'], ['bas', 'bas']], e[f], (v) => setField(f, v || undefined))));
        case 'encadre':
          return box.append(field('Couleur', selectInput(o.boxes.map((b) => [b, b]), e[f], (v) => setField(f, v))));
        case 'picto':
          return box.append(field('Pictogramme', selectInput(o.pictos.map((b) => [b, b]), e[f], (v) => setField(f, v))));
        case 'icone':
          return box.append(field('Icône', selectInput([['', 'aucune'], ...o.pictos.map((b) => [b, b])], e[f], (v) => setField(f, v || undefined))));
        case 'sorte':
          return box.append(field('Sorte', selectInput([['capsule', 'capsule'], ['question', 'question']], e[f] ?? 'capsule', (v) => setField(f, v))));
        case 'habillage':
          if (e.detoure) box.append(field('Habillage', selectInput([['gauche', 'texte à gauche'], ['droite', 'texte à droite'], ['aucun', 'aucun']], e[f], (v) => setField(f, v))));
          return;
        case 'image': {
          const images = ed.doc.elements.filter((x) => x.type === 'illustration').map((x) => [x.id, x.id]);
          return box.append(field('Image', selectInput([['', 'aucune'], ...images], e[f], (v) => setField(f, v || undefined))));
        }
        case 'consigne': {
          const area = node('textarea');
          area.rows = 2;
          area.value = e[f] ?? '';
          area.addEventListener('change', () => setField(f, area.value.trim() || undefined));
          const div = field('Consigne (jamais imprimée)', area);
          div.classList.add('large');
          return box.append(div);
        }
        case 'detoure':
          // Un détouré exige un habillage : « aucun » tant que David n'en choisit pas d'autre.
          return box.append(check('Détouré', e.detoure, (on) => changeElement((x) => {
            const out = { ...x };
            if (on) Object.assign(out, { detoure: true, habillage: x.habillage ?? 'aucun' });
            else {
              delete out.detoure;
              delete out.habillage;
            }
            return out;
          })));
        case 'double':
          return box.append(check('À cheval', e.double, (on) => setField('double', on ? true : undefined)));
        case 'fondPerdu': {
          const div = node('div', undefined, 'large bords');
          div.append(node('span', 'Fond perdu :', 'note'));
          for (const side of E.BORDS) {
            div.append(check(side, (e.fondPerdu ?? []).includes(side), (on) => changeElement((x) => {
              const set = new Set(x.fondPerdu ?? []);
              if (on) set.add(side);
              else set.delete(side);
              const list = E.BORDS.filter((s) => set.has(s));
              const out = { ...x };
              if (list.length) out.fondPerdu = list;
              else delete out.fondPerdu;
              return out;
            }, { auto: false })));
          }
          return box.append(div);
        }
        case 'entete': {
          const mode = e.heading ? 'fixe' : e.headingMaxChars !== undefined ? 'ecrit' : 'aucun';
          box.append(field('En-tête', selectInput([['aucun', 'aucun'], ['ecrit', 'écrit par la recherche'], ['fixe', 'fixe']], mode, (v) => changeElement((x) => {
            const out = { ...x };
            delete out.heading;
            delete out.headingMaxChars;
            if (v === 'ecrit') out.headingMaxChars = 40;
            if (v === 'fixe') out.heading = { fr: 'Le savais-tu ?', en: 'Did you know?', es: '¿Sabías que?' };
            return out;
          }))));
          if (mode === 'ecrit') box.append(field('En-tête, caractères', numberInput(e.headingMaxChars, 1, (v) => setField('headingMaxChars', v === undefined ? undefined : Math.round(v)))));
          if (mode === 'fixe') {
            for (const lang of ['fr', 'en', 'es']) {
              const input = node('input');
              input.value = e.heading[lang];
              input.addEventListener('change', () => changeElement((x) => ({ ...x, heading: { ...x.heading, [lang]: input.value } })));
              box.append(field(`En-tête (${lang})`, input));
            }
          }
          return;
        }
        case 'fleche': {
          box.append(check('Flèche', e.fleche, (on) => changeElement((x) => {
            const out = { ...x };
            if (on) out.fleche = { x: E.r1(Math.max(0, x.x - 10)), y: E.r1(x.y + x.h / 2) };
            else delete out.fleche;
            return out;
          })));
          if (e.fleche) {
            for (const k of ['x', 'y']) box.append(field(`Flèche ${k} (mm)`, numberInput(e.fleche[k], 0.1, (v) => changeElement((x) => ({ ...x, fleche: { ...x.fleche, [k]: v === undefined ? x.fleche[k] : E.r6(v) } })))));
          }
          return;
        }
        default:
          return;
      }
    }

    function modelInfo(box) {
      const s = ed.state;
      box.append(node('h3', `Mise en page ${s.id}`));
      const dl = node('dl');
      const pairs = [
        ['Fichier', s.target],
        ['Version', s.version === 1 ? '1 : convertie au premier enregistrement' : '2'],
        ['Pages', String(s.pages)],
        ['Départ', s.start],
        ['Grille', `${s.grille.colonnes} colonnes, gouttière de ${fmt(s.grille.gouttiereMm)} mm`],
      ];
      if (s.subjects) pairs.push(['Sujets', s.subjects.join(', ') || '—']);
      for (const [k, v] of pairs) dl.append(node('dt', k), node('dd', v));
      box.append(dl, node('p', 'Clic : choisir ; glisser : déplacer ; poignées : redimensionner. Flèches 0,5 mm, Maj 5 mm, Suppr, Ctrl+Z, Ctrl+Y, Échap.', 'note'));
    }

    function chainProperties(box) {
      const c = (ed.doc.chaines ?? []).find((x) => x.id === ed.chain);
      if (!c) return;
      const change = (fn) => {
        const doc = E.clone(ed.doc);
        const chain = doc.chaines.find((x) => x.id === ed.chain);
        fn(chain, doc);
        commit(doc);
      };
      box.append(node('h3', `Chaîne ${c.id}`));
      const id = node('input');
      id.value = c.id;
      id.addEventListener('change', () => {
        const to = id.value.trim();
        if (to === c.id) return;
        ed.chain = to;
        change((chain, doc) => {
          for (const e of doc.elements) if (e.chaine === chain.id) e.chaine = to;
          chain.id = to;
        });
      });
      box.append(field('Identifiant', id));
      box.append(check('Lettrine', c.lettrine, (on) => change((chain) => {
        if (on) chain.lettrine = true;
        else delete chain.lettrine;
      })));
      box.append(node('p', 'Cadres, dans l\'ordre de lecture', 'titre-liste'));
      const move = (list, i, d) => {
        const j = i + d;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
      };
      const cadres = node('ul', undefined, 'chaines');
      c.cadres.forEach((cadre, i) => {
        const li = node('li', cadre);
        li.append(
          small('↑', `Monter le cadre ${cadre}`, () => change((chain) => move(chain.cadres, i, -1))),
          small('↓', `Descendre le cadre ${cadre}`, () => change((chain) => move(chain.cadres, i, 1))),
          small('✕', `Retirer le cadre ${cadre}`, () => change((chain, doc) => {
            chain.cadres.splice(i, 1);
            const e = doc.elements.find((x) => x.id === cadre);
            if (e) {
              delete e.chaine;
              delete e.colonnes;
              delete e.gouttiereMm;
              e.maxChars = 200;
            }
          })),
        );
        cadres.append(li);
      });
      box.append(cadres);
      const free = ed.doc.elements.filter((e) => e.type === 'texte' && e.chaine === undefined);
      if (free.length) {
        box.append(field('Ajouter un cadre', selectInput([['', '—'], ...free.map((e) => [e.id, e.id])], '', (v) => {
          if (!v) return;
          change((chain, doc) => {
            chain.cadres.push(v);
            const e = doc.elements.find((x) => x.id === v);
            delete e.maxChars;
            e.chaine = chain.id;
          });
        })));
      }
      box.append(node('p', 'Paragraphes', 'titre-liste'));
      const table = node('table');
      const head = node('tr');
      for (const t of ['§', 'Intertitre', 'Caractères', 'Intertitre, car.', '']) head.append(node('th', t));
      table.append(head);
      c.paragraphes.forEach((para, i) => {
        const row = node('tr');
        const pid = node('input');
        pid.value = para.id;
        pid.size = 4;
        pid.addEventListener('change', () => change((chain) => (chain.paragraphes[i].id = pid.value.trim())));
        const td = (child) => {
          const cell = node('td');
          cell.append(child);
          return cell;
        };
        const inter = node('input');
        inter.type = 'checkbox';
        inter.checked = para.intertitre;
        inter.setAttribute('aria-label', `Intertitre de ${para.id}`);
        inter.addEventListener('change', () => change((chain) => {
          const q = chain.paragraphes[i];
          q.intertitre = inter.checked;
          if (inter.checked) q.headingMaxChars = q.headingMaxChars ?? 30;
          else delete q.headingMaxChars;
        }));
        const max = numberInput(para.maxChars, 1, (v) => change((chain) => (chain.paragraphes[i].maxChars = Math.round(v ?? 0))));
        max.size = 4;
        max.setAttribute('aria-label', `Caractères de ${para.id}`);
        const hmax = numberInput(para.headingMaxChars, 1, (v) => change((chain) => {
          if (v === undefined) delete chain.paragraphes[i].headingMaxChars;
          else chain.paragraphes[i].headingMaxChars = Math.round(v);
        }));
        hmax.size = 3;
        hmax.disabled = !para.intertitre;
        hmax.setAttribute('aria-label', `Caractères de l'intertitre de ${para.id}`);
        const actions = node('td');
        actions.append(
          small('↑', `Monter ${para.id}`, () => change((chain) => move(chain.paragraphes, i, -1))),
          small('↓', `Descendre ${para.id}`, () => change((chain) => move(chain.paragraphes, i, 1))),
          small('✕', `Retirer ${para.id}`, () => change((chain) => chain.paragraphes.splice(i, 1))),
        );
        row.append(td(pid), td(inter), td(max), td(hmax), actions);
        table.append(row);
      });
      box.append(table);
      const buttons = node('div', undefined, 'boutons');
      buttons.append(
        small('Ajouter un paragraphe', 'Ajouter un paragraphe', () => change((chain) => {
          const used = new Set(chain.paragraphes.map((q) => q.id));
          let n = 1;
          while (used.has(`p${n}`)) n++;
          chain.paragraphes.push({ id: `p${n}`, intertitre: false, maxChars: 200 });
        })),
        small('Supprimer la chaîne', 'Supprimer la chaîne', () => {
          const doc = E.clone(ed.doc);
          for (const e of doc.elements) {
            if (e.chaine !== c.id) continue;
            delete e.chaine;
            delete e.colonnes;
            delete e.gouttiereMm;
            e.maxChars = 200;
          }
          doc.chaines = doc.chaines.filter((x) => x.id !== c.id);
          if (!doc.chaines.length) delete doc.chaines;
          ed.chain = null;
          commit(doc);
        }),
      );
      box.append(buttons);
    }

    function small(text, label, onClick) {
      const b = node('button', text, 'secondaire petit');
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.addEventListener('click', onClick);
      return b;
    }

    // Écritures

    function render() {
      // Pendant un geste, le calque ne change pas sous le pointeur : le dessin attend la fin du geste.
      if (ed.drag) {
        ed.redraw = true;
        return;
      }
      ed.redraw = false;
      draw();
      listElements();
      listChains();
      properties();
    }

    /** Le document affiché devient `next` ; il est écrit par la file de la page. Refusé : on revient au dernier document écrit. */
    function commit(next, kind = 'action') {
      if (JSON.stringify(next) === JSON.stringify(ed.doc)) return Promise.resolve();
      ed.notice = null;
      ed.doc = next;
      render();
      return write(next, kind);
    }

    /**
     * Une tâche de la file d'écritures de la page : elle s'exécute après les écritures déjà demandées. Quand plus rien n'attend, le document
     * affiché redevient celui du fichier.
     */
    function queued(task) {
      ed.pending++;
      return config.enqueue(async () => {
        try {
          await task();
        } finally {
          ed.pending = Math.max(0, ed.pending - 1);
          if (ed.pending === 0) settle();
        }
      });
    }

    async function send(next, kind) {
      const before = ed.saved;
      const { ok, data } = await post('/api/mise-en-page/enregistrer', { ...config.cible(), empreinte: ed.empreinte, document: next });
      if (!ok) {
        if (data.conflit) return reload(data.error);
        ed.doc = ed.saved;
        render();
        message(data.error ?? 'écriture refusée');
        return;
      }
      if (kind === 'undo') E.empiler(ed.history.retablir, before);
      else {
        E.empiler(ed.history.annuler, before);
        if (kind === 'action') ed.history.retablir = [];
      }
      accept(data);
    }

    const write = (next, kind) => queued(() => send(next, kind));

    /** Ce que le serveur a écrit fait foi. */
    function accept(state) {
      ed.state = state;
      ed.saved = state.document;
      ed.empreinte = state.empreinte;
      // Le départ a pu changer (« Miroir », Ctrl+Z après lui) : pages seules et doubles pages sont recalculées.
      ed.plan = state.layout && state.document ? E.plan(state.document, state.layout, state.grille) : null;
      ed.spread = ed.plan ? Math.min(ed.spread, ed.plan.spreads.length - 1) : 0;
    }

    /** Plus rien en attente : le document affiché est celui du fichier ; le rendu réel est refait, les motifs suivent. */
    function settle() {
      if (!ed.saved) return;
      ed.doc = ed.saved;
      render();
      showErrors();
      reloadPreview();
      config.apres?.(ed.state);
    }

    function showErrors() {
      const box = $(`${p}-motifs`);
      const notice = ed.notice ? [node('p', ed.notice.text, ed.notice.cls)] : [];
      box.replaceChildren(...notice, ...(ed.state?.errors ?? []).map((t) => node('p', t, 'erreur')));
    }

    function reloadPreview() {
      if (!ed.state.layout) return ed.iframe.removeAttribute('src');
      ed.iframe.src = config.apercu();
    }

    async function reload(reason) {
      const state = await config.relire();
      ouvrir(state);
      if (reason) message(reason, 'alerte');
    }

    // Ouverture

    function ouvrir(state, { keepSelection = false } = {}) {
      // Une autre mise en page s'ouvre sur sa première (double) page ; la même, relue, reste où elle était.
      if (ed.state?.target !== state.target) ed.spread = 0;
      ed.notice = null;
      ed.state = state;
      ed.doc = state.document ? E.clone(state.document) : null;
      ed.saved = ed.doc;
      ed.empreinte = state.empreinte;
      ed.history = E.historique();
      ed.pending = 0;
      ed.plan = state.layout && state.document ? E.plan(state.document, state.layout, state.grille) : null;
      if (ed.plan) ed.spread = Math.min(ed.spread, ed.plan.spreads.length - 1);
      else ed.spread = 0;
      if (!keepSelection || !ed.doc?.elements.some((e) => e.id === ed.selected)) ed.selected = null;
      if (!keepSelection || !ed.doc?.chaines?.some((c) => c.id === ed.chain)) ed.chain = null;
      render();
      showErrors();
      reloadPreview();
    }

    function fermer() {
      ed.state = null;
      ed.doc = null;
      ed.saved = null;
      ed.plan = null;
      ed.selected = null;
      ed.chain = null;
      ed.svg.replaceChildren();
      ed.iframe.removeAttribute('src');
      for (const id of ['elements', 'chaines', 'proprietes', 'motifs']) $(`${p}-${id}`).replaceChildren();
    }

    // Annuler et rétablir passent par la file : un Ctrl+Z pressé pendant une écriture annule cette écriture-là, une fois finie.
    const step = (pile, kind) =>
      queued(async () => {
        const target = ed.history[pile].pop();
        if (!target) return;
        ed.doc = E.clone(target);
        render();
        await send(target, kind);
      });
    const undo = () => step('annuler', 'undo');
    const redo = () => step('retablir', 'redo');

    /** « Miroir » (modèles, spec §24.12) : fait par le serveur, sur le fichier lu ; annulable comme une autre action. */
    function miroir() {
      if (!ed.doc) return Promise.resolve();
      return queued(async () => {
        const before = ed.saved;
        const { ok, data } = await post('/api/mise-en-page/miroir', { ...config.cible(), empreinte: ed.empreinte });
        if (!ok) {
          if (data.conflit) return reload(data.error);
          message(data.error ?? 'miroir refusé');
          return;
        }
        E.empiler(ed.history.annuler, before);
        ed.history.retablir = [];
        accept(data);
      });
    }

    function addElement(type) {
      if (!ed.doc) return;
      const spread = ed.plan ? ed.plan.spreads[ed.spread] : [0];
      const e = E.nouvelElement(ed.doc, ed.plan, type, spread, ed.state.options);
      const doc = E.clone(ed.doc);
      doc.elements.push(e);
      ed.selected = e.id;
      ed.chain = null;
      commit(doc);
    }
    function reorder(d) {
      const doc = E.clone(ed.doc);
      const i = doc.elements.findIndex((e) => e.id === ed.selected);
      const j = i + d;
      if (i < 0 || j < 0 || j >= doc.elements.length) return;
      [doc.elements[i], doc.elements[j]] = [doc.elements[j], doc.elements[i]];
      commit(doc);
    }
    function remove() {
      if (!ed.selected) return;
      const doc = E.clone(ed.doc);
      doc.elements = doc.elements.filter((e) => e.id !== ed.selected);
      ed.selected = null;
      commit(doc);
    }
    function newChain() {
      const doc = E.clone(ed.doc);
      const e = doc.elements.find((x) => x.id === ed.selected);
      if (!e || e.type !== 'texte' || e.chaine !== undefined) return;
      const id = E.freeId(doc, 'chaine');
      doc.chaines = [...(doc.chaines ?? []), { id, cadres: [e.id], paragraphes: [{ id: 'p1', intertitre: false, maxChars: e.maxChars ?? 200 }] }];
      delete e.maxChars;
      e.chaine = id;
      ed.chain = id;
      ed.selected = null;
      commit(doc);
    }

    // Pointeur

    ed.svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !ed.doc || !ed.plan) return;
      // Un clic sur la page rend le clavier à l'éditeur : le champ ou la liste qui avait le curseur le perd (le glissement empêche le
      // comportement par défaut, qui l'aurait fait).
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
      const target = event.target;
      const handle = target.dataset?.handle;
      const id = target.dataset?.id;
      if (!handle && !id) {
        if (target.classList.contains('r-fond')) select(null);
        return;
      }
      if (id && id !== ed.selected) select(id);
      const e = ed.doc.elements.find((x) => x.id === ed.selected);
      if (!e) return;
      const m = ed.svg.getScreenCTM();
      if (!m) return;
      event.preventDefault();
      target.setPointerCapture(event.pointerId);
      // Le geste se mesure en distance parcourue par le pointeur, à l'échelle du début du geste : si le panneau bouge ou change de taille
      // pendant le geste (un bandeau de motifs qui apparaît), l'élément suit quand même la main.
      ed.drag = { mode: handle ? 'resize' : 'move', handle, start: { x: event.clientX, y: event.clientY, sx: m.a, sy: m.d }, element: E.clone(e), result: null, target };
    });

    ed.svg.addEventListener('pointermove', (event) => {
      const d = ed.drag;
      if (!d) return;
      const dx = (event.clientX - d.start.x) / d.start.sx;
      const dy = (event.clientY - d.start.y) / d.start.sy;
      const e = d.element;
      const r = d.mode === 'move' ? E.deplacer(ed.plan, e, dx, dy) : E.redimensionner(ed.plan, e, d.handle, dx, dy, ed.state.ratios?.[e.id]);
      d.result = r;
      const pg = ed.plan.pages[e.page];
      const left = pg.offset + pg.trimLeft + r.x;
      const top = pg.trimTop + r.y;
      placeSelection({ left, top, right: left + r.w, bottom: top + r.h });
      showGuides(r.guides, e);
    });

    function endDrag(event, cancel) {
      const d = ed.drag;
      if (!d) return;
      ed.drag = null;
      try {
        d.target.releasePointerCapture(event.pointerId);
      } catch {
        // déjà relâché
      }
      showGuides([]);
      const r = d.result;
      if (cancel || !r || (r.x === d.element.x && r.y === d.element.y && r.w === d.element.w && r.h === d.element.h)) {
        if (ed.redraw) render();
        return placeSelection();
      }
      changeElement((e) => ({ ...e, x: r.x, y: r.y, w: r.w, h: r.h }), { aimantes: r.aimantes });
      if (ed.redraw) render();
    }
    ed.svg.addEventListener('pointerup', (event) => endDrag(event, false));
    ed.svg.addEventListener('pointercancel', (event) => endDrag(event, true));

    // Commandes

    $(`${p}-ajouter-type`).replaceChildren(...[['', 'Ajouter…'], ...E.TYPES.map((t) => [t, TYPE_LABELS[t]])].map(([v, label]) => {
      const o = node('option', label);
      o.value = v;
      return o;
    }));
    $(`${p}-ajouter-type`).addEventListener('change', (event) => {
      const type = event.target.value;
      event.target.value = '';
      // Le menu rend le curseur : une flèche pressée ensuite déplace l'élément ajouté, sans rien ajouter d'autre.
      event.target.blur();
      if (type) addElement(type);
    });
    $(`${p}-monter`).addEventListener('click', () => reorder(1));
    $(`${p}-descendre`).addEventListener('click', () => reorder(-1));
    $(`${p}-supprimer`).addEventListener('click', remove);
    $(`${p}-chaine-nouvelle`).addEventListener('click', newChain);
    $(`${p}-prec`).addEventListener('click', () => {
      ed.spread = Math.max(0, ed.spread - 1);
      fit();
    });
    $(`${p}-suiv`).addEventListener('click', () => {
      ed.spread = Math.min((ed.plan?.spreads.length ?? 1) - 1, ed.spread + 1);
      fit();
    });
    for (const box of document.querySelectorAll(ed.boxes)) box.addEventListener('change', showLayers);
    new ResizeObserver(fit).observe(ed.frame);

    function key(event) {
      if (!ed.doc) return false;
      const ctrl = event.ctrlKey || event.metaKey;
      const k = event.key;
      if (ctrl && (k === 'z' || k === 'Z')) {
        if (event.shiftKey) redo();
        else undo();
        return true;
      }
      if (ctrl && (k === 'y' || k === 'Y')) {
        redo();
        return true;
      }
      if (k === 'Escape') {
        select(null);
        return true;
      }
      const chosen = ed.doc.elements.find((x) => x.id === ed.selected);
      if (!chosen) return false;
      if (k === 'Delete') {
        remove();
        return true;
      }
      const step = event.shiftKey ? E.BIG_STEP_MM : E.STEP_MM;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[k] && ed.plan) {
        const [dx, dy] = moves[k];
        changeElement((e) => ({ ...e, ...E.pas(ed.plan, e, dx, dy) }));
        return true;
      }
      return false;
    }

    ed.ouvrir = ouvrir;
    ed.fermer = fermer;
    ed.ajuster = fit;
    ed.key = key;
    ed.annuler = undo;
    ed.retablir = redo;
    ed.recharger = reload;
    ed.miroir = miroir;
    return ed;
  }

  // Le clavier va à l'éditeur affiché, jamais à un champ de saisie ni à une fenêtre ouverte.
  document.addEventListener('keydown', (event) => {
    const t = event.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t?.isContentEditable) return;
    if (document.querySelector('dialog[open]')) return;
    const ed = instances.find((x) => x.frame.offsetParent !== null);
    if (ed && ed.key(event)) event.preventDefault();
  });

  return { creer };
})();
