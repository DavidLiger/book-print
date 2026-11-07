// src/ui/app.js — page locale de book-print : un menu d'étapes (UI1) et un panneau par étape : configuration, livre lu, dossier (MP1),
// simulateur de prix (PX1), collection et essai du gabarit 2A (MP2), sujets et relecture (MP3), droits et illustrations (MP4), workflows et génération par ComfyUI (IC1). L'état des étapes vient du serveur (`/api/parcours`).
// Les textes viennent de fichiers : ils passent toujours par textContent.

async function action(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-book-print': '1' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `erreur ${res.status}`);
  return data;
}

const $ = (id) => document.getElementById(id);

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}

function list(title, items, className) {
  const frag = document.createDocumentFragment();
  if (items.length === 0) return frag;
  frag.append(el('p', title, `titre-liste ${className}`));
  const ul = el('ul');
  for (const item of items) ul.append(el('li', item, className));
  frag.append(ul);
  return frag;
}

function definitions(pairs) {
  const dl = el('dl');
  for (const [k, v] of pairs) dl.append(el('dt', k), el('dd', v));
  return dl;
}

// Parcours (spec §5.3). La page ne garde rien : elle demande les étapes au serveur après chaque action.

const parcours = { steps: [], subjects: [], current: 'livre', turn: 0 };
const SIGNS = { 'à faire': '○', 'à refaire': '↻', validée: '✓', alerte: '⚠', erreur: '✗', verrouillée: '🔒' };
const shownSteps = () => parcours.steps.filter((s) => s.scope === 'livre');

function stepButton(step, current, open) {
  const button = el('button');
  button.type = 'button';
  button.dataset.step = step.id;
  button.title = step.reasons.join(' ') || step.stateLabel;
  const sign = el('span', SIGNS[step.stateLabel], 'nom-signe signe');
  sign.setAttribute('role', 'img');
  sign.setAttribute('aria-label', step.stateLabel);
  // Le motif d'une étape verrouillée se lit sur l'onglet : son panneau ne s'ouvre pas.
  const locked = step.state === 'verrouillee';
  button.append(el('span', String(step.number), 'numero'), el('span', step.label, 'nom'), sign, el('span', locked ? step.reasons[0] : step.stateLabel, 'detail'));
  if (locked) button.setAttribute('aria-disabled', 'true');
  else button.addEventListener('click', () => open(step.id));
  if (step.id === current) button.setAttribute('aria-current', 'step');
  return button;
}

function stepItems(steps, current, open) {
  return steps.map((step) => {
    const li = el('li');
    li.dataset.state = step.state;
    li.append(stepButton(step, current, open));
    return li;
  });
}

function showReasons(step, box = $('motifs')) {
  const classes = { erreur: 'erreur', alerte: 'alerte' };
  box.replaceChildren(...(step?.reasons ?? []).map((r) => el('p', r, classes[step.state] ?? 'note')));
  box.hidden = box.childElementCount === 0;
}

function showStep(id) {
  const changed = parcours.current !== id;
  parcours.current = id;
  for (const step of shownSteps()) $(step.id).hidden = step.id !== id;
  $('etapes').replaceChildren(...stepItems(shownSteps(), id, showStep));
  showReasons(id === 'sujets' && sujets.open ? undefined : shownSteps().find((s) => s.id === id));
  if (changed && id === 'sujets') loadSujets();
  if (changed && id === 'droits') loadDroits();
  if (changed && id === 'workflows') loadWorkflows();
}

/** `reopen` : le livre vient d'être choisi, on repart de la première étape non validée. Sinon on reste là où on est, si l'étape reste ouverte. */
async function refreshParcours({ reopen = false } = {}) {
  const turn = ++parcours.turn;
  let view;
  try {
    view = await action('/api/parcours', { dir: $('choix').value || null });
  } catch (e) {
    $('motifs').replaceChildren(el('p', e.message, 'erreur'));
    $('motifs').hidden = false;
    return;
  }
  if (turn !== parcours.turn) return;
  parcours.steps = view.steps;
  parcours.subjects = view.subjects;
  showSubjectList();
  showSubSteps();
  const current = shownSteps().find((s) => s.id === parcours.current);
  showStep(reopen || !current || current.state === 'verrouillee' ? view.open : parcours.current);
}

function showConfig(config) {
  const box = $('config');
  box.replaceChildren();
  if (!config.ok) {
    box.append(el('p', config.message, 'erreur'));
    return;
  }
  box.append(el('p', 'Configuration valide.', 'bien'), definitions([['glbRoot', config.glbRoot], ['dataRoot', config.dataRoot]]));
}

function scenesTable(scenes) {
  const table = el('table');
  const head = el('tr');
  for (const t of ['Rang', 'Scène', 'Titre', 'QR']) head.append(el('th', t));
  table.append(head);
  for (const s of scenes) {
    const row = el('tr');
    row.append(el('td', String(s.rank)), el('td', s.id), el('td', s.title?.fr ?? '—'), el('td', s.qr?.file ?? '—'));
    table.append(row);
  }
  return table;
}

async function readSelected() {
  const dir = $('choix').value;
  const box = $('lecture');
  box.replaceChildren();
  $('lecture-resume').replaceChildren();
  $('creation').replaceChildren();
  $('creer').disabled = true;
  if (!dir) return refreshParcours({ reopen: true });
  const { reading } = await action('/api/read', { dir });
  $('lecture-resume').append(
    definitions([
      ['Titre', reading.title?.fr ?? '—'],
      ['bookId', reading.bookId ?? '—'],
      ['origin', reading.origin ?? '—'],
      ['Scènes', String(reading.scenes.length)],
      ['QR du jeu', reading.gameQr?.file ?? 'aucun'],
    ]),
  );
  box.append(
    list(`Erreurs (${reading.errors.length})`, reading.errors, 'erreur'),
    list(`Alertes (${reading.alerts.length})`, reading.alerts, 'alerte'),
  );
  if (reading.errors.length === 0 && reading.alerts.length === 0) box.append(el('p', 'Aucune erreur ni alerte.', 'bien'));
  if (reading.scenes.length > 0) box.append(scenesTable(reading.scenes));
  $('creer').disabled = reading.errors.length > 0 || !reading.bookId;
  if ($('creer').disabled) $('creation').append(el('p', 'Création impossible tant que la lecture est en erreur.', 'alerte'));
  if (reading.bookId) {
    await openPricing(reading.bookId);
    await openEssai(reading.bookId);
  }
  closeSubject();
  await refreshParcours({ reopen: true });
  if (parcours.current === 'sujets') await loadSujets();
  if (parcours.current === 'droits') await loadDroits();
  if (parcours.current === 'workflows') await loadWorkflows();
}

async function createFolder() {
  const box = $('creation');
  box.replaceChildren();
  $('creer').disabled = true;
  try {
    const { result } = await action('/api/create', { dir: $('choix').value });
    box.append(
      list(`Créés (${result.created.length})`, result.created, 'bien'),
      list(`Conservés, non modifiés (${result.kept.length})`, result.kept, ''),
      list(`Alertes (${result.alerts.length})`, result.alerts, 'alerte'),
    );
    await openPricing(result.bookId);
    await openEssai(result.bookId);
  } catch (e) {
    box.append(el('p', e.message, 'erreur'));
  } finally {
    $('creer').disabled = false;
    await refreshParcours();
  }
}

// Simulateur de prix (spec §9). Tout le calcul reste côté serveur : la page envoie le scénario et affiche le résultat.

const INK_LABELS = {
  'premium-color': 'Couleur premium, papier blanc',
  'standard-color': 'Couleur standard, papier blanc',
  'black-white': 'Noir, papier blanc',
  'black-cream': 'Noir, papier crème',
  'black-groundwood': 'Noir, papier journal',
};
const BINDING_LABELS = { paperback: 'Broché', hardcover: 'Relié' };
const CATEGORY_LABELS = { regular: 'format normal', large: 'grand format' };
const SYMBOLS = { EUR: '€', GBP: '£', USD: '$' };

const pricing = { bookId: null, catalog: null, editId: null, scenarios: [], timer: null, turn: 0, view: 'simulateur', folder: false };

function money(cents, currency) {
  if (cents === null || cents === undefined) return '—';
  const abs = Math.abs(cents);
  return `${cents < 0 ? '−' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')} ${SYMBOLS[currency] ?? currency}`;
}

const percent = (value) => `${String(value).replace('.', ',')} %`;

function fillTrims(selected) {
  const select = $('p-format');
  const trims = pricing.catalog.trims[$('p-reliure').value];
  select.replaceChildren();
  for (const t of trims) {
    const option = el('option', `${t.label} (${CATEGORY_LABELS[t.category]})`);
    option.value = `${t.widthIn}x${t.heightIn}`;
    select.append(option);
  }
  const wanted = selected ?? '6x9';
  if (trims.some((t) => `${t.widthIn}x${t.heightIn}` === wanted)) select.value = wanted;
}

function showPageFields() {
  const estimated = $('p-mode').value === 'estime';
  $('c-pages').hidden = estimated;
  for (const id of ['c-sujets', 'c-par-sujet', 'c-extra']) $(id).hidden = !estimated;
}

function readForm() {
  const [widthIn, heightIn] = $('p-format').value.split('x').map(Number);
  const scenario = {
    name: $('p-nom').value.trim() || 'Sans nom',
    binding: $('p-reliure').value,
    trim: { widthIn, heightIn },
    ink: $('p-encre').value,
    pages: $('p-mode').value === 'saisi'
      ? { mode: 'saisi', pages: Number($('p-pages').value) }
      : { mode: 'estime', subjects: Number($('p-sujets').value), pagesPerSubject: Number($('p-par-sujet').value), extraPages: Number($('p-extra').value) },
    marketplace: $('p-marketplace').value,
    vat: $('p-tva').value,
    price: { kind: $('p-type-prix').value, amount: Number($('p-prix').value) },
  };
  if ($('p-visee').value !== '') scenario.targetRoyalty = Number($('p-visee').value);
  return scenario;
}

