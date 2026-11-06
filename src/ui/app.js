// src/ui/app.js — page locale de book-print : état de la configuration, livre lu, alertes, création du dossier (MP1), simulateur de prix (PX1), essai du gabarit 2A (MP2).
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
  $('creation').replaceChildren();
  $('donnees').hidden = true;
  $('prix').hidden = true;
  $('essai').hidden = true;
  if (!dir) return;
  const { reading } = await action('/api/read', { dir });
  box.append(
    definitions([
      ['Titre', reading.title?.fr ?? '—'],
      ['bookId', reading.bookId ?? '—'],
      ['origin', reading.origin ?? '—'],
      ['Scènes', String(reading.scenes.length)],
      ['QR du jeu', reading.gameQr?.file ?? 'aucun'],
    ]),
    list(`Erreurs (${reading.errors.length})`, reading.errors, 'erreur'),
    list(`Alertes (${reading.alerts.length})`, reading.alerts, 'alerte'),
  );
  if (reading.errors.length === 0 && reading.alerts.length === 0) box.append(el('p', 'Aucune erreur ni alerte.', 'bien'));
  if (reading.scenes.length > 0) box.append(scenesTable(reading.scenes));
  $('donnees').hidden = false;
  $('creer').disabled = reading.errors.length > 0 || !reading.bookId;
  if ($('creer').disabled) $('creation').append(el('p', 'Création impossible tant que la lecture est en erreur.', 'alerte'));
  if (reading.bookId) {
    await openPricing(reading.bookId);
    await openEssai(reading.bookId);
  }
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

const pricing = { bookId: null, catalog: null, editId: null, scenarios: [], timer: null, turn: 0 };

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

function showResult(result) {
  $('prix-resultat').replaceChildren(
    definitions(resultPairs(result)),
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
    if (turn === pricing.turn) $('prix-resultat').replaceChildren(el('p', e.message, 'erreur'));
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
      $('prix-form').scrollIntoView({ block: 'start' });
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
  $('prix').hidden = false;
  $('prix-message').replaceChildren();
  try {
    const view = await action('/api/pricing/state', { bookId });
    pricing.catalog = view.catalog;
    setupForm(view.catalog);
    $('prix-form').hidden = !view.folder;
    if (!view.folder) $('prix-message').append(el('p', 'Créer le dossier du livre pour enregistrer des scénarios.', 'alerte'));
    showPricing(view);
    if (view.folder) await computeNow();
  } catch (e) {
    $('prix-form').hidden = true;
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

const essai = { bookId: null, layout: null };
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

function drawMarks() {
  const width = essai.layout.reduce((sum, p) => sum + p.widthMm, 0);
  const height = essai.layout[0].heightMm;
  const svg = $('reperes');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();
  const layers = {};
  for (const name of ['bleed', 'safe', 'fold', 'zones']) {
    layers[name] = svgEl('g', { 'data-layer': name });
    svg.append(layers[name]);
  }
  let x = 0;
  for (const page of essai.layout) {
    drawPageMarks(layers, page, x);
    x += page.widthMm;
  }
  showLayers();
  fitPreview();
}

function showLayers() {
  for (const box of document.querySelectorAll('input[data-layer]')) {
    const layer = $('reperes').querySelector(`g[data-layer="${box.dataset.layer}"]`);
    if (layer) layer.setAttribute('display', box.checked ? 'inline' : 'none');
  }
}

/** Double page à taille réelle réduite à la largeur disponible. Le PDF, lui, se juge à 100 %. */
function fitPreview() {
  if (!essai.layout) return;
  const width = essai.layout.reduce((sum, p) => sum + p.widthMm, 0) * PX_PER_MM;
  const height = essai.layout[0].heightMm * PX_PER_MM;
  const scale = Math.min(1, $('apercu-cadre').clientWidth / width);
  const inner = $('apercu-echelle');
  inner.style.width = `${width}px`;
  inner.style.height = `${height}px`;
  inner.style.transform = `scale(${scale})`;
  $('apercu-cadre').style.height = `${height * scale}px`;
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
  const SIGNS = { ok: ['✓', 'contrôle réussi'], alerte: ['⚠', 'alerte'], erreur: ['✗', 'erreur'] };
  const CLASSES = { ok: 'bien', alerte: 'alerte', erreur: 'erreur' };
  for (const c of checks) {
    const row = el('tr');
    const verdict = el('td');
    const [sign, meaning] = SIGNS[c.level];
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
    definitions([
      ['Fichier', r.file],
      ['Taille demandée', `${String(r.pageSizeIn.widthIn).replace('.', ',')} × ${String(r.pageSizeIn.heightIn).replace('.', ',')} "`],
      ['Pages relues dans le PDF', size],
      ['Polices relues dans le PDF', r.fonts.map((f) => `${f.name} (${f.how})`).join(' ; ')],
      ['Poids', `${(r.sizeBytes / 1e6).toFixed(2).replace('.', ',')} Mo`],
      ['Chromium', r.chromium],
    ]),
    checksTable(r.checks),
  );
}

async function openEssai(bookId) {
  essai.bookId = bookId;
  $('essai').hidden = false;
  $('essai-zone').hidden = true;
  $('essai-resultat').replaceChildren();
  const box = $('essai-message');
  box.replaceChildren();
  try {
    const state = await action('/api/essai/state', { bookId });
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
    essai.layout = state.layout;
    $('essai-zone').hidden = false;
    drawMarks();
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
  }
}

async function start() {
  const { config, books } = await action('/api/state');
  showConfig(config);
  if (!config.ok) return;
  $('livre').hidden = false;
  const select = $('choix');
  select.replaceChildren();
  if (books.length === 0) {
    $('lecture').replaceChildren(el('p', 'Aucun livre trouvé dans books/.', 'alerte'));
    return;
  }
  for (const b of books) {
    const label = b.error ? `${b.dir} (illisible)` : `${b.dir}${b.built ? ' (dernier build)' : ''}`;
    const option = el('option', label);
    option.value = b.dir;
    select.append(option);
  }
  const built = books.find((b) => b.built);
  if (built) select.value = built.dir;
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
$('collection-creer').addEventListener('click', createCollection);
$('essai-exporter').addEventListener('click', exportEssai);
$('essai-recharger').addEventListener('click', () => openEssai(essai.bookId));
$('essai-theme').addEventListener('change', loadPreview);
for (const box of document.querySelectorAll('input[data-layer]')) box.addEventListener('change', showLayers);
window.addEventListener('resize', fitPreview);
start().catch((e) => $('config').replaceChildren(el('p', e.message, 'erreur')));
