// scripts/test-ui.ts — la page dans un vrai Chromium (spec §5.3) : parcours de bout en bout, export réel, puis « sans défilement » à chaque
// étape et aux deux tailles retenues. La page n'a aucun `overflow: hidden` à la racine : un contenu trop grand se voit ici. Les listes
// très longues sont injectées dans les réponses du serveur, pour ne pas fabriquer un livre défectueux.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium, type Page, type Route } from 'playwright';
import { createPrintServer } from '../src/server/app';
import { BOOK_ID, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { makePng } from './fixtures/make-png';
import { makeResearch } from './fixtures/recherche';
import { startFakeComfy } from './fixtures/fake-comfy';
import { generationGraph, upscaleGraph } from './fixtures/workflows';
import { createComfyRuntime } from '../src/server/comfy-actions';
import { check, finish } from './test-lib';

const SIZES = [{ width: 1920, height: 950 }, { width: 1366, height: 650 }];
const STEP_IDS = ['livre', 'prix', 'collection', 'essai', 'droits', 'workflows', 'sujets'];

const glbRoot = makeGlbi();
const parent = tempDir();
const dataRoot = path.join(parent, 'donnees');
fs.mkdirSync(dataRoot);
const fake = await startFakeComfy();
put(parent, 'config.local.json', { glbRoot, dataRoot, comfyUrl: fake.url });
let seedAt = 0;
const comfyRuntime = createComfyRuntime({ historyPollMs: 5, busyPollMs: 5 }, () => [11, 22, 33][seedAt++ % 3]!);
const server = createPrintServer(path.join(parent, 'config.local.json'), comfyRuntime);
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
  check('menu : sept étapes numérotées, dans l’ordre', all.map((t) => t.id).join() === STEP_IDS.join() && all.every((t, i) => t.text.startsWith(String(i + 1))), all);
  check('ouverture : première étape non validée', (await current()) === 'livre');
  check('départ : Livre à faire, le reste verrouillé', (await statesText()) === 'à faire,verrouillée,verrouillée,verrouillée,verrouillée,verrouillée,verrouillée', await statesText());
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

  // Workflows (IC1) : déposés une fois pour la collection
  await page.reload();
  await page.waitForSelector('#etapes li');
  await until(`document.querySelector('#etapes li[data-state="validee"]') !== null`);
  check('Essai validé, workflows absents : ouverture sur Workflows', (await current()) === 'workflows' && (await text('#motifs')).includes('Déposer le workflow de génération'));
  await until(`document.querySelector('#wf-comfy').textContent.includes('0.43.0')`);
  check('Workflows : ComfyUI vérifié, version affichée', (await text('#wf-comfy')).includes(fake.url));
  check('Workflows : ComfyUI répond, pas de bouton Lancer', await page.isHidden('#wf-lancer'));
  const launched: string[] = [];
  comfyRuntime.launch = (f) => { launched.push(f); };
  const bat = path.join(parent, 'lanceur-essai.bat');
  fs.writeFileSync(bat, '@echo off\r\n');
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const closedUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise((r) => closed.close(r));
  put(parent, 'config.local.json', { glbRoot, dataRoot, comfyUrl: closedUrl, comfyLauncher: bat });
  await page.click('#wf-verifier');
  await until(`!document.querySelector('#wf-lancer').hidden`);
  check('Workflows : ComfyUI arrêté, message et bouton Lancer', (await text('#wf-comfy')).includes('ne répond pas'), await text('#wf-comfy'));
  await page.click('#wf-lancer');
  await until(`document.querySelector('#wf-comfy').textContent.includes('démarre')`);
  check('Lancer : le lanceur de la configuration, bouton désactivé pendant le démarrage', launched.join() === bat && await page.isDisabled('#wf-lancer'));
  put(parent, 'config.local.json', { glbRoot, dataRoot, comfyUrl: fake.url });
  await until(`document.querySelector('#wf-comfy').textContent.includes('0.43.0')`);
  check('Lancer : ComfyUI répond, le bouton disparaît', await page.isHidden('#wf-lancer'));
  const dropWorkflow = (kind: string, value: unknown) => page.setInputFiles(`#wf-fichier-${kind}`, { name: `${kind}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  const no34 = upscaleGraph();
  delete (no34 as Record<string, unknown>)['34'];
  await dropWorkflow('agrandissement', no34);
  await until(`document.querySelector('#wf-message .erreur')?.textContent.includes('nœud 34') === true`);
  check('Workflows : nœud 34 retiré, refus nommé, rien de rangé', !fs.existsSync(path.join(dataRoot, 'collection', 'workflows', 'workflows.json')));
  await dropWorkflow('generation', generationGraph());
  await until(`document.querySelector('#wf-message .bien') !== null`);
  check('Workflows : génération rangée, droits proposés cochés', await page.isChecked('#wf-droits-generation input[value="niedot294a"]') && (await text('#wf-info-generation')).includes('generation.'));
  await dropWorkflow('agrandissement', upscaleGraph());
  await untilTab('workflows', 'validée');
  check('Workflows : les deux déposés, étape validée', (await tab('workflows')).state === 'validee' && await page.isChecked('#wf-droits-agrandissement input[value="realesrgan-x4plus"]'));
  check('Workflows : extensions et polices jamais proposées', !(await text('#wf-droits-generation')).includes('ComfyUI_IPAdapter') && !(await text('#wf-droits-generation')).includes('Andika'));
  await page.uncheck('#wf-droits-agrandissement input[value="realesrgan-x4plus"]');
  await page.uncheck('#wf-droits-agrandissement input[value="sdxl-base-1-0"]');
  await untilTab('workflows', 'à faire');
  check('Workflows : aucun droit coché, à faire', (await text('#motifs')).includes('Cocher les droits'));
  await page.check('#wf-droits-agrandissement input[value="realesrgan-x4plus"]');
  await page.check('#wf-droits-agrandissement input[value="sdxl-base-1-0"]');
  await untilTab('workflows', 'validée');

  await page.reload();
  await page.waitForSelector('#etapes li');
  await until(`document.querySelector('#etapes li[data-state="validee"]') !== null`);
  check('Essai validé, aucun sujet : ouverture sur Sujets', (await current()) === 'sujets');

  await go('prix');
  await page.click('#v-scenarios');
  await page.click('#prix-scenarios button:has-text("Ne plus retenir")');
  await untilTab('essai', 'verrouillée');
  check('étape redevenue non validée : la suite se reverrouille', (await statesText()) === 'validée,à faire,verrouillée,verrouillée,verrouillée,verrouillée,verrouillée', await statesText());
  check('reverrouillage : aucune donnée perdue', fs.existsSync(style) && fs.existsSync(path.join(dataRoot, BOOK_ID, 'export', 'essai-2A.pdf')));
  await page.reload();
  await until(`document.querySelector('#etapes li[data-state="a-faire"]') !== null`);
  check('réouverture : première étape non validée, sans mémoire d’onglet', (await current()) === 'prix');
  await page.click('#v-scenarios');
  await page.click('#prix-scenarios button:has-text("Retenir")');
  await untilTab('essai', 'validée');
  check('scénario de nouveau retenu : le parcours revient', (await statesText()) === 'validée,validée,validée,validée,alerte,validée,à faire', await statesText());
}

// Sujet réel, de la création à « relu »
const subjectFile = () => JSON.parse(fs.readFileSync(path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'subject.json'), 'utf8'));
const researchFile = () => JSON.parse(fs.readFileSync(path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'research.json'), 'utf8'));
const subTab = (id: string) => page.evaluate(`document.querySelector('#sous-etapes button[data-step="${id}"] .nom-signe')?.getAttribute('aria-label')`) as Promise<string | null>;
const goSub = (id: string) => page.click(`#sous-etapes button[data-step="${id}"]`);
const untilSub = (id: string, sign: string) => until(`document.querySelector('#sous-etapes button[data-step="${id}"] .nom-signe')?.getAttribute('aria-label') === '${sign}'`);
const importJson = (value: unknown) => page.setInputFiles('#r-fichier', { name: 'research.json', mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
const claimButton = (id: string, name: string) => page.click(`[data-claim="${id}"] button:has-text("${name}")`);
const stateOfBlock = (id: string) => page.getAttribute(`[data-block="${id}"]`, 'data-state');
const stateOfClaim = (id: string) => page.getAttribute(`[data-claim="${id}"]`, 'data-state');
const untilBlock = (id: string, state: string) => until(`document.querySelector('[data-block="${id}"]')?.dataset.state === '${state}'`);
const untilClaim = (id: string, state: string) => until(`document.querySelector('[data-claim="${id}"]')?.dataset.state === '${state}'`);
const runControl = async (button: string) => {
  await page.click(button);
  await until(`!document.querySelector('#sa-controler').disabled && document.querySelector('#sa-resultat table') !== null`);
};
const levels = () => page.evaluate(`[...document.querySelectorAll('#sa-resultat tr')].slice(1).map((r) => r.cells[0].textContent + ':' + r.cells[2].querySelector('.signe').getAttribute('aria-label'))`) as Promise<string[]>;
{
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize(SIZES[0]!);
  await open();
  await until(`document.querySelector('#s-scene option') !== null`);
  check('Sujets : la scène et le gabarit viennent de la lecture et du registre', (await page.inputValue('#s-scene')) === 'alpha' && (await page.inputValue('#s-gabarit')) === '2A');
  check('Sujets : thème proposé par la rotation', (await page.inputValue('#s-theme')) === 'foret');
  check('Sujets : aucun sujet', (await text('#sujets-liste')).includes('Aucun sujet'));
  await page.fill('#s-pages', '4');
  check('Sujets : aucun gabarit de 4 pages, création impossible', await page.isDisabled('#s-creer'));
  await page.fill('#s-pages', '2');
  await page.click('#s-creer');
  await until(`document.querySelector('#sujet-message').textContent.includes('alpha')`);
  check('création : le total suit', (await text('#sujets-total')).includes('2 pages de sujets') && (await text('#sujets-total')).includes('page 8'), await text('#sujets-total'));
  check('création : Essai reste validé', (await tab('essai')).sign === 'validée');
  check('création : le sujet est dans la liste', (await text('#sujets-liste')).includes('alpha fr') && (await tab('sujets')).sign === 'à faire');
  check('création : thème suivant proposé', (await page.inputValue('#s-theme')) === 'ocean');
  await page.selectOption('#s-scene', 'alpha');
  await page.click('#s-creer');
  await until(`document.querySelector('#sujet-message .erreur') !== null`);
  check('création : second essai refusé, message visible', (await text('#sujet-message')).includes('existe déjà'));

  await page.click('#sujets-liste button:has-text("Ouvrir")');
  await untilSub('sujet-recherche', 'à faire');
  check('sujet : Relecture et Aperçu verrouillés avant l’import', (await subTab('sujet-relecture')) === 'verrouillée' && (await subTab('sujet-apercu')) === 'verrouillée');
  await page.click('#r-preparer');
  await until(`document.querySelector('#r-copie').textContent !== ''`);
  check('prompt : affiché', (await page.inputValue('#r-prompt')).includes('alpha fr'));
  // Le presse-papiers dépend du navigateur de test : la batterie le vérifie pour de vrai.
  if ((await text('#r-copie')).includes('copié')) check('prompt : dans le presse-papiers', ((await page.evaluate('navigator.clipboard.readText()')) as string).replace(/\r\n/g, "\n") === await page.inputValue("#r-prompt"));

  const { generatedAt: _g, ...withoutField } = makeResearch();
  await importJson(withoutField);
  await until(`document.querySelector('#r-resultat .erreur') !== null`);
  check('import : champ manquant, nommé', (await text('#r-resultat')).includes('champ generatedAt'), await text('#r-resultat'));
  check('import refusé : aucun fichier écrit', !fs.existsSync(path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'research.json')));
  await importJson(makeResearch('beta'));
  await until(`document.querySelector('#r-resultat').textContent.includes('subjectId')`);
  await importJson(makeResearch());
  await untilSub('sujet-recherche', 'validée');
  check('import : relecture ouverte', (await subTab('sujet-relecture')) === 'à faire' && (await subTab('sujet-apercu')) === 'à faire');
  check('import : fichiers dans le dossier de données', researchFile().claims[0].status === 'propose' && subjectFile().blocks[0].state === 'a-relire');

  await goSub('sujet-relecture');
  await page.waitForSelector('[data-claim="c1"]');
  check('relecture : source en lien sûr', (await page.getAttribute('[data-claim="c1"] a', 'href')) === 'https://source-1.example/page' && (await page.getAttribute('[data-claim="c1"] a', 'rel'))!.includes('noopener'));
  check('relecture : paraphrase et URL non contrôlée', (await text('[data-claim="c1"]')).includes('autres mots') && (await text('[data-claim="c1"]')).includes('non contrôlée'));
  check('relecture : fait débattu signalé', (await text('[data-claim="c3"]')).includes('fait débattu'));
  check('relecture : compteur par rapport à la zone', (await text('[data-block="chapeau"] .compteur')).includes(' / 140'));
  check('relecture : bloc non validable avant ses affirmations', await page.isDisabled('[data-block="chapeau"] button:has-text("Valider le bloc")'));

  await claimButton('c1', 'Valider');
  await untilClaim('c1', 'valide');
  await claimButton('c2', 'Corriger');
  await page.fill('[data-claim="c2"] textarea', 'Le Fictivore mesure deux mètres et demi.');
  await page.click('[data-claim="c2"] button:has-text("Enregistrer la correction")');
  await untilClaim('c2', 'corrige');
  await claimButton('c3', 'Rejeter');
  await untilClaim('c3', 'rejete');
  check('rejet : les blocs qui la citent sont à reprendre', (await stateOfBlock('texte')) === 'a-reprendre' && (await stateOfBlock('fiche-regime')) === 'a-reprendre');
  check('relecture : enregistré aussitôt', researchFile().claims[0].status === 'valide' && researchFile().claims[2].status === 'rejete' && researchFile().claims[1].correctedText.includes('deux mètres et demi'));
  await page.fill('[data-claim="c1"] input', 'Vu avec soin.');
  await page.press('[data-claim="c1"] input', 'Tab');
  await until(`document.querySelector('[data-claim="c1"] input').value === 'Vu avec soin.'`);
  check('note : enregistrée', await (async () => {
    for (let i = 0; i < 100 && researchFile().claims[0].note === ''; i++) await page.waitForTimeout(20);
    return researchFile().claims[0].note === 'Vu avec soin.';
  })());

  check('citation : on ne retire pas la dernière', await page.isDisabled('[data-block="fiche-regime"] .cite button'));
  await page.selectOption('[data-block="fiche-regime"] .cite select', 'c1');
  await until(`document.querySelectorAll('[data-block="fiche-regime"] .cite button').length === 2`);
  await page.click('[data-block="fiche-regime"] .cite button:has-text("c3")');
  await until(`document.querySelectorAll('[data-block="fiche-regime"] .cite button').length === 1`);
  await page.click('[data-block="texte"] .cite button:has-text("c3")');
  await until(`document.querySelectorAll('[data-block="texte"] .cite button').length === 1`);

  await goSub('sujet-apercu');
  await until(`document.querySelector('#sa-page').src.includes('/apercu-sujet?')`);
  await page.waitForTimeout(100);
  check('aperçu : le texte réel est dans le cadre', ((await page.frameLocator('#sa-page').locator('[data-zone="chapeau"]').textContent()) ?? '').includes('Fictivore'));
  check('aperçu : titre de la scène', (await page.frameLocator('#sa-page').locator('[data-zone="titre"]').textContent()) === 'alpha fr');
  check('aperçu : numéros réels', (await page.frameLocator('#sa-page').locator('section').first().getAttribute('data-page')) === '6');
  check('aperçu : illustration et QR marqués', ((await page.frameLocator('#sa-page').locator('[data-zone="illustration"]').getAttribute('src')) ?? '').includes('venir') && ((await page.frameLocator('#sa-page').locator('[data-zone="qr"]').textContent()) ?? '').includes('FACTICE'));
  await page.check('input[data-sujet-layer="zones"]');
  check('aperçu : repères repris de l’essai', (await page.getAttribute('#sa-reperes g[data-layer="zones"]', 'display')) === 'inline' && (await page.locator('#sa-reperes text').count()) > 5);
  await runControl('#sa-relu');
  check('relu refusé : blocs à valider', (await text('#sa-resultat')).includes('à valider') && subjectFile().status === 'brouillon', await text('#sa-resultat'));
  check('contrôles : verts sur des textes corrects', (await levels()).join() === 'C10:contrôle réussi,C12:contrôle réussi,C13:contrôle réussi', await levels());

  await goSub('sujet-relecture');
  for (const id of ['chapeau', 'texte', 'fiche-taille', 'fiche-poids', 'fiche-epoque', 'fiche-regime', 'fiche-lieu']) {
    await page.click(`[data-block="${id}"] button:has-text("Valider le bloc")`);
    await untilBlock(id, 'valide');
  }
  await untilSub('sujet-relecture', 'validée');
  await goSub('sujet-apercu');
  await runControl('#sa-relu');
  await untilSub('sujet-apercu', 'validée');
  check('relu : écrit dans subject.json', subjectFile().status === 'relu' && (await text('#sa-resultat')).includes('marqué relu'));
  await untilTab('sujets', 'validée');

  // Débordement réel : Aperçu reste ouvert quand un bloc repasse à relire.
  await goSub('sujet-relecture');
  await page.fill('[data-block="texte"] textarea', 'Une phrase un peu longue pour remplir toute la zone de texte de la page. '.repeat(12));
  check('compteur : passe en erreur à la frappe', await page.evaluate(`document.querySelector('[data-block="texte"] .compteur').classList.contains('erreur')`) as boolean);
  await page.press('[data-block="texte"] textarea', 'Tab');
  await untilBlock('texte', 'a-relire');
  check('bloc modifié : sujet en brouillon', subjectFile().status === 'brouillon');
  await untilSub('sujet-relecture', 'à faire');
  check('bloc à relire : Aperçu reste ouvert', (await subTab('sujet-apercu')) === 'à faire');
  await goSub('sujet-apercu');
  await runControl('#sa-controler');
  const red = await text('#sa-resultat');
  check('C12 rouge : limite et débordement mesuré', (await levels()).includes('C12:erreur') && red.includes('caractères') && red.includes('déborde'), red);
  await goSub('sujet-relecture');
  await page.fill('[data-block="texte"] textarea', 'Le Fictivore mesure deux mètres et demi. Il vit dans les pages de tests.');
  await page.press('[data-block="texte"] textarea', 'Tab');
  await until(`document.querySelector('[data-block="texte"] .compteur').classList.contains('erreur') === false`);
  await page.waitForTimeout(100);
  await goSub('sujet-apercu');
  await runControl('#sa-controler');
  check('C12 de nouveau vert', (await levels()).includes('C12:contrôle réussi'), await levels());

  // Second import : confirmation, ancien fichier daté
  await goSub('sujet-recherche');
  await importJson(makeResearch());
  await until(`!document.querySelector('#r-confirmation').hidden`);
  check('second import : confirmation demandée, rien d’écrit', (await text('#r-resume')).includes('Affirmations gardées') && researchFile().claims[0].status === 'valide');
  await page.click('#r-annuler');
  check('second import annulé : rien ne change', await page.isHidden('#r-confirmation'));
  await importJson(makeResearch());
  await until(`!document.querySelector('#r-confirmation').hidden`);
  await page.click('#r-remplacer');
  await until(`document.querySelector('#r-resultat').textContent.includes('Anciens fichiers')`);
  const names = fs.readdirSync(path.join(dataRoot, BOOK_ID, 'subjects', 'alpha'));
  check('second import : anciens fichiers gardés, datés', names.filter((n) => /^research\..+\.json$/.test(n)).length === 1 && names.filter((n) => /^subject\..+\.json$/.test(n)).length === 1, names);
  check('second import : correction de David gardée', researchFile().claims[1].correctedText?.includes('deux mètres et demi'));

  // Titre et légende
  await goSub('sujet-relecture');
  await page.fill('#rl-titre', 'Titre surchargé');
  await page.press('#rl-titre', 'Tab');
  await until(`document.querySelector('#rl-champs').textContent.includes('surchargé')`);
  check('titre : surcharge enregistrée, signalée', subjectFile().title.fr === 'Titre surchargé');
  await page.fill('#rl-titre', '');
  await page.press('#rl-titre', 'Tab');
  await until(`document.querySelector('#rl-champs').textContent.includes('lu dans la scène')`);
  check('titre : surcharge retirée', subjectFile().title.fr === undefined);
  await page.fill('#rl-legende', 'Légende de David');
  await page.press('#rl-legende', 'Tab');
  await until(`document.querySelector('#rl-legende').value === 'Légende de David'`);
  await page.waitForTimeout(150);
  check('légende : enregistrée', subjectFile().qrLegend.fr === 'Légende de David');
  await goSub('sujet-apercu');
  await page.selectOption('#sa-theme', 'ocean');
  await until(`document.querySelector('#sa-theme').value === 'ocean'`);
  await page.waitForTimeout(150);
  check('thème : changé dans l’aperçu', subjectFile().variant.theme === 'ocean');

  // Remise au vert pour la suite : tout validé, sujet relu
  await goSub('sujet-relecture');
  for (const id of (await page.evaluate(`[...document.querySelectorAll('[data-claim][data-state="propose"], [data-claim][data-state="rejete"]')].map((e) => e.dataset.claim)`) as string[])) {
    await claimButton(id, 'Valider');
    await untilClaim(id, 'valide');
  }
  for (const id of (await page.evaluate(`[...document.querySelectorAll('[data-block]:not([data-state="valide"])')].map((e) => e.dataset.block)`) as string[])) {
    await page.click(`[data-block="${id}"] button:has-text("Valider le bloc")`);
    await untilBlock(id, 'valide');
  }
  await goSub('sujet-apercu');
  await runControl('#sa-relu');
  await untilTab('sujets', 'validée');
  await page.click('#sujet-retour');
  await page.selectOption('#s-scene', 'beta');
  await page.click('#s-creer');
  await until(`document.querySelector('#sujet-message').textContent.includes('beta')`);
  check('second sujet : commence en page 8', (await text('#sujets-total')).includes('page 10'));
}

// Droits et illustrations, de bout en bout (MP4)
const c = (id: string) => page.evaluate(`[...document.querySelectorAll('#il-controles tr')].slice(1).find((r) => r.cells[0].textContent === '${id}')?.cells[2].querySelector('.signe').getAttribute('aria-label')`) as Promise<string | undefined>;
const untilCheck = (id: string, label: string) => until(`[...document.querySelectorAll('#il-controles tr')].slice(1).find((r) => r.cells[0].textContent === '${id}')?.cells[2].querySelector('.signe').getAttribute('aria-label') === '${label}'`);
const setRange = (value: number) => page.evaluate(`(() => { const r = document.querySelector('#il-zoom'); r.value = '${value}'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const deposit = (buffer: Buffer, name = 'image.png') => page.setInputFiles('#il-fichier', { name, mimeType: 'image/png', buffer });
const framingOf = () => subjectFile().illustrations[0].framing;
{
  await page.setViewportSize(SIZES[0]!);
  const common = path.join(dataRoot, 'collection', 'rights.json');
  const saved = JSON.parse(fs.readFileSync(common, 'utf8'));
  fs.writeFileSync(common, `${JSON.stringify({ ...saved, entries: saved.entries.slice(0, 3) }, null, 2)}\n`);
  await open();
  await untilTab('droits', 'à faire');
  check('registre d’avant MP4 : Droits à faire, la page s’y ouvre', (await current()) === 'droits' && await page.isVisible('#dr-completer'));
  await until(`document.querySelector('#dr-commun table') !== null`);
  check('registre : trois entrées, huit à ajouter', (await page.locator('#dr-commun tr[data-entry]').count()) === 3 && (await text('#dr-note')).includes('8 entrées'), await text('#dr-note'));
  await page.click('#dr-completer');
  await untilTab('droits', 'alerte');
  check('Ajouter ce qui manque : onze entrées', (await page.locator('#dr-commun tr[data-entry]').count()) === 11 && (await text('#dr-message')).includes('8 entrées ajoutées'));
  const footprint = fs.readFileSync(common);
  await page.click('#dr-completer');
  await until(`document.querySelector('#dr-message').textContent.includes('Rien à ajouter')`);
  check('second clic : fichier identique', fs.readFileSync(common).equals(footprint));
  check('Droits : le motif nomme l’entrée à vérifier', (await text('#motifs')).includes('niedot294a'));

  const credits = { entries: [{ asset: '', src_name: 'Forêt de synthèse', author: 'Auteur Fictif', license: 'C.C by 4.0', url: 'https://exemple.test/f', original: false }, { asset: '', src_name: 'Rocher de synthèse', author: 'Auteur Fictif', license: 'Free Standard', url: '', original: false }, { asset: '', src_name: 'Mon modèle', author: 'David', license: '', url: '', original: true }] };
  const dropCredits = (content: string) => page.setInputFiles('#dr-fichier', { name: 'credits.json', mimeType: 'application/json', buffer: Buffer.from(content) });
  await dropCredits('{');
  await until(`document.querySelector('#dr-message .erreur')?.textContent.includes('credits.json') === true`);
  check('credits.json invalide : message, rien d’ajouté', (await page.locator('#dr-livre tr[data-entry]').count()) === 0);
  await dropCredits(JSON.stringify(credits));
  await until(`document.querySelector('#dr-message').textContent.includes('2 entrée(s) créée(s)')`);
  check('credits.json : deux entrées, licence relue', (await page.locator('#dr-livre tr[data-entry]').count()) === 2 && (await text('#dr-livre')).includes('CC BY 4.0') && (await text('#dr-livre')).includes('à vérifier'), await text('#dr-livre'));
  await dropCredits(JSON.stringify(credits));
  await until(`document.querySelector('#dr-message').textContent.includes('0 entrée(s) créée(s)')`);
  check('credits.json : second dépôt, rien de plus', (await page.locator('#dr-livre tr[data-entry]').count()) === 2);

  await page.fill('#dr-nom', 'Entrée à la main');
  await page.fill('#dr-auteur', 'Auteur');
  await page.fill('#dr-licence', 'CC BY 4.0');
  await page.fill('#dr-credit', 'Crédit à la main');
  await page.selectOption('#dr-commercial', 'oui');
  await page.click('#dr-enregistrer');
  await until(`document.querySelector('#dr-livre tr[data-entry="auteur-entree-a-la-main"]') !== null`);
  check('entrée ajoutée, formulaire remis à zéro', (await page.inputValue('#dr-nom')) === '' && (await text('#dr-titre')) === 'Nouvelle entrée');
  await page.click('#dr-livre tr[data-entry="auteur-entree-a-la-main"] button');
  check('Modifier : formulaire rempli, registre figé', (await page.inputValue('#dr-nom')) === 'Entrée à la main' && (await text('#dr-titre')).includes('auteur-entree-a-la-main') && await page.isDisabled('#dr-registre'));
  await page.selectOption('#dr-commercial', 'non');
  await page.click('#dr-enregistrer');
  await untilTab('droits', 'erreur');
  check('commercialOk à non : Droits en erreur, Sujets reste ouvert', (await tab('sujets')).state !== 'verrouillee');
  await page.click('#dr-livre tr[data-entry="auteur-entree-a-la-main"] button');
  await page.selectOption('#dr-commercial', 'oui');
  await page.click('#dr-enregistrer');
  await untilTab('droits', 'alerte');

  await go('sujets');
  await page.click('#sujets-liste tr:has-text("alpha fr") button:has-text("Ouvrir")');
  await until(`document.querySelector('#sous-etapes button[aria-current="step"]') !== null`);
  const sub = await page.evaluate(`[...document.querySelectorAll('#sous-etapes button')].map((b) => b.dataset.step).join()`);
  check('étapes du sujet : Illustrations entre Relecture et Aperçu', sub === 'sujet-recherche,sujet-relecture,sujet-illustrations,sujet-apercu', sub);
  check('sujet relu sans image : s’ouvre sur Illustrations', await page.isVisible('#il-depot') && (await subTab('sujet-illustrations')) === 'à faire');
  await until(`document.querySelector('#il-cible').textContent !== ''`);
  check('taille cible affichée', (await text('#il-cible')).includes('1838 × 2775'));
  check('sans image : cadrage désactivé, vignette masquée', await page.isDisabled('#il-zoom') && await page.isHidden('#il-vignette'));
  await deposit(Buffer.from('pas un png'), 'faux.png');
  await until(`document.querySelector('#il-message .erreur')?.textContent.includes('pas un PNG') === true`);
  check('faux PNG : refusé, rien dans le sujet', subjectFile().illustrations.length === 0);

  const png = makePng(1838, 2775, 4, (x, y) => [x % 251, y % 241, 120, 255]);
  await deposit(png);
  await until(`document.querySelector('#il-message .bien')?.textContent.includes('1838 × 2775') === true`);
  await until(`document.querySelector('#il-image').complete && document.querySelector('#il-image').naturalWidth === 1838`);
  check('dépôt : vignette servie sous la CSP de la page', await page.isVisible('#il-vignette'));
  check('dépôt : résolution effective affichée', (await text('#il-infos')).includes('300 ppp'), await text('#il-infos'));
  await untilSub('sujet-illustrations', 'erreur');
  check('dépôt : C5 vert, C11 rouge sans droits', (await c('C5')) === 'contrôle réussi' && (await c('C11')) === 'erreur');
  check('registre seul : ni police ni extension proposées', (await page.locator('#il-droits input').count()) === 9 && !(await text('#il-droits')).includes('Andika') && !(await text('#il-droits')).includes('ComfyUI_IPAdapter'), await text('#il-droits'));
  check('dépôt : le sujet reste relu', subjectFile().status === 'relu');
  await page.click('#il-droits input[value="sdxl-base-1-0"]');
  await untilCheck('C11', 'alerte');
  await page.click('#il-droits input[value="auteur-fictif-foret-de-synthese"]');
  await untilCheck('C11', 'contrôle réussi');
  await untilSub('sujet-illustrations', 'validée');
  check('droits rattachés : étape validée', (await subTab('sujet-illustrations')) === 'validée' && await page.isChecked('#il-droits input[value="sdxl-base-1-0"]'));

  await setRange(1.1);
  await untilCheck('C5', 'erreur');
  await untilSub('sujet-illustrations', 'erreur');
  check('zoom 1,10 : C5 rouge, enregistré aussitôt', framingOf().zoom === 1.1 && (await text('#il-controles')).includes('272 ppp'), await text('#il-controles'));
  const before = await page.evaluate(`document.querySelector('#il-visible').style.left`);
  const box = (await page.locator('#il-image').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.05, box.y + box.height * 0.5);
  await until(`document.querySelector('#il-visible').style.left !== '${before}'`);
  check('clic sur la vignette : point focal enregistré', Math.abs(framingOf().focusX - 0.05) < 0.02 && Math.abs(framingOf().focusY - 0.5) < 0.02, framingOf());
  check('cadrage : le sujet reste relu', subjectFile().status === 'relu');
  await page.fill('#il-x', '50');
  await page.press('#il-x', 'Tab');
  await until(`document.querySelector('#il-visible').style.left !== '0%'`);
  await setRange(1);
  await untilCheck('C5', 'contrôle réussi');
  await untilSub('sujet-illustrations', 'validée');
  check('retour à 1 : vert', framingOf().zoom === 1 && Math.abs(framingOf().focusX - 0.5) < 0.001, framingOf());

  await deposit(png);
  await until(`!document.querySelector('#il-confirmation').hidden`);
  await page.click('#il-annuler');
  check('second dépôt : confirmation, Annuler n’écrit rien', await page.isHidden('#il-confirmation'));
  await setRange(1.05);
  await untilCheck('C5', 'erreur');
  await deposit(png);
  await until(`!document.querySelector('#il-confirmation').hidden`);
  await page.click('#il-remplacer');
  await until(`document.querySelector('#il-message .bien') !== null`);
  await untilCheck('C5', 'contrôle réussi');
  check('remplacement : cadrage remis à zéro, droits gardés', framingOf().zoom === 1 && await page.isChecked('#il-droits input[value="sdxl-base-1-0"]'));

  // Vue « Générer » (IC1), contre le faux ComfyUI
  await page.click('#v-generer');
  await until(`document.querySelector('#ge-attendu').textContent.includes('832 × 1216')`);
  check('Générer : tailles et noms attendus, règle des 300 px rappelée', (await text('#ge-attendu')).includes('illustration.rendu.png') && (await text('#ge-attendu')).includes('300 px') && (await text('#ge-attendu')).includes('2114 × 3192'), await text('#ge-attendu'));
  await until(`document.querySelector('#ge-comfy').textContent.includes('0.43.0')`);
  check('Générer : état de ComfyUI affiché', (await text('#ge-comfy')).includes('répond'));
  check('Générer : sans entrées, bouton désactivé', await page.isDisabled('#ge-lancer') && (await text('#ge-etat-rendu')) === 'à déposer');
  await page.setInputFiles('#ge-fichier-rendu', { name: 'rendu.png', mimeType: 'image/png', buffer: makePng(896, 1152, 3, () => [1, 2, 3]) });
  await until(`document.querySelector('#ge-message .erreur')?.textContent.includes('832 × 1216 px attendus') === true`);
  check('Générer : rendu à une autre taille, refusé avec la taille attendue', (await text('#ge-etat-rendu')) === 'à déposer');
  await page.setInputFiles('#ge-fichier-rendu', { name: 'rendu.png', mimeType: 'image/png', buffer: makePng(832, 1216, 3, (x, y) => [x % 256, y % 256, 80]) });
  await until(`document.querySelector('#ge-etat-rendu').textContent.startsWith('✓')`);
  await page.setInputFiles('#ge-fichier-mist', { name: 'mist.png', mimeType: 'image/png', buffer: makePng(832, 1216, 3, (_x, y) => [y % 256, y % 256, y % 256]) });
  await until(`document.querySelector('#ge-etat-mist').textContent.startsWith('✓')`);
  check('Générer : prompt prérempli depuis le workflow', (await page.inputValue('#ge-prompt')) === generationGraph()['6']!.inputs.text);
  await page.fill('#ge-prompt', 'an imaginary blue animal');
  await page.press('#ge-prompt', 'Tab');
  await until(`document.querySelector('#ge-couleurs').textContent.includes('blue')`);
  check('Générer : couleur du prompt signalée, prompt gardé dans le sujet', subjectFile().generationPrompts.illustration === 'an imaginary blue animal');
  await page.fill('#ge-prompt', 'an imaginary animal');
  await page.press('#ge-prompt', 'Tab');
  await until(`document.querySelector('#ge-couleurs').textContent === ''`);
  fake.busy = 1;
  await page.click('#ge-lancer');
  await until(`!document.querySelector('#file-comfy').hidden && document.querySelector('#file-comfy').textContent.includes('ComfyUI occupé')`);
  check('file : une ligne dans le bandeau, la tâche attend que ComfyUI soit libre', (await text('#file-comfy')).includes('génération alpha/illustration'), await text('#file-comfy'));
  check('file : la tâche en attente de ComfyUI s’annule', await page.isVisible('#ge-file button:has-text("Annuler")'));
  fake.busy = 0;
  await until(`document.querySelectorAll('#ge-candidats .candidat img').length === 3 && [...document.querySelectorAll('#ge-candidats img')].every((i) => i.complete && i.naturalWidth === 832)`);
  check('Générer : trois images corrigées côte à côte', (await text('#ge-candidats')).includes('Graine 11') && (await text('#ge-candidats')).includes('Graine 33'));
  check('file : fin de la tâche dite dans le bandeau', (await text('#file-comfy')).includes('réussie'), await text('#file-comfy'));
  await page.click('#ge-candidats .candidat[data-seed="22"] button');
  await until(`!document.querySelector('#ge-confirmation').hidden`);
  check('Agrandir sur une zone remplie : confirmation d’abord', comfyRuntime.queue.snapshot().current === null && comfyRuntime.queue.snapshot().pending.length === 0);
  await page.click('#ge-remplacer');
  await until(`document.querySelector('#ge-message .bien')?.textContent.includes('agrandissement') === true`);
  check('Agrandir : image finale rangée, traçabilité', subjectFile().illustrations[0].width === 2114 && subjectFile().illustrations[0].generation.seed === 22);
  await page.click('#v-depot');
  await until(`document.querySelector('#il-image').complete && document.querySelector('#il-image').naturalWidth === 2114`);
  await untilCheck('C5', 'contrôle réussi');
  check('Dépôt : l’image agrandie, C5 vert', (await text('#il-infos')).includes('2114 × 3192'), await text('#il-infos'));
  await goSub('sujet-apercu');
  await until(`document.querySelector('#sa-page').src.includes('/apercu-sujet?')`);
  const previewPage = await (await page.request.get((await page.getAttribute('#sa-page', 'src'))!.startsWith('http') ? (await page.getAttribute('#sa-page', 'src'))! : `${url}${(await page.getAttribute('#sa-page', 'src'))!.slice(1)}`)).text();
  check('aperçu : l’image réelle remplace l’aplat', previewPage.includes('data:image/png;base64,'));
  await page.click('#sujet-retour');
}

// Sans défilement. Chaque boîte qui ne porte pas une liste doit contenir ce qu'elle affiche, et chaque commande doit tenir dans la fenêtre.
const FIT = `(() => {
  const root = document.documentElement;
  const seen = (e) => e.getClientRects().length > 0;
  const frames = '.liste, .defile';
  const off = [];
  for (const e of document.querySelectorAll('button, select, input, textarea, label, h2, dt, dd, fieldset, .cadre-apercu')) {
    if (!seen(e) || e.closest(frames) || e.closest('.echelle-apercu')) continue;
    const r = e.getBoundingClientRect();
    if (r.top < -0.5 || r.left < -0.5 || r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5) off.push(e.id || e.tagName + ' ' + e.textContent.slice(0, 24));
  }
  const clipped = [];
  for (const e of document.querySelectorAll('.panneau, .colonne, .sous-panneau, #prix-form, .zone-apercu, .candidat')) {
    if (seen(e) && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)) clipped.push(e.id || e.className);
  }
  const small = [];
  for (const e of document.querySelectorAll(frames)) {
    // Les motifs d'une étape, du livre ou du sujet, tiennent souvent en une ligne : leur cadre est fait pour.
    if (seen(e) && e.textContent !== '' && e.id !== 'motifs' && e.id !== 'sujet-motifs' && e.clientHeight < 40) small.push(e.id + ' ' + e.clientHeight);
  }
  return { sh: root.scrollHeight, h: innerHeight, sw: root.scrollWidth, w: innerWidth, off, clipped, small };
})()`;
const previewFit = (frame: string, inner: string) => `(() => {
  const f = document.querySelector('${frame}').getBoundingClientRect();
  const p = document.querySelector('${inner}').getBoundingClientRect();
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
  const preview = await page.evaluate(previewFit('#apercu-cadre', '#apercu-echelle')) as { inside: boolean; width: number; height: number };
  check(`${label}, Essai : double page entière et lisible`, preview.inside && preview.height > 300 && Math.abs(preview.width / preview.height - 12.25 / 9.25) < 0.02, preview);
  check(`${label}, Essai : repères et export à côté de l’aperçu`, await page.isVisible('#r-fold') && await page.isVisible('#essai-exporter'));
  await go('droits');
  await until(`document.querySelector('#dr-commun table') !== null`);
  await fits(`${label}, Droits`);
  check(`${label}, Droits : les commandes restent visibles`, await page.isVisible('#dr-completer') && await page.isVisible('#dr-enregistrer') && await page.isVisible('#dr-credit'));
  await go('workflows');
  await until(`document.querySelector('#wf-info-generation dl') !== null`);
  await fits(`${label}, Workflows`);
  check(`${label}, Workflows : dépôts et droits visibles`, await page.isVisible('#wf-depot-agrandissement') && await page.isVisible('#wf-droits-agrandissement'));
  await go('sujets');
  await until(`document.querySelector('#sujets-liste table') !== null`);
  await fits(`${label}, Sujets`);
  await page.click('#sujets-liste button:has-text("Ouvrir")');
  await until(`document.querySelector('#sous-etapes button[aria-current="step"]') !== null`);
  await goSub('sujet-recherche');
  await page.click('#r-preparer');
  await until(`document.querySelector('#r-copie').textContent !== ''`);
  await fits(`${label}, Recherche`);
  await goSub('sujet-relecture');
  await page.waitForSelector('[data-claim]');
  await fits(`${label}, Relecture`);
  check(`${label}, Relecture : les commandes du haut restent visibles`, await page.isVisible('#rl-urls') && await page.isVisible('#rl-titre'));
  await goSub('sujet-illustrations');
  await until(`document.querySelector('#il-vignette').style.height !== '' && document.querySelector('#il-controles table') !== null`);
  await page.waitForTimeout(50);
  await fits(`${label}, Illustrations`);
  await page.click('#v-generer');
  await until(`document.querySelectorAll('#ge-candidats .candidat img').length === 3 && [...document.querySelectorAll('#ge-candidats img')].every((i) => i.complete)`);
  await page.waitForTimeout(50);
  await fits(`${label}, Générer`);
  check(`${label}, Générer : candidats lisibles, prompt et bouton visibles`, await page.evaluate(`[...document.querySelectorAll('#ge-candidats img')].every((i) => i.getBoundingClientRect().height > 120)`) as boolean && await page.isVisible('#ge-lancer') && await page.isVisible('#ge-prompt'), await page.evaluate(`[...document.querySelectorAll('#ge-candidats img')].map((i) => i.getBoundingClientRect().height)`));
  await page.click('#v-depot');
  await until(`document.querySelector('#il-vignette').style.height !== ''`);
  check(`${label}, Illustrations : vignette lisible, cadrage et droits visibles`, await page.evaluate(`document.querySelector('#il-vignette').getBoundingClientRect().height > 100`) as boolean && await page.isVisible('#il-zoom') && await page.isVisible('#il-droits'), await page.evaluate(`document.querySelector('#il-vignette').getBoundingClientRect().height`));
  await goSub('sujet-apercu');
  await until(`document.querySelector('#sa-echelle').style.transform !== ''`);
  await page.waitForTimeout(50);
  await fits(`${label}, Aperçu du sujet`);
  const sujetPreview = await page.evaluate(previewFit('#sa-cadre', '#sa-echelle')) as { inside: boolean; width: number; height: number };
  check(`${label}, Aperçu du sujet : double page entière et lisible`, sujetPreview.inside && sujetPreview.height > 300, sujetPreview);
  await runControl('#sa-controler');
  await fits(`${label}, Aperçu du sujet, contrôles`);
  await page.click('#sujet-retour');
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
await page.route('**/api/parcours', patchJson((view) => {
  view.steps[1].reasons = many('Écart', 12);
  view.steps[1].state = 'alerte';
  const [s] = view.subjects;
  view.subjects = [...view.subjects, ...Array.from({ length: 13 }, (_, i) => ({ ...s, id: `sujet-${i}`, title: `Sujet au titre assez long numéro ${i}` }))];
  for (const subject of view.subjects) subject.steps[1].reasons = many('Motif', 6);
}));
const longClaims = (view: Record<string, any>) => {
  const [claim] = view.claims;
  view.claims = Array.from({ length: 40 }, (_, i) => ({ ...claim, id: `c${i}`, sources: [...claim.sources, ...claim.sources] }));
  const [block] = view.subject.blocks;
  view.subject.blocks = [...view.subject.blocks, ...Array.from({ length: 20 }, (_, i) => ({ ...block, id: `bloc-${i}`, claims: Array.from({ length: 8 }, (_c, j) => `c${j}`) }))];
};
await page.route('**/api/sujet/state', patchJson(longClaims));
await page.route('**/api/sujet/check', patchJson((r) => {
  longClaims(r);
  for (const c of r.checks) {
    c.level = 'erreur';
    c.details = many('Détail', 10);
  }
}));
const longRegistry = (view: Record<string, any>) => {
  const [entry] = view.collection;
  view.collection = Array.from({ length: 40 }, (_, i) => ({ ...entry, id: `commun-${i}`, name: `Entrée commune au nom assez long pour remplir sa colonne ${i}`, faults: i % 7 ? [] : ['licence manquante', 'crédit vide'] }));
  view.book = Array.from({ length: 40 }, (_, i) => ({ ...entry, id: `livre-${i}`, name: `Modèle 3D du livre, au nom long ${i}` }));
  view.missing = ['a', 'b'];
};
await page.route('**/api/droits/state', patchJson(longRegistry));
await page.route('**/api/sujet/images', patchJson((view) => {
  const [entry] = view.entries;
  view.entries = Array.from({ length: 40 }, (_, i) => ({ ...entry, id: `m${i}`, kind: i < 30 ? 'modele-3d' : 'modele-ia', name: `Modèle au nom assez long ${i}`, commercialOk: i % 3 ? 'oui' : 'a-verifier' }));
  for (const c of view.checks) {
    c.level = 'erreur';
    c.details = many('Détail', 10);
  }
}));
await page.route('**/api/generer/state', patchJson((view) => {
  view.workflows = { ready: false, reasons: many('Motif', 8) };
  for (const z of view.zones) z.colors = ['red', 'blue', 'green', 'vert', 'rouge'];
}));
await page.route('**/api/workflows/state', patchJson((view) => {
  const [entry] = view.entries;
  view.entries = Array.from({ length: 30 }, (_, i) => ({ ...entry, id: `ia-${i}`, name: `Modèle d'IA au nom assez long ${i}` }));
  view.kinds.generation.rightsFaults = many('Droit', 3);
}));
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
  check('signes : image nommée, texte visible', labels.length === 7 && labels.every(([role, label, text]) => role === 'img' && !!label && !!text), labels);
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
await fake.close();
await new Promise((resolve) => server.close(resolve));
finish('page');