function writeForm(s) {
  $('p-nom').value = s.name;
  $('p-reliure').value = s.binding;
  fillTrims(`${s.trim.widthIn}x${s.trim.heightIn}`);
  $('p-encre').value = s.ink;
  $('p-mode').value = s.pages.mode;
  if (s.pages.mode === 'saisi') $('p-pages').value = s.pages.pages;
  else {
    $('p-sujets').value = s.pages.subjects;
    $('p-par-sujet').value = s.pages.pagesPerSubject;
    $('p-extra').value = s.pages.extraPages;
  }
  $('p-marketplace').value = s.marketplace;
  $('p-tva').value = s.vat;
  $('p-type-prix').value = s.price.kind;
  $('p-prix').value = s.price.amount;
  $('p-visee').value = s.targetRoyalty ?? '';
  showPageFields();
}

function ttcText(taxed, result, key, pctKey) {
  return result.vatPct ? `${money(taxed[key], result.currency)} (${percent(result.vatPct[pctKey])})` : 'sans TVA';
}

function targetText(result) {
  if (!result.target) return '—';
  const { target: t, currency } = result;
  return `${money(t.ht, currency)} HT, ${ttcText(t, result, 'ttcReduced', 'reduced')}, ${ttcText(t, result, 'ttcStandard', 'standard')}, à ${t.ratePct} %`;
}

function resultPairs(r) {
  return [
    ['Format', `${r.trim}, ${CATEGORY_LABELS[r.category]}`],
    ['Pages', `${r.pages} (${r.pagesCalculation})`],
    ['Coût d\'impression', money(r.printCost, r.currency)],
    ['Prix HT', money(r.price.ht, r.currency)],
    ['Prix TTC, taux réduit', ttcText(r.price, r, 'ttcReduced', 'reduced')],
    ['Prix TTC, taux normal', ttcText(r.price, r, 'ttcStandard', 'standard')],
    ['Taux de redevance', r.ratePct === null ? '—' : `${r.ratePct} %`],
    ['Redevance Amazon', money(r.royalty, r.currency)],
    ['Redevance en distribution étendue', r.printCost !== null && r.expandedRoyalty === null ? 'sans objet' : money(r.expandedRoyalty, r.currency)],
    ['Prix minimum HT', money(r.minimumPrice, r.currency)],
    ['Prix pour la redevance visée', targetText(r)],
  ];
}

function showPricingView(view) {
  pricing.view = view;
  $('prix-form').hidden = view !== 'simulateur' || !pricing.folder;
  $('prix-liste').hidden = view !== 'scenarios';
  $('v-simulateur').setAttribute('aria-pressed', String(view === 'simulateur'));
  $('v-scenarios').setAttribute('aria-pressed', String(view === 'scenarios'));
}

function showResult(result) {
  $('prix-resultat').replaceChildren(definitions(resultPairs(result)));
  $('prix-calcul').replaceChildren(
    list(`Erreurs (${result.errors.length})`, result.errors, 'erreur'),
    list(`Alertes (${result.alerts.length})`, result.alerts, 'alerte'),
  );
}

async function computeNow() {
  const turn = ++pricing.turn;
  try {
    const { result } = await action('/api/pricing/compute', { scenario: readForm() });
    if (turn === pricing.turn) showResult(result);
  } catch (e) {
    if (turn !== pricing.turn) return;
    $('prix-resultat').replaceChildren();
    $('prix-calcul').replaceChildren(el('p', e.message, 'erreur'));
  }
}

function computeSoon() {
  clearTimeout(pricing.timer);
  pricing.timer = setTimeout(computeNow, 150);
}

