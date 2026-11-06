// scripts/test-ui.ts — la page dans un vrai Chromium (spec §5.3) : parcours de bout en bout, export réel, puis « sans défilement » à chaque
// étape et aux deux tailles retenues. La page n'a aucun `overflow: hidden` à la racine : un contenu trop grand se voit ici. Les listes
// très longues sont injectées dans les réponses du serveur, pour ne pas fabriquer un livre défectueux.
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium, type Page, type Route } from 'playwright';
import { createPrintServer } from '../src/server/app';
import { BOOK_ID, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { check, finish } from './test-lib';

const SIZES = [{ width: 1920, height: 950 }, { width: 1366, height: 650 }];
const STEP_IDS = ['livre', 'prix', 'collection', 'essai'];

const glbRoot = makeGlbi();
const parent = tempDir();
const dataRoot = path.join(parent, 'donnees');
fs.mkdirSync(dataRoot);
put(parent, 'config.local.json', { glbRoot, dataRoot });
const server = createPrintServer(path.join(parent, 'config.local.json'));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: SIZES[1]! });
const pageErrors: string[] = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

/** `page.waitForFunction` passe par `eval`, que la CSP de la page refuse : c'est elle qu'on veut tester, on interroge donc de l'extérieur. */
async function until(expression: string): Promise<void> {
  const limit = Date.now() + 60_000;
  while (!(await page.evaluate(expression))) {
    if (Date.now() > limit) throw new Error(`attente trop longue : ${expression}`);
    await page.waitForTimeout(25);
  }
}

const tabs = () => page.evaluate(`[...document.querySelectorAll('#etapes li')].map((li) => ({
  id: li.querySelector('button').dataset.step,
  state: li.dataset.state,
  sign: li.querySelector('.nom-signe').getAttribute('aria-label'),
  text: li.textContent,
  current: li.querySelector('button').getAttribute('aria-current'),
}))`) as Promise<{ id: string; state: string; sign: string; text: string; current: string | null }[]>;
const tab = async (id: string) => (await tabs()).find((t) => t.id === id)!;
const current = async () => (await tabs()).find((t) => t.current === 'step')?.id;
const open = async () => {
  await page.goto(url);
  await page.waitForSelector('#etapes li');
  await until(`document.querySelector('#choix').value !== ''`);
};
const text = async (selector: string) => (await page.textContent(selector)) ?? '';
const go = (id: string) => page.click(`#etapes button[data-step="${id}"]`);
const untilTab = (id: string, sign: string) => until(`document.querySelector('#etapes button[data-step="${id}"] .nom-signe')?.getAttribute('aria-label') === '${sign}'`);
const exportPdf = async () => {
  await page.click('#essai-exporter');
  await until(`!document.querySelector('#essai-exporter').disabled && document.querySelector('#essai-resultat table') !== null`);
};
const statesText = async () => (await tabs()).map((t) => t.sign).join();