function smallButton(text, onClick) {
  const b = el('button', text, 'petit secondaire');
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function scenarioActions(s, retained) {
  const td = el('td');
  td.append(
    smallButton('Modifier', () => {
      pricing.editId = s.id;
      writeForm(s);
      computeNow();
      $('p-enregistrer').textContent = `Mettre à jour « ${s.name} »`;
      showPricingView('simulateur');
    }),
    smallButton(retained ? 'Ne plus retenir' : 'Retenir', () => pricingAction('/api/pricing/retain', { id: retained ? null : s.id })),
    smallButton('Supprimer', () => pricingAction('/api/pricing/delete', { id: s.id })),
  );
  return td;
}

function messagesCell(items, className) {
  const td = el('td');
  if (items.length === 0) td.textContent = '—';
  for (const item of items) td.append(el('p', item, `${className} cellule`));
  return td;
}

function showScenarios(view) {
  const box = $('prix-scenarios');
  box.replaceChildren();
  $('v-scenarios').textContent = `Scénarios enregistrés (${view.scenarios.length})`;
  $('prix-ecart').replaceChildren(
    list('Écart entre print-book.json et le scénario retenu (fichier non modifié)', view.deviation, 'alerte'),
  );
  if (view.bookAlert) $('prix-ecart').append(el('p', view.bookAlert, 'alerte'));
  if (view.retainedId && view.deviation.length === 0 && !view.bookAlert) $('prix-ecart').append(el('p', 'print-book.json correspond au scénario retenu.', 'bien'));
  if (view.scenarios.length === 0) {
    box.append(el('p', 'Aucun scénario enregistré.', 'note'));
    return;
  }
  const rows = [
    ['Reliure', ({ scenario: s }) => BINDING_LABELS[s.binding]],
    ['Encre et papier', ({ scenario: s }) => INK_LABELS[s.ink]],
    ['Marketplace', ({ scenario: s }) => s.marketplace],
  ];
  const table = el('table');
  const head = el('tr');
  head.append(el('th', 'Scénario'));
  for (const { scenario: s } of view.scenarios) {
    const th = el('th', s.name);
    if (s.id === view.retainedId) th.append(el('span', ' (retenu)', 'retenu'));
    head.append(th);
  }
  table.append(head);
  const addRow = (label, cell) => {
    const tr = el('tr');
    tr.append(el('th', label));
    for (const item of view.scenarios) tr.append(cell(item));
    table.append(tr);
  };
  for (const [label, value] of rows) addRow(label, (item) => el('td', value(item)));
  resultPairs(view.scenarios[0].result).forEach(([label], i) => addRow(label, ({ result }) => el('td', resultPairs(result)[i][1])));
  addRow('Erreurs', ({ result }) => messagesCell(result.errors, 'erreur'));
  addRow('Alertes', ({ result }) => messagesCell(result.alerts, 'alerte'));
  addRow('Actions', ({ scenario: s }) => scenarioActions(s, s.id === view.retainedId));
  box.append(table);
}

function showPricing(view) {
  pricing.catalog = view.catalog;
  pricing.scenarios = view.scenarios;
  showScenarios(view);
}

async function pricingAction(path, body) {
  $('prix-message').replaceChildren();
  try {
    const view = await action(path, { bookId: pricing.bookId, ...body });
    if (pricing.editId && !view.scenarios.some((x) => x.scenario.id === pricing.editId)) resetForm();
    showPricing(view);
    return true;
  } catch (e) {
    $('prix-message').replaceChildren(el('p', e.message, 'erreur'));
    return false;
  } finally {
    await refreshParcours();
  }
}

function resetForm() {
  pricing.editId = null;
  $('p-enregistrer').textContent = 'Enregistrer le scénario';
  $('p-nom').value = '';
}

function setupForm(catalog) {
  const warning = $('prix-avertissement');
  const link = el('a', 'Calculateur officiel');
  link.href = catalog.calculatorUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  warning.replaceChildren(`${catalog.warning} `, link);
  const select = $('p-marketplace');
  const current = select.value || 'amazon.fr';
  select.replaceChildren();
  for (const m of catalog.marketplaces) {
    const option = el('option', m);
    option.value = m;
    select.append(option);
  }
  select.value = current;
  fillTrims($('p-format').value || undefined);
  showPageFields();
}

async function openPricing(bookId) {
  pricing.bookId = bookId;
  $('prix-message').replaceChildren();
  try {
    const view = await action('/api/pricing/state', { bookId });
    pricing.catalog = view.catalog;
    setupForm(view.catalog);
    pricing.folder = view.folder;
    showPricingView(pricing.view);
    if (!view.folder) $('prix-message').append(el('p', 'Créer le dossier du livre pour enregistrer des scénarios.', 'alerte'));
    showPricing(view);
    if (view.folder) await computeNow();
  } catch (e) {
    pricing.folder = false;
    showPricingView(pricing.view);
    $('prix-scenarios').replaceChildren();
    $('prix-ecart').replaceChildren();
    $('prix-message').append(el('p', e.message, 'erreur'));
  }
}

async function saveCurrent(event) {
  event.preventDefault();
  const body = { scenario: readForm() };
  if (pricing.editId) body.id = pricing.editId;
  if (await pricingAction('/api/pricing/save', body)) resetForm();
}

// Essai du gabarit 2A (spec §5.2, étape 7). L'aperçu est le HTML du PDF, dans un cadre sans script. Les repères sont dessinés ici,
// par-dessus le cadre, à partir de la géométrie du serveur : ils n'existent pas dans le HTML imprimé.

const essai = { bookId: null };
const essaiView = { layout: null, frame: $('apercu-cadre'), inner: $('apercu-echelle'), svg: $('reperes'), boxes: 'input[data-layer]', attr: 'layer' };
const SVG_NS = 'http://www.w3.org/2000/svg';
const PX_PER_MM = 96 / 25.4;

function svgEl(tag, attrs, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

const rectAttrs = (r, x) => ({ x: r.left + x, y: r.top, width: r.right - r.left, height: r.bottom - r.top });

function drawPageMarks(layers, page, x) {
  const t = page.trim;
  const outer = `M${x} 0h${page.widthMm}v${page.heightMm}h${-page.widthMm}z`;
  const inner = `M${t.left + x} ${t.top}H${t.right + x}V${t.bottom}H${t.left + x}z`;
  layers.bleed.append(svgEl('path', { d: `${outer}${inner}`, 'fill-rule': 'evenodd', class: 'r-bleed' }));
  layers.safe.append(svgEl('rect', { ...rectAttrs(page.safe, x), class: 'r-safe' }));
  layers.fold.append(svgEl('line', { x1: page.foldMm + x, x2: page.foldMm + x, y1: 0, y2: page.heightMm, class: 'r-fold' }));
  for (const z of page.zones) {
    layers.zones.append(svgEl('rect', { ...rectAttrs(z.rect, x), class: 'r-zone' }));
    layers.zones.append(svgEl('text', { x: z.rect.left + x + 1, y: z.rect.top + 4, class: 'r-label' }, z.id));
  }
}

function drawMarks(view) {
  const width = view.layout.reduce((sum, p) => sum + p.widthMm, 0);
  const height = view.layout[0].heightMm;
  const { svg } = view;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();
  const layers = {};
  for (const name of ['bleed', 'safe', 'fold', 'zones']) {
    layers[name] = svgEl('g', { 'data-layer': name });
    svg.append(layers[name]);
  }
  let x = 0;
  for (const page of view.layout) {
    drawPageMarks(layers, page, x);
    x += page.widthMm;
  }
  showLayers(view);
  fitPreview(view);
}

function showLayers(view) {
  for (const box of document.querySelectorAll(view.boxes)) {
    const name = view.attr === 'layer' ? box.dataset.layer : box.dataset.sujetLayer;
    const layer = view.svg.querySelector(`g[data-layer="${name}"]`);
    if (layer) layer.setAttribute('display', box.checked ? 'inline' : 'none');
  }
}

/** Double page à taille réelle réduite à la place disponible, en largeur et en hauteur. Le PDF, lui, se juge à 100 %. */
function fitPreview(view) {
  const { frame, inner } = view;
  if (!view.layout || frame.clientWidth === 0) return;
  const width = view.layout.reduce((sum, p) => sum + p.widthMm, 0) * PX_PER_MM;
  const height = view.layout[0].heightMm * PX_PER_MM;
  const scale = Math.min(1, frame.clientWidth / width, frame.clientHeight / height);
  inner.style.width = `${width}px`;
  inner.style.height = `${height}px`;
  inner.style.left = `${(frame.clientWidth - width * scale) / 2}px`;
  inner.style.transform = `scale(${scale})`;
}

function loadPreview() {
  const query = new URLSearchParams({ bookId: essai.bookId, theme: $('essai-theme').value, t: String(Date.now()) });
  $('apercu').src = `/apercu?${query}`;
}

function checksTable(checks) {
  const table = el('table');
  const head = el('tr');
  for (const t of ['Contrôle', 'Objet', 'Résultat']) head.append(el('th', t));
  table.append(head);
  const CHECK_SIGNS = { ok: ['✓', 'contrôle réussi'], alerte: ['⚠', 'alerte'], erreur: ['✗', 'erreur'] };
  const CLASSES = { ok: 'bien', alerte: 'alerte', erreur: 'erreur' };
  for (const c of checks) {
    const row = el('tr');
    const verdict = el('td');
    const [sign, meaning] = CHECK_SIGNS[c.level];
    const mark = el('span', sign, `signe ${CLASSES[c.level]}`);
    mark.title = meaning;
    mark.setAttribute('aria-label', meaning);
    verdict.append(mark);
    for (const d of c.details) verdict.append(el('p', d, `${CLASSES[c.level]} cellule`));
    row.append(el('td', c.id), el('td', c.label), verdict);
    table.append(row);
  }
  return table;
}

function showExport(r) {
  const size = r.pages.map((p) => `p. ${p.number} : ${String(p.widthPt).replace('.', ',')} × ${String(p.heightPt).replace('.', ',')} pt`).join(' ; ');
  $('essai-resultat').replaceChildren(
    checksTable(r.checks),
    definitions([
      ['Fichier', r.file],
      ['Taille demandée', `${String(r.pageSizeIn.widthIn).replace('.', ',')} × ${String(r.pageSizeIn.heightIn).replace('.', ',')} "`],
      ['Pages relues dans le PDF', size],
      ['Polices relues dans le PDF', r.fonts.map((f) => `${f.name} (${f.how})`).join(' ; ')],
      ['Poids', `${(r.sizeBytes / 1e6).toFixed(2).replace('.', ',')} Mo`],
      ['Chromium', r.chromium],
    ]),
  );
}

function showCollection(state) {
  const { exists, error } = state.collection;
  const box = $('collection-etat');
  if (error) box.replaceChildren(el('p', error, 'erreur'));
  else if (!exists) box.replaceChildren(el('p', 'collection/ absent.', 'alerte'));
  else box.replaceChildren(el('p', 'collection/ présent et valide.', 'bien'), definitions([['Thèmes', state.themes.join(', ')], ['Premier thème', state.theme]]));
}

async function openEssai(bookId) {
  essai.bookId = bookId;
  $('essai-zone').hidden = true;
  $('essai-resultat').replaceChildren();
  const box = $('essai-message');
  box.replaceChildren();
  try {
    const state = await action('/api/essai/state', { bookId });
    showCollection(state);
    if (!state.collection.exists) box.append(el('p', 'collection/ absent : le créer pour voir l\'aperçu.', 'alerte'));
    if (state.collection.error) box.append(el('p', state.collection.error, 'erreur'));
    if (state.error) box.append(el('p', state.error, 'erreur'));
    if (!state.layout) return;
    const select = $('essai-theme');
    const current = select.value;
    select.replaceChildren();
    for (const name of state.themes) {
      const option = el('option', name);
      option.value = name;
      select.append(option);
    }
    select.value = state.themes.includes(current) ? current : state.theme;
    essaiView.layout = state.layout;
    $('essai-zone').hidden = false;
    drawMarks(essaiView);
    loadPreview();
  } catch (e) {
    box.append(el('p', e.message, 'erreur'));
  }
}

async function createCollection() {
  const box = $('collection-resultat');
  box.replaceChildren();
  $('collection-creer').disabled = true;
  try {
    const { result } = await action('/api/collection/create');
    box.append(list(`Créés (${result.created.length})`, result.created, 'bien'), list(`Conservés, non modifiés (${result.kept.length})`, result.kept, ''));
    await openEssai(essai.bookId);
  } catch (e) {
    box.append(el('p', e.message, 'erreur'));
  } finally {
    $('collection-creer').disabled = false;
    await refreshParcours();
  }
}

async function exportEssai() {
  const button = $('essai-exporter');
  const box = $('essai-resultat');
  button.disabled = true;
  box.replaceChildren(el('p', 'Export en cours…', 'note'));
  try {
    showExport(await action('/api/essai/export', { bookId: essai.bookId, theme: $('essai-theme').value }));
  } catch (e) {
    box.replaceChildren(el('p', e.message, 'erreur'));
  } finally {
    button.disabled = false;
    await refreshParcours();
  }
}

async function reloadEssai() {
  await openEssai(essai.bookId);
  await refreshParcours();
}

// Sujets (spec §5.2, étapes 2 à 5 et 7). Rien n'est gardé dans le navigateur : chaque changement est écrit aussitôt par le serveur, qui renvoie
// l'état du sujet. La file `queue` garde l'ordre des écritures quand David enchaîne les modifications.

const CLAIM_LABELS = { propose: 'proposée', valide: 'validée', rejete: 'rejetée', corrige: 'corrigée' };
const BLOCK_LABELS = { 'a-relire': 'à relire', valide: 'validé', 'a-reprendre': 'à reprendre' };
const VALIDATED = ['valide', 'corrige'];
const IMPORT_MAX = 2 * 1024 * 1024;
const SAVE_DELAY_MS = 600;

const sujets = { book: null, open: null, step: null, view: null, queue: Promise.resolve(), pending: null, timers: new Map() };
const sujetView = { layout: null, frame: $('sa-cadre'), inner: $('sa-echelle'), svg: $('sa-reperes'), boxes: 'input[data-sujet-layer]', attr: 'sujetLayer' };
const openSubjectFacts = () => parcours.subjects.find((s) => s.id === sujets.open);
const dirOf = () => $('choix').value;

function fillSelect(select, items, value) {
  select.replaceChildren(...items.map(([v, label]) => {
    const option = el('option', label);
    option.value = v;
    return option;
  }));
  if (value !== undefined) select.value = value;
}

function fillTemplates() {
  const pages = Number($('s-pages').value);
  const usable = (sujets.book?.templates ?? []).filter((t) => t.pages === pages);
  fillSelect($('s-gabarit'), usable.map((t) => [t.id, t.fits ? t.id : `${t.id} (côté de départ incompatible)`]));
  $('s-creer').disabled = !usable.some((t) => t.fits);
}

function showBookState(state) {
  sujets.book = state;
  const keep = $('s-scene').value;
  const free = state.scenes.find((s) => !s.used)?.id;
  fillSelect($('s-scene'), state.scenes.map((s) => [s.id, `${s.title} (${s.id})${s.used ? ', déjà un sujet' : ''}`]));
  $('s-scene').value = state.scenes.some((s) => s.id === keep && !s.used) ? keep : free ?? state.scenes[0]?.id ?? '';
  fillSelect($('s-theme'), state.themes.map((t) => [t, t]), state.proposedTheme);
  fillTemplates();
  showSubjectList();
}

async function loadSujets() {
  if (!dirOf()) return;
  try {
    showBookState(await action('/api/sujets/state', { dir: dirOf() }));
  } catch (e) {
    $('sujet-message').replaceChildren(el('p', e.message, 'erreur'));
  }
}

function showSubjectList() {
  const { book } = sujets;
  if (book) {
    const total = book.subjectPages;
    $('sujets-total').textContent = `${parcours.subjects.length} sujet${parcours.subjects.length > 1 ? 's' : ''}, ${total} pages de sujets. Budget indicatif du livre : ${book.pageBudget} pages. Prochain sujet en page ${book.firstPage}.`;
  }
  const box = $('sujets-liste');
  if (parcours.subjects.length === 0) {
    box.replaceChildren(el('p', 'Aucun sujet pour l\'instant.', 'note'));
    return;
  }
  const table = el('table');
  const head = el('tr');
  for (const t of ['Sujet', 'Pages', 'Gabarit', 'Thème', 'État', '']) head.append(el('th', t));
  table.append(head);
  for (const s of parcours.subjects) {
    const row = el('tr');
    const action = el('td');
    action.append(smallButton('Ouvrir', () => openSubject(s.id)));
    const state = s.error ? el('td', s.error, 'erreur') : el('td', s.status);
    row.append(el('td', s.title), el('td', String(s.pages)), el('td', s.template ?? '—'), el('td', s.theme ?? '—'), state, action);
    table.append(row);
  }
  box.replaceChildren(table);
}

async function createSubject(event) {
  event.preventDefault();
  const box = $('sujet-message');
  box.replaceChildren();
  try {
    const state = await action('/api/sujets/create', {
      dir: dirOf(),
      sceneId: $('s-scene').value,
      pages: Number($('s-pages').value),
      template: $('s-gabarit').value,
      theme: $('s-theme').value,
    });
    showBookState(state);
    box.append(el('p', `Sujet ${state.subject.id} créé.`, 'bien'));
  } catch (e) {
    box.append(el('p', e.message, 'erreur'));
  } finally {
    await refreshParcours();
  }
}

function closeSubject() {
  sujets.open = null;
  sujets.view = null;
  sujets.step = null;
  sujets.pending = null;
  $('sujet-ouvert').hidden = true;
  $('sujets-accueil').hidden = false;
}

function showSubSteps() {
  const facts = openSubjectFacts();
  if (!facts) return;
  $('sous-etapes').replaceChildren(...stepItems(facts.steps, sujets.step, showSubStep));
  $('sujet-nom').textContent = facts.title;
  showReasons(facts.steps.find((s) => s.id === sujets.step), $('sujet-motifs'));
}

function showSubStep(id) {
  sujets.step = id;
  const facts = openSubjectFacts();
  for (const step of facts?.steps ?? []) $(step.id).hidden = step.id !== id;
  showSubSteps();
  if (id === 'sujet-apercu') loadSubjectPreview();
  if (id === 'sujet-illustrations') {
    enqueue(loadImages, $('il-message'));
    if (images.mode === 'generer') showImageMode('generer');
  }
}

async function loadSubject() {
  sujets.view = await action('/api/sujet/state', { dir: dirOf(), subjectId: sujets.open });
  showRelecture();
}

async function openSubject(id) {
  closeSubject();
  $('sujet-erreur').replaceChildren();
  $('sa-resultat').replaceChildren();
  $('r-resultat').replaceChildren();
  $('r-copie').textContent = '';
  $('r-prompt').hidden = true;
  $('r-confirmation').hidden = true;
  $('rl-message').replaceChildren();
  resetImages();
  resetGenerate();
  sujets.open = id;
  $('motifs').hidden = true;
  $('sujets-accueil').hidden = true;
  $('sujet-ouvert').hidden = false;
  try {
    await refreshParcours();
    await loadSubject();
    showSubStep(openSubjectFacts().open);
  } catch (e) {
    $('sujet-erreur').replaceChildren(el('p', e.message, 'erreur'));
  }
}

function enqueue(task, errorBox) {
  sujets.queue = sujets.queue.then(task).catch((e) => errorBox.replaceChildren(el('p', e.message, 'erreur')));
  return sujets.queue;
}

/** Écrit un changement. Le résultat des contrôles ne vaut plus : il disparaît jusqu'au prochain contrôle. */
function subjectChange(path, body) {
  $('rl-message').replaceChildren();
  $('sa-resultat').replaceChildren();
  const id = sujets.open;
  return enqueue(async () => {
    const view = await action(path, { dir: dirOf(), subjectId: id, ...body });
    if (sujets.open !== id) return;
    sujets.view = view;
    showRelecture();
    await refreshParcours();
  }, $('rl-message'));
}

// Recherche

async function preparePrompt() {
  const line = $('r-copie');
  line.textContent = '';
  try {
    const { prompt } = await action('/api/sujet/prompt', { dir: dirOf(), subjectId: sujets.open });
    $('r-prompt').value = prompt;
    $('r-prompt').hidden = false;
    try {
      await navigator.clipboard.writeText(prompt);
      line.textContent = 'Prompt copié dans le presse-papiers.';
    } catch {
      line.textContent = 'Copie refusée par le navigateur : sélectionner le texte ci-dessous et le copier.';
    }
  } catch (e) {
    line.textContent = e.message;
  }
}

function summaryPairs(s) {
  return [
    ['Affirmations gardées', String(s.claimsKept)],
    ['Affirmations nouvelles ou modifiées', String(s.claimsChanged)],
    ['Affirmations retirées', String(s.claimsRemoved)],
    ['Blocs gardés', String(s.blocksKept)],
    ['Blocs remplacés, à relire', String(s.blocksChanged)],
    ['Blocs à reprendre', String(s.blocksToRedo)],
  ];
}

async function sendImport(content, confirm) {
  const box = $('r-resultat');
  box.replaceChildren();
  $('r-confirmation').hidden = true;
  const reply = await action('/api/sujet/import', { dir: dirOf(), subjectId: sujets.open, content, ...(confirm ? { confirm } : {}) });
  if (reply.needsConfirm) {
    sujets.pending = content;
    $('r-resume').replaceChildren(definitions(summaryPairs(reply.summary)));
    $('r-confirmation').hidden = false;
    return;
  }
  sujets.pending = null;
  box.append(el('p', 'Fichier importé : affirmations proposées, blocs à relire.', 'bien'), definitions(summaryPairs(reply.summary)));
  if (reply.kept.length > 0) box.append(el('p', `Anciens fichiers gardés : ${reply.kept.join(', ')}.`, 'note'));
  await loadSubject();
  await refreshParcours();
}

async function importFile(file) {
  const box = $('r-resultat');
  box.replaceChildren();
  $('r-fichier').value = '';
  if (file.size > IMPORT_MAX) {
    box.append(el('p', 'Fichier refusé : 2 Mio au plus.', 'erreur'));
    return;
  }
  try {
    await sendImport(await file.text(), false);
  } catch (e) {
    box.replaceChildren(el('p', e.message, 'erreur'));
  }
}

async function confirmImport() {
  try {
    await sendImport(sujets.pending, true);
  } catch (e) {
    $('r-resultat').replaceChildren(el('p', e.message, 'erreur'));
  }
}

// Relecture

function urlLine(source) {
  const check = source.urlCheck;
  if (!check) return el('p', 'URL non contrôlée.', 'note');
  const text = `${new Date(check.date).toLocaleString('fr-FR')} : ${check.code ?? check.error}`;
  if (check.code === null) return el('p', `Sans réponse, ${text}`, 'alerte');
  return el('p', `HTTP ${text.replace(/^(.*) : (\d+)$/, '$2, $1')}`, source.urlDead ? 'alerte' : check.code >= 300 ? 'note' : 'bien');
}

function sourceBlock(source) {
  const box = el('div', undefined, 'source');
  const link = el('a', source.title);
  link.href = source.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const line = el('p');
  line.append(link, ` — ${source.publisher}${source.published ? `, ${source.published}` : ''}`);
  box.append(line, el('p', source.support), urlLine(source));
  return box;
}

const claimAction = (id, kind, extra = {}) => subjectChange('/api/sujet/claim', { claimId: id, action: { kind, ...extra } });

function correctionForm(claim, card) {
  const form = el('div');
  const area = el('textarea');
  area.rows = 3;
  area.value = claim.correctedText ?? claim.text;
  area.dataset.key = `correction-${claim.id}`;
  area.setAttribute('aria-label', `Correction de ${claim.id}`);
  const save = el('button', 'Enregistrer la correction', 'petit');
  save.type = 'button';
  save.addEventListener('click', () => claimAction(claim.id, 'corriger', { text: area.value }));
  form.append(area, save, smallButton('Annuler', () => form.remove()));
  card.append(form);
  area.focus();
}

function claimCard(claim) {
  const card = el('article', undefined, 'carte');
  card.dataset.claim = claim.id;
  card.dataset.state = claim.status;
  const head = el('header');
  head.append(el('strong', claim.id), el('span', CLAIM_LABELS[claim.status], 'etat'));
  if (claim.confidence === 'debattue') head.append(el('span', 'fait débattu', 'alerte etat'));
  card.append(head, el('p', claim.correctedText ?? claim.text));
  if (claim.correctedText) card.append(el('p', `Texte importé : ${claim.text}`, 'note'));
  for (const source of claim.sources) card.append(sourceBlock(source));
  const buttons = el('div', undefined, 'boutons');
  const validate = el('button', 'Valider', 'petit');
  validate.type = 'button';
  validate.disabled = VALIDATED.includes(claim.status);
  validate.addEventListener('click', () => claimAction(claim.id, 'valider'));
  const reject = smallButton('Rejeter', () => claimAction(claim.id, 'rejeter'));
  reject.disabled = claim.status === 'rejete';
  buttons.append(validate, smallButton('Corriger', () => {
    if (!card.querySelector('textarea')) correctionForm(claim, card);
  }), reject);
  const note = el('input');
  note.placeholder = 'Note';
  note.value = claim.note;
  note.dataset.key = `note-${claim.id}`;
  note.setAttribute('aria-label', `Note sur ${claim.id}`);
  note.addEventListener('change', () => claimAction(claim.id, 'note', { text: note.value }));
  card.append(buttons, note);
  return card;
}

function counterText(text, max) {
  const n = [...text].length;
  return max === null ? `${n} caractères` : `${n} / ${max} caractères`;
}

function updateCounter(line, text, max) {
  line.textContent = counterText(text, max);
  line.classList.toggle('erreur', max !== null && [...text].length > max);
}

function flushText(id, area) {
  clearTimeout(sujets.timers.get(id));
  sujets.timers.delete(id);
  const block = sujets.view.subject.blocks.find((b) => b.id === id);
  if ((block.text[sujets.view.lang] ?? '') === area.value) return;
  block.text[sujets.view.lang] = area.value;
  subjectChange('/api/sujet/block', { blockId: id, action: { kind: 'texte', text: area.value } });
}

function citations(block) {
  const box = el('div', undefined, 'cite');
  const { claims } = sujets.view;
  const cite = (list) => subjectChange('/api/sujet/block', { blockId: block.id, action: { kind: 'citer', claims: list } });
  for (const id of block.claims) {
    const claim = claims.find((c) => c.id === id);
    const chip = smallButton(`${id} ✕`, () => cite(block.claims.filter((c) => c !== id)));
    chip.title = `Retirer ${id} (${CLAIM_LABELS[claim?.status] ?? 'inconnue'})`;
    chip.disabled = block.claims.length === 1;
    box.append(el('span', `${CLAIM_LABELS[claim?.status] ?? 'inconnue'} :`, 'etat'), chip);
  }
  const others = claims.filter((c) => !block.claims.includes(c.id));
  if (others.length > 0) {
    const add = el('select');
    add.setAttribute('aria-label', `Citer une autre affirmation dans ${block.id}`);
    fillSelect(add, [['', 'Citer…'], ...others.map((c) => [c.id, `${c.id} (${CLAIM_LABELS[c.status]})`])]);
    add.addEventListener('change', () => cite([...block.claims, add.value]));
    box.append(add);
  }
  return box;
}

function blockCard(block) {
  const { lang, expected, claims } = sujets.view;
  const want = expected.find((b) => b.id === block.id);
  const card = el('article', undefined, 'carte');
  card.dataset.block = block.id;
  card.dataset.state = block.state;
  const head = el('header');
  head.append(el('strong', want?.label ?? block.id), el('span', BLOCK_LABELS[block.state], 'etat'));
  const area = el('textarea');
  area.rows = block.type === 'texte' ? 6 : block.type === 'chapeau' ? 3 : 1;
  area.value = block.text[lang] ?? '';
  area.dataset.key = `bloc-${block.id}`;
  area.setAttribute('aria-label', `Texte du bloc ${block.id}`);
  const counter = el('span', undefined, 'compteur');
  const max = want?.maxChars ?? null;
  updateCounter(counter, area.value, max);
  area.addEventListener('input', () => {
    updateCounter(counter, area.value, max);
    clearTimeout(sujets.timers.get(block.id));
    sujets.timers.set(block.id, setTimeout(() => flushText(block.id, area), SAVE_DELAY_MS));
  });
  area.addEventListener('change', () => flushText(block.id, area));
  const validate = el('button', 'Valider le bloc', 'petit');
  validate.type = 'button';
  const ready = block.claims.every((id) => VALIDATED.includes(claims.find((c) => c.id === id)?.status));
  validate.disabled = block.state === 'valide' || !ready;
  validate.title = ready ? '' : 'Toutes les affirmations citées doivent être validées.';
  validate.addEventListener('click', () => subjectChange('/api/sujet/block', { blockId: block.id, action: { kind: 'valider' } }));
  card.append(head, area, counter, citations(block), validate);
  return card;
}

/** Tout est reconstruit à chaque réponse : le champ en cours de saisie reprend sa valeur et sa place, rien de ce qui vient d'être tapé n'est perdu. */
function showRelecture() {
  const view = sujets.view;
  if (!view) return;
  const active = document.activeElement;
  const key = active?.dataset?.key;
  const typed = key ? { value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
  const noResearch = el('p', 'Importer d\'abord la recherche.', 'note');
  $('rl-claims').replaceChildren(...(view.claims.length ? view.claims.map(claimCard) : [noResearch]));
  $('rl-blocks').replaceChildren(...view.subject.blocks.map(blockCard));
  const count = (list, ok) => `${list.filter(ok).length} / ${list.length}`;
  $('rl-compte').textContent = `Affirmations traitées : ${count(view.claims, (c) => c.status !== 'propose')}. Blocs validés : ${count(view.subject.blocks, (b) => b.state === 'valide')}.`;
  $('rl-titre').value = view.titleOverride ?? '';
  $('rl-titre').placeholder = view.sceneTitle;
  $('rl-legende').value = view.legend;
  const titleSize = counterText(view.title, view.titleMax);
  $('rl-champs').textContent = `Titre : ${titleSize}${view.titleOverride ? ', surchargé pour l\'impression' : ', lu dans la scène'}. Légende : ${counterText(view.legend, view.legendMax)}.`;
  fillSelect($('sa-theme'), view.themes.map((t) => [t, t]), view.subject.variant.theme);
  sujetView.layout = view.layout;
  if (key) {
    const again = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (again) {
      again.value = typed.value;
      again.focus();
      if (typed.start !== null) again.setSelectionRange(typed.start, typed.end);
    }
  }
}

/** Hors de la file : les requêtes durent, et David peut continuer à relire. Le serveur ne pose que les résultats, sur le fichier du moment. */
async function checkUrlsNow() {
  const button = $('rl-urls');
  const box = $('rl-message');
  button.disabled = true;
  box.replaceChildren(el('p', 'Contrôle des URL en cours…', 'note'));
  const id = sujets.open;
  try {
    const view = await action('/api/sujet/urls', { dir: dirOf(), subjectId: id });
    if (sujets.open === id) {
      sujets.view = view;
      showRelecture();
      box.replaceChildren(el('p', 'Contrôle des URL terminé.', 'bien'));
    }
  } catch (e) {
    box.replaceChildren(el('p', e.message, 'erreur'));
  } finally {
    button.disabled = false;
  }
}

// Aperçu du sujet

function loadSubjectPreview() {
  if (!sujets.view) return;
  const query = new URLSearchParams({ dir: dirOf(), subject: sujets.open, t: String(Date.now()) });
  $('sa-page').src = `/apercu-sujet?${query}`;
  drawMarks(sujetView);
}

async function controlNow(mark) {
  const box = $('sa-resultat');
  for (const id of ['sa-controler', 'sa-relu']) $(id).disabled = true;
  box.replaceChildren(el('p', 'Contrôle en cours…', 'note'));
  try {
    const reply = await action('/api/sujet/check', { dir: dirOf(), subjectId: sujets.open, mark });
    sujets.view = reply;
    showRelecture();
    const message = reply.marked ? el('p', 'Sujet marqué relu.', 'bien') : mark ? el('p', `Sujet non relu : ${reply.reason}`, 'erreur') : el('p', 'Contrôles terminés.', 'note');
    box.replaceChildren(message, checksTable(reply.checks));
  } catch (e) {
    box.replaceChildren(el('p', e.message, 'erreur'));
  } finally {
    for (const id of ['sa-controler', 'sa-relu']) $(id).disabled = false;
    await refreshParcours();
  }
}

// Illustrations d'un sujet (spec §5.2, étape 6). Tout est écrit aussitôt par le serveur, qui renvoie zones, contrôles et registre.

const KIND_LABELS = { 'modele-3d': 'Modèles 3D', 'modele-ia': 'Modèles d\'IA', lora: 'LoRA', controlnet: 'ControlNet', 'image-reference': 'Style : image de référence', upscaler: 'Agrandissement', police: 'Polices', picto: 'Pictogrammes', extension: 'Extensions' };
const COMMERCIAL_LABELS = { oui: 'oui', non: 'non', 'a-verifier': 'à vérifier' };
const IMAGE_MAX = 64 * 1024 * 1024;
const images = { view: null, stamp: Date.now(), pending: null, mode: 'depot' };
const imageZone = () => images.view?.zones.find((z) => z.zone === $('il-zone').value);
const pct = (n) => Math.round(n * 1000) / 10;

function resetImages() {
  images.view = null;
  images.pending = null;
  images.stamp = Date.now();
  $('il-message').replaceChildren();
  $('il-confirmation').hidden = true;
  $('il-image').removeAttribute('src');
}

async function loadImages() {
  images.view = await action('/api/sujet/images', { dir: dirOf(), subjectId: sujets.open });
  showImages();
}

/** La vignette tient dans son cadre, au rapport de l'image. */
function fitThumb() {
  const zone = imageZone();
  const box = $('il-vignette');
  if (!zone?.image) return;
  const frame = $('il-cadre');
  const scale = Math.min((frame.clientWidth - 4) / zone.image.width, (frame.clientHeight - 4) / zone.image.height);
  box.style.width = `${zone.image.width * scale}px`;
  box.style.height = `${zone.image.height * scale}px`;
}

function showThumb(zone) {
  const box = $('il-vignette');
  box.hidden = !zone?.image;
  for (const id of ['il-zoom', 'il-x', 'il-y']) $(id).disabled = !zone?.image;
  if (!zone?.image) return;
  const query = new URLSearchParams({ dir: dirOf(), subject: sujets.open, zone: zone.zone, t: String(images.stamp) });
  const src = `/illustration?${query}`;
  if ($('il-image').getAttribute('src') !== src) $('il-image').src = src;
  const { crop, image } = zone;
  const visible = $('il-visible').style;
  visible.left = `${(crop.left / image.width) * 100}%`;
  visible.top = `${(crop.top / image.height) * 100}%`;
  visible.width = `${(crop.width / image.width) * 100}%`;
  visible.height = `${(crop.height / image.height) * 100}%`;
  fitThumb();
}

function imagePairs(zone) {
  const file = zone.image ? `${zone.image.width} × ${zone.image.height} px` : zone.fault ?? 'aucune image';
  const pairs = [['Fichier', file]];
  if (zone.ppi !== null) pairs.push(['Résolution effective', `${Math.floor(zone.ppi)} ppp`]);
  return pairs;
}

function showRightsChoice(zone) {
  const box = $('il-droits');
  const top = box.scrollTop;
  const frag = document.createDocumentFragment();
  const entries = images.view.entries;
  if (!zone.illustration) frag.append(el('p', 'Déposer d\'abord une image.', 'note'));
  else if (entries.length === 0) frag.append(el('p', 'Registre vide : ouvrir l\'étape Droits.', 'note'));
  else {
    for (const kind of Object.keys(KIND_LABELS)) {
      const group = entries.filter((e) => e.kind === kind);
      if (group.length === 0) continue;
      frag.append(el('p', KIND_LABELS[kind], 'titre-liste'));
      for (const e of group) {
        const label = el('label');
        const tick = el('input');
        tick.type = 'checkbox';
        tick.value = e.id;
        tick.checked = zone.rights?.includes(e.id) ?? false;
        const warn = e.commercialOk === 'oui' ? '' : `, usage commercial : ${COMMERCIAL_LABELS[e.commercialOk]}`;
        label.append(tick, el('span', `${e.name}, ${e.author || 'auteur inconnu'} (${e.license || 'licence manquante'}${warn})`));
        frag.append(label);
      }
    }
  }
  box.replaceChildren(frag);
  box.scrollTop = top;
}

function showImages() {
  const { view } = images;
  if (!view) return;
  const keep = $('il-zone').value;
  fillSelect($('il-zone'), view.zones.map((z) => [z.zone, z.zone]));
  if (view.zones.some((z) => z.zone === keep)) $('il-zone').value = keep;
  const zone = imageZone();
  if (!zone) return;
  $('il-cible').textContent = `Taille cible à 300 ppp : ${zone.target.width} × ${zone.target.height} px.`;
  const framing = zone.illustration?.framing ?? { focusX: 0.5, focusY: 0.5, zoom: 1 };
  $('il-zoom').value = String(framing.zoom);
  $('il-zoom-valeur').textContent = framing.zoom.toFixed(2).replace('.', ',');
  $('il-x').value = String(pct(framing.focusX));
  $('il-y').value = String(pct(framing.focusY));
  showThumb(zone);
  $('il-infos').replaceChildren(definitions(imagePairs(zone)));
  $('il-controles').replaceChildren(checksTable(view.checks));
  showRightsChoice(zone);
}

/** Écrit aussitôt : point focal et zoom ne passent par aucun bouton. */
function imageChange(path, body) {
  const id = sujets.open;
  $('il-message').replaceChildren();
  return enqueue(async () => {
    const view = await action(path, { dir: dirOf(), subjectId: id, zone: $('il-zone').value, ...body });
    if (sujets.open !== id) return;
    images.view = view;
    showImages();
    await refreshParcours();
  }, $('il-message'));
}

const currentFraming = () => ({ focusX: Number($('il-x').value) / 100, focusY: Number($('il-y').value) / 100, zoom: Number($('il-zoom').value) });
const sendFraming = (change) => imageChange('/api/sujet/cadrage', { framing: { ...currentFraming(), ...change } });

function clickThumb(event) {
  const box = $('il-image').getBoundingClientRect();
  sendFraming({ focusX: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), focusY: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) });
}

function sendRights() {
  imageChange('/api/sujet/droits-image', { rights: [...document.querySelectorAll('#il-droits input:checked')].map((b) => b.value) });
}

async function uploadImage(file, confirm) {
  const message = $('il-message');
  if (file.size > IMAGE_MAX) {
    message.replaceChildren(el('p', 'Fichier trop gros : 64 Mio au plus.', 'erreur'));
    return;
  }
  const id = sujets.open;
  const query = new URLSearchParams({ dir: dirOf(), subject: id, zone: $('il-zone').value });
  if (confirm) query.set('confirm', '1');
  message.replaceChildren(el('p', 'Dépôt en cours…', 'note'));
  const res = await fetch(`/api/sujet/illustration?${query}`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'x-book-print': '1' }, body: file });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `erreur ${res.status}`);
  if (sujets.open !== id) return;
  if (data.needsConfirm) {
    images.pending = file;
    $('il-confirmation').hidden = false;
    message.replaceChildren();
    return;
  }
  images.pending = null;
  images.stamp = Date.now();
  images.view = data;
  $('il-confirmation').hidden = true;
  showImages();
  message.replaceChildren(el('p', `Image gardée : ${data.width} × ${data.height} px, nettoyée, sans métadonnées.`, 'bien'));
  await refreshParcours();
}

const depositImage = (file, confirm = false) => enqueue(() => uploadImage(file, confirm), $('il-message'));

/** `input` : le champ fichier ; `run` reçoit le fichier choisi ou déposé. */
function dropZone(box, input, run) {
  input.addEventListener('change', () => {
    const [file] = input.files;
    if (file) run(file);
    input.value = '';
  });
  for (const name of ['dragenter', 'dragover']) {
    box.addEventListener(name, (event) => {
      event.preventDefault();
      box.classList.add('survol');
    });
  }
  box.addEventListener('dragleave', () => box.classList.remove('survol'));
  box.addEventListener('drop', (event) => {
    event.preventDefault();
    box.classList.remove('survol');
    const [file] = event.dataTransfer.files;
    if (file) run(file);
  });
}

// Droits du livre (spec §3.8)

const droits = { view: null, editing: null };

function entriesTable(entries, scope) {
  if (entries.length === 0) return el('p', 'Aucune entrée.', 'note');
  const table = el('table');
  const head = el('tr');
  for (const t of ['Nom', 'Type', 'Licence', 'Commercial', '']) head.append(el('th', t));
  table.append(head);
  for (const e of entries) {
    const row = el('tr');
    row.dataset.entry = e.id;
    const state = e.faults.length > 0 ? el('td', e.faults.join(', '), 'erreur') : el('td', COMMERCIAL_LABELS[e.commercialOk], e.commercialOk === 'oui' ? undefined : e.commercialOk === 'non' ? 'erreur' : 'alerte');
    const act = el('td');
    act.append(smallButton('Modifier', () => editEntry(e, scope)));
    row.append(el('td', e.name), el('td', KIND_LABELS[e.kind] ?? e.kind), el('td', e.license || '—'), state, act);
    table.append(row);
  }
  return table;
}