// Parcours de bout en bout, sur le dossier de données vide
await open();
{
  const all = await tabs();
  check('menu : quatre étapes numérotées, dans l’ordre', all.map((t) => t.id).join() === STEP_IDS.join() && all.every((t, i) => t.text.startsWith(String(i + 1))), all);
  check('ouverture : première étape non validée', (await current()) === 'livre');
  check('départ : Livre à faire, le reste verrouillé', (await statesText()) === 'à faire,verrouillée,verrouillée,verrouillée', await statesText());
  check('étape verrouillée : motif lisible sur l’onglet', (await tab('essai')).text.includes('Valider d\'abord « Livre »'), await tab('essai'));
  await page.click('#etapes button[data-step="essai"]', { force: true });
  check('étape verrouillée : ne s’ouvre pas', (await current()) === 'livre' && await page.isHidden('#essai'));
  check('un seul panneau affiché', (await page.locator('.panneau:visible').count()) === 1);
  check('motif de l’étape ouverte affiché', (await text('#motifs')).includes('Créer le dossier'));
  await page.evaluate('window.sansRecharge = true');

  await page.click('#creer');
  await untilTab('livre', 'validée');
  check('création du dossier : le menu change', (await tab('prix')).sign === 'à faire' && (await current()) === 'livre');
  await go('prix');
  check('Prix s’ouvre, Livre reste accessible', (await current()) === 'prix' && await page.isVisible('#prix-form'));
  await page.fill('#p-nom', 'Essai');
  await page.selectOption('#p-mode', 'saisi');
  await page.fill('#p-pages', '46');
  await page.click('#p-enregistrer');
  await page.click('#v-scenarios');
  await page.waitForSelector('#prix-scenarios table');
  check('vue des scénarios : compte à jour', (await text('#v-scenarios')).includes('(1)'));
  check('scénario enregistré, non retenu : Prix à faire', (await tab('prix')).sign === 'à faire');
  await page.click('#prix-scenarios button:has-text("Retenir")');
  await untilTab('prix', 'validée');
  check('scénario retenu : Collection s’ouvre', (await tab('collection')).sign === 'à faire' && (await tab('essai')).sign === 'verrouillée');
  await page.click('#prix-scenarios button:has-text("Modifier")');
  check('Modifier revient au formulaire', await page.isVisible('#prix-form') && (await page.inputValue('#p-nom')) === 'Essai');
  await page.click('#p-nouveau');
  await go('collection');
  await page.click('#collection-creer');
  await untilTab('collection', 'validée');
  check('collection créée : résultat et état du style', (await text('#collection-resultat')).includes('collection/style.json') && (await text('#collection-etat')).includes('foret'));
  await go('essai');
  await until(`document.querySelector('#apercu').src.includes('/apercu?')`);
  await exportPdf();
  await untilTab('essai', 'validée');
  check('export au vert : Essai validé', (await tab('essai')).state === 'validee');
  const control = JSON.parse(fs.readFileSync(path.join(dataRoot, BOOK_ID, 'export', 'essai-2A.controle.json'), 'utf8'));
  check('export : résultat conservé hors du PDF', control.bookId === BOOK_ID && Array.isArray(control.checks) && control.checks.every((c: { level: string }) => c.level === 'ok') && !Number.isNaN(Date.parse(control.date)), control);

  const style = path.join(dataRoot, 'collection', 'style.json');
  const now = new Date();
  fs.utimesSync(style, now, now);
  await page.click('#essai-recharger');
  await untilTab('essai', 'à refaire');
  check('style.json modifié : à refaire après « Recharger l’aperçu »', (await text('#motifs')).includes('style.json') && (await tab('essai')).state === 'a-faire');
  await exportPdf();
  await untilTab('essai', 'validée');
  check('nouvel export : Essai de nouveau validé', (await tab('essai')).state === 'validee');
  check('aucun rechargement de page pendant le parcours', (await page.evaluate('window.sansRecharge')) === true);

  await page.check('#r-fold');
  check('repères : le calque s’affiche', (await page.getAttribute('#reperes g[data-layer="fold"]', 'display')) === 'inline');
  await page.selectOption('#essai-theme', 'ocean');
  check('thème : l’aperçu suit', ((await page.getAttribute('#apercu', 'src')) ?? '').includes('theme=ocean'));

  await page.reload();
  await page.waitForSelector('#etapes li');
  await until(`document.querySelector('#etapes li[data-state="validee"]') !== null`);
  check('tout validé : ouverture sur la dernière étape', (await current()) === 'essai');

  await go('prix');
  await page.click('#v-scenarios');
  await page.click('#prix-scenarios button:has-text("Ne plus retenir")');
  await untilTab('essai', 'verrouillée');
  check('étape redevenue non validée : la suite se reverrouille', (await statesText()) === 'validée,à faire,verrouillée,verrouillée', await statesText());
  check('reverrouillage : aucune donnée perdue', fs.existsSync(style) && fs.existsSync(path.join(dataRoot, BOOK_ID, 'export', 'essai-2A.pdf')));
  await page.reload();
  await until(`document.querySelector('#etapes li[data-state="a-faire"]') !== null`);
  check('réouverture : première étape non validée, sans mémoire d’onglet', (await current()) === 'prix');
  await page.click('#v-scenarios');
  await page.click('#prix-scenarios button:has-text("Retenir")');
  await untilTab('essai', 'validée');
  check('scénario de nouveau retenu : le parcours revient', (await statesText()) === 'validée,validée,validée,validée', await statesText());
}