function showDroits(view) {
  droits.view = view;
  $('dr-note').textContent = view.missing.length > 0 ? `${view.missing.length} entrée${view.missing.length > 1 ? 's' : ''} par défaut absente${view.missing.length > 1 ? 's' : ''} du registre commun.` : 'Registre commun complet.';
  if (view.error) $('dr-message').replaceChildren(el('p', view.error, 'erreur'));
  fillSelect($('dr-type'), view.kinds.map((k) => [k, KIND_LABELS[k] ?? k]), $('dr-type').value || 'modele-3d');
  $('dr-t-commun').textContent = `Registre commun (${view.collection.length})`;
  $('dr-t-livre').textContent = `Registre du livre (${view.book.length})`;
  $('dr-commun').replaceChildren(entriesTable(view.collection, 'collection'));
  $('dr-livre').replaceChildren(entriesTable(view.book, 'livre'));
}

async function loadDroits() {
  if (!dirOf()) return;
  try {
    $('dr-message').replaceChildren();
    showDroits(await action('/api/droits/state', { dir: dirOf() }));
  } catch (e) {
    $('dr-message').replaceChildren(el('p', e.message, 'erreur'));
  }
}

function resetEntry() {
  droits.editing = null;
  $('dr-form').reset();
  $('dr-titre').textContent = 'Nouvelle entrée';
  $('dr-registre').disabled = false;
}

function editEntry(e, scope) {
  droits.editing = e.id;
  $('dr-titre').textContent = `Modifier ${e.id}`;
  $('dr-registre').value = scope;
  $('dr-registre').disabled = true;
  $('dr-type').value = e.kind;
  $('dr-commercial').value = e.commercialOk;
  $('dr-nom').value = e.name;
  $('dr-auteur').value = e.author;
  $('dr-licence').value = e.license;
  $('dr-url').value = e.url ?? '';
  $('dr-credit').value = e.credit;
}

async function droitsAction(path, body, done) {
  const box = $('dr-message');
  box.replaceChildren();
  try {
    const reply = await action(path, { dir: dirOf(), ...body });
    showDroits(reply);
    done(reply, box);
  } catch (e) {
    box.replaceChildren(el('p', e.message, 'erreur'));
  } finally {
    await refreshParcours();
  }
}

function saveEntry(event) {
  event.preventDefault();
  const entry = { kind: $('dr-type').value, name: $('dr-nom').value, author: $('dr-auteur').value, license: $('dr-licence').value, url: $('dr-url').value, credit: $('dr-credit').value, commercialOk: $('dr-commercial').value };
  const id = droits.editing;
  return droitsAction('/api/droits/enregistrer', { scope: $('dr-registre').value, ...(id ? { id } : {}), entry }, (reply, box) => {
    box.append(el('p', `Entrée ${reply.saved} enregistrée.`, 'bien'));
    resetEntry();
  });
}

function completeRegistry() {
  return droitsAction('/api/droits/completer', {}, ({ completed }, box) => {
    box.append(el('p', completed.added.length > 0 ? `${completed.added.length} entrées ajoutées : ${completed.added.join(', ')}.` : 'Rien à ajouter : le registre commun n\'a pas changé.', 'bien'));
  });
}

async function importCredits(file) {
  const box = $('dr-message');
  if (file.size > IMPORT_MAX) {
    box.replaceChildren(el('p', 'Fichier trop gros : 2 Mio au plus.', 'erreur'));
    return;
  }
  await droitsAction('/api/droits/credits', { content: await file.text() }, ({ imported }, target) => {
    target.append(el('p', `${imported.added.length} entrée(s) créée(s), ${imported.kept.length} conservée(s) sans modification, ${imported.originals} création(s) originale(s) ignorée(s).`, 'bien'));
    if (imported.skipped.length > 0) target.append(list('Lignes écartées', imported.skipped, 'alerte'));
  });
}

// ComfyUI (IC1) : état, file d'attente dans le bandeau, étape Workflows, vue « Générer » de l'étape Illustrations. La file vit dans le serveur :
// la page l'interroge toutes les 2 s tant qu'une tâche tourne ou attend, et seulement alors.

const COMFY_POLL_MS = 2000;
const OUTCOME_LABELS = { reussie: 'réussie', echouee: 'échouée', annulee: 'annulée' };
const comfy = { queue: null, server: null, address: null, launcher: null, starting: false, timer: null, startTimer: null, lastDone: undefined };
/** Après « Lancer ComfyUI » : une vérification toutes les 3 s, 3 minutes au plus. */
const START_POLL_MS = 3000;
const START_POLL_MAX = 60;

function queueLine() {
  const q = comfy.queue;
  if (!q) return null;
  const waiting = q.pending.length > 0 ? ` ; ${q.pending.length} en attente` : '';
  if (q.current) return { text: `ComfyUI : ${q.current.label}, ${q.current.step}${waiting}`, error: false };
  if (q.pending.length > 0) return { text: `ComfyUI : ${q.pending.length} tâche${q.pending.length > 1 ? 's' : ''} en attente`, error: false };
  const [last] = q.recent;
  if (last) return { text: `Dernière tâche : ${last.label}, ${OUTCOME_LABELS[last.outcome]}${last.outcome === 'echouee' ? ` : ${last.message}` : ''}`, error: last.outcome === 'echouee' };
  return null;
}

function showQueueLine() {
  const line = queueLine();
  const box = $('file-comfy');
  box.hidden = !line;
  box.textContent = line?.text ?? '';
  box.title = line?.text ?? '';
  box.classList.toggle('erreur', !!line?.error);
}

function comfyText() {
  if (comfy.address && !comfy.address.ok) return { text: comfy.address.error, className: 'erreur' };
  if (!comfy.server) return { text: `ComfyUI : ${comfy.address?.url ?? ''}, état non vérifié.`, className: 'note' };
  if (comfy.server.ok) return { text: `ComfyUI ${comfy.server.version} répond à ${comfy.address.url}.`, className: 'bien' };
  if (comfy.starting) return { text: 'ComfyUI démarre dans sa fenêtre : la page vérifie toutes les 3 s.', className: 'note' };
  if (comfy.launcher?.state === 'refuse') return { text: `${comfy.server.error} ${comfy.launcher.message}`, className: 'erreur' };
  if (comfy.launcher?.state === 'absent') return { text: `${comfy.server.error} Pour un bouton de lancement : ajouter "comfyLauncher" dans config.local.json.`, className: 'erreur' };
  return { text: comfy.server.error, className: 'erreur' };
}