// Sans défilement. Chaque boîte qui ne porte pas une liste doit contenir ce qu'elle affiche, et chaque commande doit tenir dans la fenêtre.
const FIT = `(() => {
  const root = document.documentElement;
  const seen = (e) => e.getClientRects().length > 0;
  const frames = '.liste, .defile';
  const off = [];
  for (const e of document.querySelectorAll('button, select, input, label, h2, dt, dd, fieldset, #apercu-cadre')) {
    if (!seen(e) || e.closest(frames) || e.closest('#apercu-echelle')) continue;
    const r = e.getBoundingClientRect();
    if (r.top < -0.5 || r.left < -0.5 || r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5) off.push(e.id || e.tagName + ' ' + e.textContent.slice(0, 24));
  }
  const clipped = [];
  for (const e of document.querySelectorAll('.panneau, .colonne, #prix-form, #essai-zone')) {
    if (seen(e) && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)) clipped.push(e.id || e.className);
  }
  const small = [];
  for (const e of document.querySelectorAll(frames)) {
    if (seen(e) && e.textContent !== '' && e.id !== 'motifs' && e.clientHeight < 40) small.push(e.id + ' ' + e.clientHeight);
  }
  return { sh: root.scrollHeight, h: innerHeight, sw: root.scrollWidth, w: innerWidth, off, clipped, small };
})()`;
const PREVIEW_FIT = `(() => {
  const f = document.querySelector('#apercu-cadre').getBoundingClientRect();
  const p = document.querySelector('#apercu-echelle').getBoundingClientRect();
  return { inside: p.left >= f.left - 1 && p.right <= f.right + 1 && p.top >= f.top - 1 && p.bottom <= f.bottom + 1, width: p.width, height: p.height };
})()`;
const FORM_FIT = `(() => {
  const e = document.querySelector('#prix-form');
  return getComputedStyle(e).overflowY !== 'auto' && getComputedStyle(e).overflowY !== 'scroll' && e.scrollHeight <= e.clientHeight + 1;
})()`;

async function fits(name: string): Promise<void> {
  const r = await page.evaluate(FIT) as { sh: number; h: number; sw: number; w: number; off: string[]; clipped: string[]; small: string[] };
  check(`${name} : aucun défilement de page`, r.sh <= r.h && r.sw <= r.w, r);
  check(`${name} : tout tient dans la fenêtre et dans sa boîte`, r.off.length === 0 && r.clipped.length === 0, r);
  check(`${name} : listes lisibles`, r.small.length === 0, r);
}

async function everyStep(label: string): Promise<void> {
  await go('livre');
  await fits(`${label}, Livre`);
  await go('prix');
  await page.click('#v-simulateur');
  await page.waitForSelector('#prix-resultat dl');
  await fits(`${label}, Prix, simulateur`);
  check(`${label}, Prix : le formulaire ne défile pas`, await page.evaluate(FORM_FIT) as boolean);
  await page.selectOption('#p-mode', 'saisi');
  await fits(`${label}, Prix, pages saisies`);
  await page.selectOption('#p-mode', 'estime');
  await page.click('#v-scenarios');
  await fits(`${label}, Prix, scénarios`);
  await go('collection');
  await fits(`${label}, Collection`);
  await go('essai');
  await until(`document.querySelector('#apercu-echelle').style.transform !== ''`);
  await page.waitForTimeout(50);
  await fits(`${label}, Essai`);
  const preview = await page.evaluate(PREVIEW_FIT) as { inside: boolean; width: number; height: number };
  check(`${label}, Essai : double page entière et lisible`, preview.inside && preview.height > 300 && Math.abs(preview.width / preview.height - 12.25 / 9.25) < 0.02, preview);
  check(`${label}, Essai : repères et export à côté de l’aperçu`, await page.isVisible('#r-fold') && await page.isVisible('#essai-exporter'));
}

// Plusieurs scénarios, retenus ou non, avec le scénario retenu en écart de pages.
{
  const file = path.join(dataRoot, BOOK_ID, 'pricing.json');
  const pricing = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = pricing.scenarios[0];
  for (let i = 2; i <= 8; i++) pricing.scenarios.push({ ...base, id: `s${i}`, name: `Scénario au nom assez long ${i}` });
  fs.writeFileSync(file, `${JSON.stringify(pricing, null, 2)}\n`);
}