function showComfyState() {
  const { text, className } = comfyText();
  for (const id of ['wf-comfy', 'ge-comfy']) {
    $(id).textContent = text;
    $(id).className = className;
  }
  const canLaunch = comfy.server?.ok === false && comfy.launcher?.state === 'ok' && comfy.address?.ok;
  for (const id of ['wf-lancer', 'ge-lancer-comfy']) {
    $(id).hidden = !canLaunch;
    $(id).disabled = comfy.starting;
  }
}

/** « Lancer ComfyUI » : le serveur ouvre le lanceur de config.local.json, la page attend que ComfyUI réponde. */
async function launchComfy() {
  try {
    await action('/api/comfy/lancer', {});
  } catch (e) {
    for (const id of ['wf-comfy', 'ge-comfy']) {
      $(id).textContent = e.message;
      $(id).className = 'erreur';
    }
    return;
  }
  comfy.starting = true;
  showComfyState();
  let tries = 0;
  clearTimeout(comfy.startTimer);
  const wait = async () => {
    await pollComfy(true);
    if (comfy.server?.ok || ++tries >= START_POLL_MAX) {
      comfy.starting = false;
      showComfyState();
      return;
    }
    comfy.startTimer = setTimeout(wait, START_POLL_MS);
  };
  comfy.startTimer = setTimeout(wait, START_POLL_MS);
}

/** Une tâche vient de finir : ce qu'elle a écrit se relit, et son résultat s'affiche dans la vue « Générer ». */
async function taskDone(done) {
  const box = $('ge-message');
  const classes = { reussie: 'bien', echouee: 'erreur', annulee: 'note' };
  const s = Math.round(done.seconds);
  box.replaceChildren(el('p', `${done.label} : ${OUTCOME_LABELS[done.outcome]} en ${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s. ${done.message}`, classes[done.outcome]));
  if (done.kind === 'agrandissement') images.stamp = Date.now();
  if (sujets.open && sujets.step === 'sujet-illustrations') {
    await enqueue(loadImages, $('il-message'));
    if (images.mode === 'generer') await enqueue(loadGenerate, $('ge-message'));
  }
  await refreshParcours();
}

/** `ping` : demande aussi `/system_stats` à ComfyUI. Sinon, seule la file du serveur est lue. */
async function pollComfy(ping = false) {
  clearTimeout(comfy.timer);
  let state;
  try {
    state = await action('/api/comfy/state', { ping });
  } catch {
    // Configuration à corriger : l'étape Livre le dit déjà, la ligne de la file reste cachée.
    $('file-comfy').hidden = true;
    return;
  }
  comfy.queue = state.queue;
  comfy.address = state.address;
  comfy.launcher = state.launcher;
  if (state.server) comfy.server = state.server;
  const last = state.queue.recent[0]?.id ?? null;
  const first = comfy.lastDone === undefined;
  const finished = !first && last !== comfy.lastDone ? state.queue.recent[0] : null;
  comfy.lastDone = last;
  showQueueLine();
  showComfyState();
  if (images.mode === 'generer') showGenerate();
  if (finished) await taskDone(finished);
  if (state.queue.current || state.queue.pending.length > 0) comfy.timer = setTimeout(() => pollComfy(false), COMFY_POLL_MS);
}

// Étape Workflows

const workflowsUi = { view: null };
const WF_KINDS = ['generation', 'agrandissement'];

function workflowInfo(kind, w, checked) {
  if (w.state === 'absent') return [el('p', 'Aucun workflow déposé.', 'note')];
  if (w.state === 'refuse') return [el('p', w.message, 'erreur')];
  const out = [definitions([['Fichier', w.file], ['Déposé le', new Date(w.date).toLocaleString('fr-FR')], ['Empreinte', `${w.sha256.slice(0, 16)}…`], ['Nœuds contrôlés', checked[kind].join(', ')]])];
  for (const f of w.rightsFaults) out.push(el('p', f, 'erreur'));
  if (w.rights.length === 0) out.push(el('p', 'Cocher au moins un droit.', 'alerte'));
  return out;
}

function workflowRights(kind, w, entries) {
  const box = $(`wf-droits-${kind}`);
  const top = box.scrollTop;
  const frag = document.createDocumentFragment();
  if (w.state !== 'ok') frag.append(el('p', 'Déposer d\'abord le workflow.', 'note'));
  else {
    for (const k of ['modele-ia', 'controlnet', 'upscaler', 'image-reference']) {
      const group = entries.filter((e) => e.kind === k);
      if (group.length === 0) continue;
      frag.append(el('p', KIND_LABELS[k], 'titre-liste'));
      for (const e of group) {
        const label = el('label');
        const tick = el('input');
        tick.type = 'checkbox';
        tick.value = e.id;
        tick.checked = w.rights.includes(e.id);
        tick.addEventListener('change', () => sendWorkflowRights(kind));
        const warn = e.commercialOk === 'oui' ? '' : `, usage commercial : ${COMMERCIAL_LABELS[e.commercialOk]}`;
        label.append(tick, el('span', `${e.name}, ${e.author || 'auteur inconnu'} (${e.license || 'licence manquante'}${warn})`));
        frag.append(label);
      }
    }
  }
  box.replaceChildren(frag);
  box.scrollTop = top;
}

function showWorkflows(view) {
  workflowsUi.view = view;
  for (const kind of WF_KINDS) {
    $(`wf-info-${kind}`).replaceChildren(...workflowInfo(kind, view.kinds[kind], view.checked));
    workflowRights(kind, view.kinds[kind], view.entries);
  }
}

async function workflowsAction(path, body, done) {
  const box = $('wf-message');
  box.replaceChildren();
  try {
    const reply = await action(path, { dir: dirOf(), ...body });
    showWorkflows(reply);
    done?.(reply, box);
  } catch (e) {
    box.replaceChildren(el('p', e.message, 'erreur'));
  } finally {
    await refreshParcours();
  }
}

async function loadWorkflows() {
  if (!dirOf()) return;
  $('wf-message').replaceChildren();
  try {
    showWorkflows(await action('/api/workflows/state', { dir: dirOf() }));
  } catch (e) {
    $('wf-message').replaceChildren(el('p', e.message, 'erreur'));
  }
  await pollComfy(true);
}

function sendWorkflowRights(kind) {
  const rights = [...document.querySelectorAll(`#wf-droits-${kind} input:checked`)].map((b) => b.value);
  return workflowsAction('/api/workflows/droits', { kind, rights });
}

async function depositWorkflow(kind, file) {
  if (file.size > IMPORT_MAX) {
    $('wf-message').replaceChildren(el('p', 'Fichier trop gros : 2 Mio au plus.', 'erreur'));
    return;
  }
  await workflowsAction('/api/workflows/depot', { kind, content: await file.text() }, ({ deposited }, box) => {
    box.append(el('p', `Workflow de ${deposited.label} rangé : ${deposited.entry.file}${deposited.previous ? `, à la place de ${deposited.previous}, gardé` : ''}.`, 'bien'));
  });
}

// Vue « Générer » de l'étape Illustrations

const gen = { view: null, confirmSeed: null };
const genZone = () => gen.view?.zones.find((z) => z.zone === $('il-zone').value);

function resetGenerate() {
  gen.view = null;
  gen.confirmSeed = null;
  $('ge-message').replaceChildren();
  $('ge-confirmation').hidden = true;
  $('ge-candidats').replaceChildren();
}

function showImageMode(mode) {
  images.mode = mode;
  $('il-vue-depot').hidden = mode !== 'depot';
  $('il-vue-generer').hidden = mode !== 'generer';
  $('v-depot').setAttribute('aria-pressed', String(mode === 'depot'));
  $('v-generer').setAttribute('aria-pressed', String(mode === 'generer'));
  if (mode === 'generer') {
    enqueue(loadGenerate, $('ge-message'));
    pollComfy(true);
  } else fitThumb();
}

async function loadGenerate() {
  gen.view = await action('/api/generer/state', { dir: dirOf(), subjectId: sujets.open });
  showGenerate();
}

function inputState(input) {
  if (input.state === 'ok') return [`✓ ${input.size.width} × ${input.size.height} px`, 'bien'];
  if (input.state === 'absent') return ['à déposer', 'note'];
  return [input.message, 'erreur'];
}

/** Tâches de la zone ouverte : `zoneKey` vaut `<bookId>/<sujetId>/<zone>`. */
function zoneTasks(zone) {
  const all = comfy.queue ? [...(comfy.queue.current ? [{ ...comfy.queue.current, running: true }] : []), ...comfy.queue.pending] : [];
  return all.filter((t) => t.zoneKey.endsWith(`/${sujets.open}/${zone.zone}`));
}

function showTasks(zone) {
  const box = $('ge-file');
  box.replaceChildren(...zoneTasks(zone).map((t) => {
    const p = el('p');
    p.append(el('span', t.running ? `En cours : ${t.label}, ${t.step}` : `En attente : ${t.label}`));
    if (!t.sent) p.append(smallButton('Annuler', () => cancelTask(t.id)));
    return p;
  }));
}

function candidateCard(zone, seed, ready) {
  const card = el('div', undefined, 'candidat');
  card.dataset.seed = String(seed);
  const img = el('img');
  img.alt = `Candidat de graine ${seed}, couleurs corrigées`;
  img.src = `/candidat?${new URLSearchParams({ dir: dirOf(), subject: sujets.open, zone: zone.zone, seed: String(seed), t: zone.candidates.date })}`;
  const go = el('button', 'Agrandir');
  go.type = 'button';
  go.disabled = !ready || zone.busy.includes('agrandissement');
  go.addEventListener('click', () => askUpscale(seed, false));
  card.append(img, el('p', `Graine ${seed}`), go);
  return card;
}