for (const size of SIZES) {
  await page.setViewportSize(size);
  await open();
  await until(`document.querySelector('#etapes li[data-state="validee"]') !== null`);
  await everyStep(`${size.width} × ${size.height}, normal`);
}

// Listes très longues
const many = (word: string, n: number) => Array.from({ length: n }, (_, i) => `${word} ${i + 1} : message assez long pour occuper une ligne entière de la liste, parfois davantage selon la largeur.`);
const patchJson = (patch: (json: Record<string, any>) => void) => async (route: Route) => {
  const response = await route.fetch();
  const json = await response.json();
  patch(json);
  await route.fulfill({ response, json });
};
await page.route('**/api/read', patchJson(({ reading }) => {
  reading.alerts = many('Alerte', 60);
  const [s] = reading.scenes;
  reading.scenes = Array.from({ length: 30 }, (_, i) => ({ ...s, id: `scene-${i}`, rank: i + 1 }));
}));
await page.route('**/api/pricing/compute', patchJson(({ result }) => {
  result.errors = many('Erreur', 12);
  result.alerts = many('Alerte', 40);
}));
await page.route('**/api/pricing/state', patchJson((view) => { view.deviation = many('Écart', 12); }));
await page.route('**/api/parcours', patchJson((view) => { view.steps[1].reasons = many('Écart', 12); view.steps[1].state = 'alerte'; }));
await page.route('**/api/create', patchJson(({ result }) => {
  result.kept = many('Conservé', 30);
  result.alerts = many('Alerte', 20);
}));
await page.route('**/api/collection/create', patchJson(({ result }) => { result.kept = many('Conservé', 40); }));
await page.route('**/api/essai/export', patchJson((r) => {
  for (const c of r.checks) {
    c.level = 'erreur';
    c.details = many('Détail', 8);
  }
}));
for (const size of SIZES) {
  await page.setViewportSize(size);
  await open();
  await until(`document.querySelector('#etapes li[data-state="validee"]') !== null`);
  await page.waitForSelector('#lecture table', { state: 'attached' });
  await go('livre');
  await page.click('#creer');
  await until(`document.querySelector('#creation').textContent.includes('Conservé 30')`);
  await go('collection');
  await page.click('#collection-creer');
  await until(`document.querySelector('#collection-resultat').textContent.includes('Conservé 40')`);
  await go('essai');
  await exportPdf();
  await everyStep(`${size.width} × ${size.height}, listes longues`);
  await go('prix');
  await page.click('#v-simulateur');
  check(`${size.width} × ${size.height} : les messages de calcul défilent dans leur cadre`, await page.evaluate(`document.querySelector('#prix-calcul').scrollHeight > document.querySelector('#prix-calcul').clientHeight`) as boolean);
}
await page.unrouteAll({ behavior: 'ignoreErrors' });

// Signes : la couleur seule ne suffit pas
{
  await open();
  await until(`document.querySelector('#etapes li[data-state="validee"]') !== null`);
  const labels = await page.evaluate(`[...document.querySelectorAll('#etapes .nom-signe')].map((e) => [e.getAttribute('role'), e.getAttribute('aria-label'), e.textContent])`) as string[][];
  check('signes : image nommée, texte visible', labels.length === 4 && labels.every(([role, label, text]) => role === 'img' && !!label && !!text), labels);
}

// Configuration invalide : le menu reste affiché et dit quoi corriger.
{
  put(parent, 'config.local.json', '{');
  await page.goto(url);
  await page.waitForSelector('#etapes li');
  check('configuration invalide : Livre en erreur, message visible', (await tab('livre')).sign === 'erreur' && (await text('#config')).includes('config.local.json') && (await page.isDisabled('#choix')));
  await fits('configuration invalide');
}

check('aucune erreur dans la console de la page', pageErrors.filter((e) => !e.includes('409')).length === 0, pageErrors);
await browser.close();
await new Promise((resolve) => server.close(resolve));
finish('page');