function showGenerate() {
  const zone = genZone();
  if (!gen.view || !zone) return;
  const motifs = [...(gen.view.workflows.ready ? [] : gen.view.workflows.reasons.map((r) => [r, 'alerte'])), ...(zone.reason ? [[zone.reason, 'erreur']] : [])];
  $('ge-motifs').replaceChildren(...motifs.map(([r, c]) => el('p', r, c)));
  $('ge-attendu').textContent = zone.render
    ? `Rendu et passe Mist en ${zone.render.width} × ${zone.render.height} px (${zone.kindLabel}), gardés sous ${zone.inputs.rendu.name} et ${zone.inputs.mist.name}. L'animal doit faire au moins 300 px de haut : l'outil ne peut pas le vérifier. Image finale : ${zone.output.width} × ${zone.output.height} px.`
    : '';
  for (const k of ['rendu', 'mist']) {
    const [text, className] = inputState(zone.inputs[k]);
    $(`ge-etat-${k}`).textContent = text;
    $(`ge-etat-${k}`).className = className;
  }
  if (document.activeElement !== $('ge-prompt')) $('ge-prompt').value = zone.prompt;
  $('ge-couleurs').textContent = zone.colors.length > 0 ? `Couleur nommée dans le prompt : ${zone.colors.join(', ')}. Les couleurs viennent du rendu 3D (§13.2).` : '';
  const ready = gen.view.workflows.ready && !zone.reason;
  $('ge-lancer').disabled = !ready || zone.inputs.rendu.state !== 'ok' || zone.inputs.mist.state !== 'ok' || zone.busy.includes('generation');
  for (const id of ['ge-fichier-rendu', 'ge-fichier-mist']) $(id).disabled = !!zone.reason || zone.busy.includes('generation');
  const seeds = zone.candidates?.seeds ?? [];
  $('ge-t-candidats').textContent = seeds.length > 0 ? `Candidats, couleurs corrigées (${new Date(zone.candidates.date).toLocaleString('fr-FR')})` : 'Candidats : aucun pour l\'instant.';
  const shown = [...$('ge-candidats').children].map((c) => `${c.dataset.seed}:${c.querySelector('button').disabled}`).join();
  const wanted = seeds.map((s) => `${s}:${!ready || zone.busy.includes('agrandissement')}`).join();
  if (shown !== wanted) $('ge-candidats').replaceChildren(...seeds.map((s) => candidateCard(zone, s, ready)));
  showTasks(zone);
}

function generateChange(path, body) {
  const id = sujets.open;
  $('ge-message').replaceChildren();
  return enqueue(async () => {
    const reply = await action(path, { dir: dirOf(), subjectId: id, zone: $('il-zone').value, ...body });
    if (sujets.open !== id) return;
    if (reply.needsConfirm) {
      $('ge-confirmation').hidden = false;
      return;
    }
    gen.view = reply;
    $('ge-confirmation').hidden = true;
    showGenerate();
    if (reply.task) {
      $('ge-message').replaceChildren(el('p', `Dans la file : ${reply.task.label}.`, 'note'));
      await pollComfy(false);
    }
  }, $('ge-message'));
}

function askUpscale(seed, confirm) {
  gen.confirmSeed = seed;
  return generateChange('/api/generer/agrandir', { seed, ...(confirm ? { confirm: true } : {}) });
}

async function cancelTask(id) {
  try {
    await action('/api/comfy/annuler', { id });
  } catch (e) {
    $('ge-message').replaceChildren(el('p', e.message, 'erreur'));
  }
  await pollComfy(false);
}

async function uploadEntry(kind, file) {
  const message = $('ge-message');
  if (file.size > IMAGE_MAX) {
    message.replaceChildren(el('p', 'Fichier trop gros : 64 Mio au plus.', 'erreur'));
    return;
  }
  const id = sujets.open;
  const query = new URLSearchParams({ dir: dirOf(), subject: id, zone: $('il-zone').value, kind });
  message.replaceChildren(el('p', 'Dépôt en cours…', 'note'));
  const res = await fetch(`/api/sujet/entree?${query}`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'x-book-print': '1' }, body: file });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `erreur ${res.status}`);
  if (sujets.open !== id) return;
  gen.view = data;
  showGenerate();
  message.replaceChildren(el('p', `${kind === 'rendu' ? 'Rendu' : 'Passe Mist'} gardé : ${data.deposited.size.width} × ${data.deposited.size.height} px.`, 'bien'));
}

async function start() {
  pollComfy(false);
  const { config, books } = await action('/api/state');
  showConfig(config);
  if (!config.ok) return refreshParcours({ reopen: true });
  const select = $('choix');
  select.replaceChildren();
  if (books.length === 0) {
    $('lecture').replaceChildren(el('p', 'Aucun livre trouvé dans books/.', 'alerte'));
    return refreshParcours({ reopen: true });
  }
  for (const b of books) {
    const label = b.error ? `${b.dir} (illisible)` : `${b.dir}${b.built ? ' (dernier build)' : ''}`;
    const option = el('option', label);
    option.value = b.dir;
    select.append(option);
  }
  const built = books.find((b) => b.built);
  if (built) select.value = built.dir;
  select.disabled = false;
  await readSelected();
}

$('choix').addEventListener('change', () => {
  readSelected().catch((e) => $('lecture').replaceChildren(el('p', e.message, 'erreur')));
});
$('creer').addEventListener('click', createFolder);
$('prix-form').addEventListener('submit', saveCurrent);
$('prix-form').addEventListener('input', computeSoon);
$('prix-form').addEventListener('change', computeSoon);
$('p-reliure').addEventListener('change', () => fillTrims($('p-format').value));
$('p-mode').addEventListener('change', showPageFields);
$('p-nouveau').addEventListener('click', () => {
  resetForm();
  computeNow();
});
$('v-simulateur').addEventListener('click', () => showPricingView('simulateur'));
$('v-scenarios').addEventListener('click', () => showPricingView('scenarios'));
$('collection-creer').addEventListener('click', createCollection);
$('collection-relire').addEventListener('click', reloadEssai);
$('essai-exporter').addEventListener('click', exportEssai);
$('essai-recharger').addEventListener('click', reloadEssai);
$('essai-theme').addEventListener('change', loadPreview);
for (const box of document.querySelectorAll('input[data-layer]')) box.addEventListener('change', () => showLayers(essaiView));
for (const box of document.querySelectorAll('input[data-sujet-layer]')) box.addEventListener('change', () => showLayers(sujetView));
new ResizeObserver(() => fitPreview(essaiView)).observe($('apercu-cadre'));
new ResizeObserver(() => fitPreview(sujetView)).observe($('sa-cadre'));
$('sujet-form').addEventListener('submit', createSubject);
$('s-pages').addEventListener('input', fillTemplates);
$('sujet-retour').addEventListener('click', async () => {
  closeSubject();
  await refreshParcours();
  await loadSujets();
});
$('r-preparer').addEventListener('click', preparePrompt);
$('r-fichier').addEventListener('change', () => {
  const [file] = $('r-fichier').files;
  if (file) importFile(file);
});
for (const name of ['dragenter', 'dragover']) {
  $('r-depot').addEventListener(name, (event) => {
    event.preventDefault();
    $('r-depot').classList.add('survol');
  });
}
$('r-depot').addEventListener('dragleave', () => $('r-depot').classList.remove('survol'));
$('r-depot').addEventListener('drop', (event) => {
  event.preventDefault();
  $('r-depot').classList.remove('survol');
  const [file] = event.dataTransfer.files;
  if (file) importFile(file);
});
$('r-remplacer').addEventListener('click', confirmImport);
$('r-annuler').addEventListener('click', () => {
  sujets.pending = null;
  $('r-confirmation').hidden = true;
});
$('rl-urls').addEventListener('click', checkUrlsNow);
$('rl-titre').addEventListener('change', () => subjectChange('/api/sujet/fields', { title: $('rl-titre').value === '' ? null : $('rl-titre').value }));
$('rl-legende').addEventListener('change', () => subjectChange('/api/sujet/fields', { legend: $('rl-legende').value }));
$('sa-theme').addEventListener('change', async () => {
  await subjectChange('/api/sujet/fields', { theme: $('sa-theme').value });
  loadSubjectPreview();
});
$('sa-recharger').addEventListener('click', async () => {
  await enqueue(loadSubject, $('sa-resultat'));
  loadSubjectPreview();
});
$('il-zone').addEventListener('change', () => {
  showImages();
  showGenerate();
});
$('v-depot').addEventListener('click', () => showImageMode('depot'));
$('v-generer').addEventListener('click', () => showImageMode('generer'));
$('ge-lancer').addEventListener('click', () => generateChange('/api/generer/lancer', {}));
$('ge-prompt').addEventListener('change', () => generateChange('/api/generer/prompt', { text: $('ge-prompt').value }));
$('ge-remplacer').addEventListener('click', () => askUpscale(gen.confirmSeed, true));
$('ge-annuler').addEventListener('click', () => {
  $('ge-confirmation').hidden = true;
  gen.confirmSeed = null;
});
for (const kind of ['rendu', 'mist']) dropZone($(`ge-depot-${kind}`), $(`ge-fichier-${kind}`), (file) => enqueue(() => uploadEntry(kind, file), $('ge-message')));
for (const kind of WF_KINDS) dropZone($(`wf-depot-${kind}`), $(`wf-fichier-${kind}`), (file) => depositWorkflow(kind, file));
$('wf-verifier').addEventListener('click', () => pollComfy(true));
$('wf-lancer').addEventListener('click', launchComfy);
$('ge-lancer-comfy').addEventListener('click', launchComfy);
dropZone($('il-depot'), $('il-fichier'), (file) => depositImage(file));
$('il-remplacer').addEventListener('click', () => {
  $('il-confirmation').hidden = true;
  if (images.pending) depositImage(images.pending, true);
});
$('il-annuler').addEventListener('click', () => {
  images.pending = null;
  $('il-confirmation').hidden = true;
});
$('il-image').addEventListener('click', clickThumb);
$('il-image').addEventListener('load', fitThumb);
$('il-zoom').addEventListener('input', () => { $('il-zoom-valeur').textContent = Number($('il-zoom').value).toFixed(2).replace('.', ','); });
$('il-zoom').addEventListener('change', () => sendFraming({}));
$('il-x').addEventListener('change', () => sendFraming({}));
$('il-y').addEventListener('change', () => sendFraming({}));
$('il-droits').addEventListener('change', sendRights);
new ResizeObserver(fitThumb).observe($('il-cadre'));
$('dr-completer').addEventListener('click', completeRegistry);
dropZone($('dr-depot'), $('dr-fichier'), importCredits);
$('dr-form').addEventListener('submit', saveEntry);
$('dr-nouvelle').addEventListener('click', resetEntry);
$('sa-controler').addEventListener('click', () => controlNow(false));
$('sa-relu').addEventListener('click', () => controlNow(true));
start().catch((e) => $('config').replaceChildren(el('p', e.message, 'erreur')));
