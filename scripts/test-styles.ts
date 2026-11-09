// scripts/test-styles.ts — bibliothèque de styles (IC2) : schéma, style de base, composition du graphe, contournement de l'IP-Adapter, référence,
// droits, style par zone et par défaut, cohérence du livre, aperçus et planche, routes. Faux ComfyUI d'IC1, fixtures synthétiques seulement.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { decodeRgb } from '../src/comfy/colors';
import { transferColors } from '../src/comfy/lab';
import { keepImageChunks } from '../src/images/png';
import { saveStyle } from '../src/styles/files';
import { readCandidates } from '../src/comfy/files';
import { TaskQueue } from '../src/comfy/queue';
import { PREVIEW_SEED } from '../src/comfy/run';
import { applyFields, graphFaults, reachable, REFERENCE_BYPASS, sha256, withoutReference, type Graph } from '../src/comfy/workflow';
import { depositWorkflow, readWorkflows } from '../src/comfy/workflow-file';
import { createCollection } from '../src/data/collection';
import { createBookFolder, DATA_GITIGNORE } from '../src/data/create-book';
import { createSubject, readSubject } from '../src/data/subject-file';
import { readFacts } from '../src/parcours/facts';
import { STEPS } from '../src/parcours/steps';
import { readBookRights, readCollectionRights } from '../src/rights/registry';
import type { Subject } from '../src/schema/subject';
import { createPrintServer } from '../src/server/app';
import { createComfyRuntime } from '../src/server/comfy-actions';
import { baseStyle, composePrompt, generationFields, generationGraph as styleGraph } from '../src/styles/graph';
import { coherenceAlerts, imageStyles } from '../src/styles/library';
import { readStyles } from '../src/styles/read';
import { styleIdSchema, styleSchema, type Style } from '../src/styles/schema';
import { generationGraph, upscaleGraph } from './fixtures/workflows';
import { startFakeComfy } from './fixtures/fake-comfy';
import { BOOK_DIR, BOOK_ID, dirLink, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { makePng } from './fixtures/make-png';
import { check, finish } from './test-lib';

const json = (v: unknown) => JSON.stringify(v);
const refused = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const diffInputs = (a: Graph, b: Graph): string[] => {
  const out: string[] = [];
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    for (const k of new Set([...Object.keys(a[id]?.inputs ?? {}), ...Object.keys(b[id]?.inputs ?? {})])) if (json(a[id]?.inputs[k]) !== json(b[id]?.inputs[k])) out.push(`${id}.${k}`);
  }
  return out;
};
const G = () => generationGraph() as unknown as Graph;
const U = () => upscaleGraph() as unknown as Graph;

// Schéma (question 1)
const base = baseStyle(G(), U(), 'niedot294a', 'reference.png');
{
  check('schéma : le style de base est valide', styleSchema.safeParse(base).success);
  const bad: [string, (s: Record<string, any>) => void][] = [
    ['nom vide', (s) => { s.name = '  '; }],
    ['nom trop long', (s) => { s.name = 'x'.repeat(81); }],
    ['description trop longue', (s) => { s.description = 'x'.repeat(501); }],
    ['prompt de style trop long', (s) => { s.prompt = 'x'.repeat(1001); }],
    ['négatif trop long', (s) => { s.negative = 'x'.repeat(2001); }],
    ['débruitage nul', (s) => { s.denoise = 0; }],
    ['débruitage au-delà de 1', (s) => { s.denoise = 1.01; }],
    ['poids négatif', (s) => { s.ipAdapterWeight = -0.1; }],
    ['poids au-delà de 2', (s) => { s.ipAdapterWeight = 2.1; }],
    ['profondeur au-delà de 2', (s) => { s.controlnet.depth.strength = 2.5; }],
    ['Canny négatif', (s) => { s.controlnet.canny.strength = -1; }],
    ['tile au-delà de 2', (s) => { s.controlnet.tile.strength = 3; }],
    ['début du tile après la fin', (s) => { s.controlnet.tile.start = 0.7; s.controlnet.tile.end = 0.6; }],
    ['début du tile négatif', (s) => { s.controlnet.tile.start = -0.1; }],
    ['fin du tile au-delà de 1', (s) => { s.controlnet.tile.end = 1.2; }],
    ['dosage au-delà de 1', (s) => { s.colorDosage = 1.5; }],
    ['dosage négatif', (s) => { s.colorDosage = -0.1; }],
    ['référence d’un type inconnu', (s) => { s.reference = { type: 'photo' }; }],
    ['dessin sans droit', (s) => { s.reference = { type: 'dessin', file: null, grayscale: false }; }],
    ['référence : autre fichier', (s) => { s.reference.file = 'autre.png'; }],
    ['niveaux de gris : booléen attendu', (s) => { s.reference.grayscale = 'oui'; }],
    ['aucune référence, avec un droit', (s) => { s.reference = { type: 'aucune', rights: 'niedot294a' }; }],
    ['clé inconnue', (s) => { s.couleur = 'rouge'; }],
    ['agrandissement absent', (s) => { delete s.upscale; }],
    ['schemaVersion 2', (s) => { s.schemaVersion = 2; }],
    ['débruitage en texte', (s) => { s.denoise = '0.75'; }],
  ];
  for (const [name, change] of bad) {
    const s = structuredClone(base) as Record<string, any>;
    change(s);
    check(`schéma refusé : ${name}`, !styleSchema.safeParse(s).success, s);
  }
  check('schéma : dosage 0 admis (sans correction)', styleSchema.safeParse({ ...base, colorDosage: 0 }).success);
  check('schéma : aucune référence admise', styleSchema.safeParse({ ...base, reference: { type: 'aucune' } }).success);
  check('identifiant : base admis', styleIdSchema.safeParse('base').success);
  for (const id of ['_essai', 'Crayonne', 'a_b', '', 'x'.repeat(41), '-a']) check(`identifiant refusé : ${id || '(vide)'}`, !styleIdSchema.safeParse(id).success);
}

// Style de base (question 2) et identité du graphe
{
  const g = G();
  const u = U();
  check('style de base : négatif, débruitage et poids du graphe', base.negative === g['7']!.inputs.text && base.denoise === 0.75 && base.ipAdapterWeight === 0.6);
  check('style de base : forces de la profondeur (16), du Canny (17), du tile (26)', base.controlnet.depth.strength === 0.8 && base.controlnet.canny.strength === 0.5 && json(base.controlnet.tile) === json({ strength: 0.35, start: 0, end: 0.6 }));
  check('style de base : prompts de l’agrandissement du second graphe', base.upscale.prompt === u['6']!.inputs.text && base.upscale.negative === u['7']!.inputs.text);
  check('style de base : prompt de style vide, dosage 100 %, référence externe niedot294a', base.prompt === '' && base.colorDosage === 1 && json(base.reference) === json({ type: 'externe', rights: 'niedot294a', file: 'reference.png', grayscale: false }));
  const ic1Fields = { '3': { seed: 2397429127 }, '6': { text: 'un animal inventé' }, '9': { filename_prefix: 'book-print/a_z_g1' }, '10': { image: 'r.png' }, '11': { image: 'm.png' } };
  const ic1 = applyFields(g, 'generation', ic1Fields);
  const run = { seed: 2397429127, zonePrompt: 'un animal inventé', renduName: 'r.png', mistName: 'm.png', prefix: 'book-print/a_z_g1' };
  const sameName = styleGraph(g, base, { ...run, referenceName: String(g['22']!.inputs.image) }).graph;
  check('identité : style de base, même nom de référence, graphe identique à celui d’IC1', json(sameName) === json(ic1), diffInputs(ic1, sameName));
  const renamed = styleGraph(g, base, { ...run, referenceName: 'bookprint_style_base.png' }).graph;
  check('identité : seul le nom de la référence change avec le dépôt du style', diffInputs(ic1, renamed).join() === '22.image', diffInputs(ic1, renamed));
}

// Composition (question 3)
{
  const crayon: Style = { ...base, prompt: '  pencil sketch, graphite ', negative: 'color, paint', denoise: 0.6, ipAdapterWeight: 0.9, controlnet: { depth: { strength: 0.7 }, canny: { strength: 0.9 }, tile: { strength: 0.2, start: 0.1, end: 0.5 } } };
  check('prompt : zone, puis le prompt de style, séparés par « , »', composePrompt('a raptor', crayon) === 'a raptor, pencil sketch, graphite');
  check('prompt : style vide, prompt de la zone inchangé', composePrompt('a raptor ', base) === 'a raptor ' && composePrompt('a raptor', { ...base, prompt: '   ' }) === 'a raptor');
  const { graph, fields } = styleGraph(G(), crayon, { seed: 7, zonePrompt: 'a raptor', renduName: 'r', mistName: 'm', referenceName: 'ref.png', prefix: 'p' });
  check('composition : négatif, débruitage, poids, forces et bornes du tile écrits', graph['7']!.inputs.text === 'color, paint' && graph['3']!.inputs.denoise === 0.6 && graph['24']!.inputs.weight === 0.9 && graph['16']!.inputs.strength === 0.7 && graph['17']!.inputs.strength === 0.9 && graph['26']!.inputs.strength === 0.2 && graph['26']!.inputs.start_percent === 0.1 && graph['26']!.inputs.end_percent === 0.5 && graph['22']!.inputs.image === 'ref.png');
  check('composition : chaque champ écrit est tracé', json(Object.keys(fields).sort()) === json(['10', '11', '16', '17', '22', '24', '26', '3', '6', '7', '9']));
  check('composition : les liens ne changent pas avec une référence', diffInputs(G(), graph).every((k) => !['3.model', '3.positive', '24.model', '16.image'].includes(k)));
}

// Contournement de l'IP-Adapter (question 4)
{
  const g = G();
  const before = reachable(g, '9');
  check('graphe d’IL1 : les nœuds 22 à 24 mènent à la sortie', ['22', '23', '24'].every((id) => before.has(id)));
  const off = withoutReference(g);
  check('contournement : seul le lien model du nœud 3 change, vers l’entrée du nœud 23', diffInputs(g, off).join() === '3.model' && json(off['3']!.inputs.model) === json(['4', 0]));
  const after = reachable(off, '9');
  check('contournement : aucun chemin de la sortie vers 22, 23 ni 24', REFERENCE_BYPASS.skipped.every((id) => !after.has(id)), [...after]);
  check('contournement : tout le reste tourne comme avant', [...before].filter((id) => !['22', '23', '24'].includes(id)).every((id) => after.has(id)) && after.size === before.size - 3);
  check('contournement : l’original reste intact', json(g['3']!.inputs.model) === json(['24', 0]));
  const noRef: Style = { ...base, reference: { type: 'aucune' } };
  const { graph, fields } = styleGraph(g, noRef, { seed: 7, zonePrompt: 'a', renduName: 'r', mistName: 'm', referenceName: null, prefix: 'p' });
  check('style sans référence : ni le nœud 22 ni le 24 ne sont écrits', !('22' in fields) && !('24' in fields) && graph['22']!.inputs.image === g['22']!.inputs.image && graph['24']!.inputs.weight === g['24']!.inputs.weight);
  check('style sans référence : liens identiques au graphe contourné', diffInputs(withoutReference(applyFields(g, 'generation', generationFields(noRef, { seed: 7, zonePrompt: 'a', renduName: 'r', mistName: 'm', referenceName: null, prefix: 'p' }))), graph).length === 0);
  const relinked = G();
  relinked['3']!.inputs.model = ['23', 0];
  check('dépôt : nœud 3 relié ailleurs qu’au 24, refus nommé', graphFaults(relinked, 'generation').some((f) => f.includes('nœud 3') && f.includes('model') && f.includes('nœud 24')), graphFaults(relinked, 'generation'));
  const ip = G();
  ip['24']!.inputs.model = ['4', 0];
  check('dépôt : IP-Adapter non alimenté par le nœud 23, refus', graphFaults(ip, 'generation').some((f) => f.includes('nœud 24') && f.includes('nœud 23')));
  const no23 = G();
  delete no23['23'];
  check('dépôt : chargeur 23 absent, refus nommé', graphFaults(no23, 'generation').some((f) => f.includes('nœud 23') && f.includes('absent')));
  const no16 = G();
  no16['16']!.class_type = 'ControlNetApply';
  check('dépôt : nœud 16 d’un autre type, refus nommé', graphFaults(no16, 'generation').some((f) => f.includes('nœud 16') && f.includes('profondeur')));
  const up = U();
  up['32']!.inputs.positive = ['31', 0];
  check('dépôt : agrandissement dont le positif ne vient pas du nœud 6, refus', graphFaults(up, 'agrandissement').some((f) => f.includes('nœud 32') && f.includes('positive')));
}

// Cohérence (question 7), règles pures
{
  const subjectWith = (id: string, images: { zone: string; style?: { id: string; sha256: string }; generated: boolean }[]) => ({
    id, illustrations: images.map((i) => ({ zone: i.zone, file: '', width: 1, height: 1, framing: { focusX: 0.5, focusY: 0.5, zoom: 1 }, ...(i.generated ? { generation: { style: i.style } } : {}) })),
  }) as unknown as Subject;
  const styles = [
    { id: 'base', state: 'ok', style: { ...base }, sha256: 'a'.repeat(64), reference: null, faults: [] },
    { id: 'crayonne', state: 'ok', style: { ...base, name: 'Crayonné' }, sha256: 'b'.repeat(64), reference: null, faults: [] },
  ] as never[];
  const ic1Only = imageStyles([subjectWith('raptor', [{ zone: 'illustration', generated: true }])]);
  check('image d’IC1 sans style : comptée dans le style de base', ic1Only.length === 1 && ic1Only[0]!.styleId === 'base' && ic1Only[0]!.assumed);
  check('image déposée à la main : hors de la règle', imageStyles([subjectWith('raptor', [{ zone: 'illustration', generated: false }])]).length === 0);
  check('un seul style : aucune alerte', coherenceAlerts([...ic1Only, ...imageStyles([subjectWith('b', [{ zone: 'illustration', style: { id: 'base', sha256: 'a'.repeat(64) }, generated: true }])])], styles).length === 0);
  const mixed = coherenceAlerts(imageStyles([subjectWith('raptor', [{ zone: 'illustration', generated: true }]), subjectWith('compso', [{ zone: 'illustration', style: { id: 'crayonne', sha256: 'b'.repeat(64) }, generated: true }])]), styles);
  check('deux styles : alerte qui nomme les zones et les styles', mixed.length === 1 && mixed[0]!.includes('raptor/illustration') && mixed[0]!.includes('compso/illustration') && mixed[0]!.includes('Crayonné'), mixed);
  const old = coherenceAlerts(imageStyles([subjectWith('raptor', [{ zone: 'illustration', style: { id: 'crayonne', sha256: 'c'.repeat(64) }, generated: true }])]), styles);
  check('style modifié depuis l’image : alerte à part', old.length === 1 && old[0]!.includes('version antérieure'), old);
  const gone = coherenceAlerts(imageStyles([subjectWith('raptor', [{ zone: 'illustration', style: { id: 'aquarelle', sha256: 'c'.repeat(64) }, generated: true }])]), styles);
  check('style disparu : alerte', gone.some((a) => a.includes('absent de la bibliothèque')), gone);
}

// File : les aperçus passent en dernier (question 8)
{
  const q = new TaskQueue();
  const gate: (() => void)[] = [];
  const task = (kind: 'generation' | 'agrandissement' | 'apercu', key: string) => ({ kind, zoneKey: key, label: `${kind} ${key}`, run: () => new Promise<string>((r) => gate.push(() => r('ok'))) });
  q.add(task('generation', 'z0'));
  q.add(task('apercu', 'styles/a'));
  q.add(task('agrandissement', 'z1'));
  q.add(task('generation', 'z2'));
  q.add(task('apercu', 'styles/b'));
  check('file : générations, agrandissements, puis aperçus', q.snapshot().pending.map((t) => t.label).join() === 'generation z2,agrandissement z1,apercu styles/a,apercu styles/b', q.snapshot().pending.map((t) => t.label));
  check('file : un aperçu par style à la fois', refused(() => q.add(task('apercu', 'styles/a'))));
  while (gate.length > 0 || q.snapshot().current) {
    gate.shift()?.();
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Données, workflows, faux ComfyUI, serveur
const glbRoot = makeGlbi();
const parent = tempDir();
const dataRoot = path.join(parent, 'donnees');
fs.mkdirSync(dataRoot);
createBookFolder(dataRoot, BOOK_ID);
createCollection(dataRoot);
createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, ['alpha', 'beta'], ['foret']);
const NOW = new Date('2026-11-08T10:00:00Z');
depositWorkflow(dataRoot, BOOK_ID, 'generation', JSON.stringify(generationGraph()), NOW);
depositWorkflow(dataRoot, BOOK_ID, 'agrandissement', JSON.stringify(upscaleGraph()), NOW);
const fake = await startFakeComfy();
put(parent, 'config.local.json', { glbRoot, dataRoot, comfyUrl: fake.url });
let nextSeed = 4242;
const runtime = createComfyRuntime({ historyPollMs: 5, busyPollMs: 5, maxWaitMs: 60_000 }, () => nextSeed++);
const server = createPrintServer(path.join(parent, 'config.local.json'), runtime);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const ORIGIN = `http://127.0.0.1:${port}`;

interface Reply { status: number; json: Record<string, any>; bytes: Buffer }
function request(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        let value: Record<string, any> = {};
        try { value = JSON.parse(bytes.toString('utf8')); } catch { /* binaire */ }
        resolve({ status: res.statusCode ?? 0, json: value, bytes });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const headers = { 'Content-Type': 'application/json', 'x-book-print': '1', Origin: ORIGIN };
const post = (route: string, body: unknown) => request({ path: route, headers, body: JSON.stringify(body) });
const binary = (route: string, query: Record<string, string>, body: Buffer, type = 'image/png') => request({ path: `${route}?${new URLSearchParams({ dir: BOOK_DIR, ...query })}`, headers: { ...headers, 'Content-Type': type }, body });
const idle = () => runtime.queue.idle();
const stylesDir = path.join(dataRoot, 'collection', 'styles');
const styleFile = (id: string) => path.join(stylesDir, id, 'style.json');
const readStyle = (id: string) => JSON.parse(fs.readFileSync(styleFile(id), 'utf8'));
const stylesStep = () => STEPS.find((s) => s.id === 'styles')!.evaluate(readFacts({ ok: true, config: { glbRoot, dataRoot } }, BOOK_DIR));
const subject = (id = 'alpha') => readSubject(dataRoot, BOOK_ID, id);
const toInput = (s: Style): Record<string, any> => {
  const { schemaVersion: _v, reference, ...rest } = s;
  return { ...rest, reference: reference.type === 'aucune' ? { type: 'aucune' } : reference.type === 'dessin' ? { type: 'dessin', grayscale: reference.grayscale } : { type: 'externe', rights: reference.rights, grayscale: reference.grayscale } };
};
const rendu = makePng(832, 1216, 3, (x, y) => [x % 256, y % 256, 90]);
const mist = makePng(832, 1216, 3, (_x, y) => [y % 256, y % 256, y % 256]);

// Style de base par la route, sans écrasement
{
  const st0 = await post('/api/styles/state', { dir: BOOK_DIR });
  check('état : aucun style, style de base proposé', st0.status === 200 && st0.json.styles.length === 0 && st0.json.canCreateBase === true, st0.json);
  check('parcours : Styles à faire sans style', stylesStep().state === 'a-faire' && stylesStep().reasons[0]!.includes('style de base'));
  const created = await post('/api/styles/base', { dir: BOOK_DIR });
  check('style de base : créé depuis les workflows', created.status === 200 && created.json.created === 'base' && created.json.reference === 'reference-essai.png', created.json);
  const ref = fs.readFileSync(path.join(stylesDir, 'base', 'reference.png'));
  check('style de base : référence relue par /view, rangée octet pour octet', ref.equals(fake.uploads.get('reference-essai.png')!) && fake.calls.includes('GET /view'));
  check('style de base : valeurs du graphe dans style.json', json(readStyle('base')) === json({ ...base, reference: { ...base.reference, file: 'reference.png' } }), readStyle('base'));
  const shaBefore = sha256(fs.readFileSync(styleFile('base')));
  const again = await post('/api/styles/base', { dir: BOOK_DIR });
  check('style de base : second clic refusé, rien d’écrasé', again.status === 409 && again.json.error.includes('existe déjà') && sha256(fs.readFileSync(styleFile('base'))) === shaBefore);
  check('parcours : style par défaut à choisir', stylesStep().state === 'a-faire' && stylesStep().reasons[0]!.includes('par défaut'));
  check('route : style par défaut inconnu, refus', (await post('/api/styles/defaut', { dir: BOOK_DIR, styleId: 'aquarelle' })).status === 409);
  const def = await post('/api/styles/defaut', { dir: BOOK_DIR, styleId: 'base' });
  const book = JSON.parse(fs.readFileSync(path.join(dataRoot, BOOK_ID, 'print-book.json'), 'utf8'));
  check('style par défaut : écrit dans print-book.json', def.status === 200 && book.defaultStyle === 'base' && def.json.defaultStyle === 'base');
  check('parcours : référence niedot294a à vérifier, alerte qui valide', stylesStep().state === 'alerte' && stylesStep().reasons.join().includes('niedot294a'), stylesStep());
}

// Création, enregistrement, refus
{
  const crayon = { ...toInput(base), name: 'Crayonné', prompt: 'pencil sketch, graphite', negative: 'paint, watercolor', reference: { type: 'aucune' }, upscale: { prompt: 'pencil sketch', negative: 'paint' } };
  check('création : identifiant refusé', (await post('/api/styles/creer', { dir: BOOK_DIR, id: 'Crayonne', style: crayon })).status === 409 && !fs.existsSync(path.join(stylesDir, 'Crayonne')));
  const bad = await post('/api/styles/creer', { dir: BOOK_DIR, id: 'crayonne', style: { ...crayon, denoise: 2 } });
  check('création : valeur refusée, nommée, rien de créé', bad.status === 409 && bad.json.error.includes('débruitage') && !fs.existsSync(path.join(stylesDir, 'crayonne')), bad.json);
  check('création : champ inconnu, 400', (await post('/api/styles/creer', { dir: BOOK_DIR, id: 'crayonne', style: { ...crayon, couleur: 'rouge' } })).status === 400);
  const made = await post('/api/styles/creer', { dir: BOOK_DIR, id: 'crayonne', style: crayon });
  check('création : style sans référence', made.status === 200 && readStyle('crayonne').reference.type === 'aucune' && readStyle('crayonne').prompt === 'pencil sketch, graphite');
  check('création : même identifiant refusé, rien d’écrasé', (await post('/api/styles/creer', { dir: BOOK_DIR, id: 'crayonne', style: { ...crayon, name: 'Autre' } })).status === 409 && readStyle('crayonne').name === 'Crayonné');
  check('création : le style de base refusé par cette route aussi', (await post('/api/styles/creer', { dir: BOOK_DIR, id: 'base', style: crayon })).status === 409);
  const mtime = fs.statSync(styleFile('crayonne')).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await post('/api/styles/enregistrer', { dir: BOOK_DIR, id: 'crayonne', style: crayon });
  check('enregistrement : rien à changer, aucune écriture', fs.statSync(styleFile('crayonne')).mtimeMs === mtime);
  const saved = await post('/api/styles/enregistrer', { dir: BOOK_DIR, id: 'crayonne', style: { ...crayon, prompt: 'pencil sketch, graphite, hatching' } });
  check('enregistrement : prompt modifié', saved.status === 200 && readStyle('crayonne').prompt === 'pencil sketch, graphite, hatching');
  check('enregistrement : style inconnu, refus', (await post('/api/styles/enregistrer', { dir: BOOK_DIR, id: 'aquarelle', style: crayon })).status === 409);

  // Style invalide : affiché avec son erreur, jamais réécrit
  fs.mkdirSync(path.join(stylesDir, 'casse'));
  fs.writeFileSync(styleFile('casse'), '{ "schemaVersion": 1, "name": "Cassé" }');
  const st = await post('/api/styles/state', { dir: BOOK_DIR });
  const casse = st.json.styles.find((s: { id: string }) => s.id === 'casse');
  check('style invalide : affiché, refusé, avec son erreur', casse?.state === 'refuse' && casse.message.includes('invalide'), casse);
  check('style invalide : Styles en erreur', stylesStep().state === 'erreur' && stylesStep().reasons.join().includes('casse'));
  check('style invalide : l’écriture elle-même le refuse aussi', refused(() => saveStyle(dataRoot, 'casse', base)) && fs.readFileSync(styleFile('casse'), 'utf8') === '{ "schemaVersion": 1, "name": "Cassé" }');
  const rewrite = await post('/api/styles/enregistrer', { dir: BOOK_DIR, id: 'casse', style: crayon });
  check('style invalide : jamais réécrit', rewrite.status === 409 && rewrite.json.error.includes('ne le réécrit pas') && fs.readFileSync(styleFile('casse'), 'utf8') === '{ "schemaVersion": 1, "name": "Cassé" }');
  fs.rmSync(path.join(stylesDir, 'casse'), { recursive: true });
  const other = tempDir();
  dirLink(other, path.join(stylesDir, 'lien'));
  const linked = readStyles(dataRoot).find((s) => s.id === 'lien');
  check('style en lien : refusé, rien de lu', linked?.state === 'refuse' && (linked as { message: string }).message.includes('dossier réel'), linked);
  fs.rmSync(path.join(stylesDir, 'lien'), { recursive: true, force: true });
  fs.mkdirSync(path.join(stylesDir, 'Majuscule'));
  check('dossier au nom refusé : un style refusé, pas une panne', readStyles(dataRoot).some((s) => s.id === 'Majuscule' && s.state === 'refuse'));
  fs.rmSync(path.join(stylesDir, 'Majuscule'), { recursive: true });
}

// Référence : dessin de David, externe, dépôt, gris (question 5)
{
  const trait = { ...toInput(base), name: 'Trait', reference: { type: 'dessin', grayscale: true } };
  put(dataRoot, 'collection/rights.json', { ...readCollectionRights(dataRoot), entries: [...readCollectionRights(dataRoot).entries, { id: 'dessin-plume', kind: 'image-reference', name: 'Plume, saisie par David', author: 'D. L.', license: 'perso', credit: 'Plume.', commercialOk: 'oui' }] });
  const made = await post('/api/styles/creer', { dir: BOOK_DIR, id: 'trait', style: trait });
  const entry = readCollectionRights(dataRoot).entries.find((e) => e.id === 'dessin-trait');
  check('dessin : entrée image-reference créée au registre commun, auteur David Liger, usage commercial oui', made.status === 200 && made.json.entry === 'dessin-trait' && entry?.kind === 'image-reference' && entry.author === 'David Liger' && entry.commercialOk === 'oui' && entry.credit !== '' && entry.license !== '', entry);
  check('dessin : droit rattaché au style', readStyle('trait').reference.rights === 'dessin-trait' && readStyle('trait').reference.file === null);
  const plume = await post('/api/styles/creer', { dir: BOOK_DIR, id: 'plume', style: { ...trait, name: 'Plume' } });
  check('dessin : entrée existante gardée telle quelle, sans écrasement', plume.status === 200 && plume.json.entry === null && readCollectionRights(dataRoot).entries.find((e) => e.id === 'dessin-plume')?.name === 'Plume, saisie par David');
  check('dessin sans référence : Styles en erreur, référence à déposer', stylesStep().state === 'erreur' && stylesStep().reasons.some((r) => r.includes('Trait') && r.includes('référence à déposer')), stylesStep());
  check('génération avec un style à corriger : refus', (await post('/api/styles/apercus', { dir: BOOK_DIR, ids: ['trait'] })).status === 409);

  const drawing = makePng(64, 48, 3, (x, y) => [200, (x * 4) % 256, (y * 5) % 256]);
  const deposit = await binary('/api/styles/reference', { id: 'trait' }, drawing);
  check('dépôt de la référence : rangée octet pour octet', deposit.status === 200 && fs.readFileSync(path.join(stylesDir, 'trait', 'reference.png')).equals(drawing) && readStyle('trait').reference.file === 'reference.png', deposit.json);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 7)]);
  const jp = await binary('/api/styles/reference', { id: 'plume' }, jpeg, 'image/jpeg');
  check('dépôt de la référence : JPEG admis, rangé tel quel', jp.status === 200 && fs.readFileSync(path.join(stylesDir, 'plume', 'reference.jpg')).equals(jpeg) && readStyle('plume').reference.file === 'reference.jpg');
  const png2 = await binary('/api/styles/reference', { id: 'plume' }, drawing);
  check('dépôt de la référence : PNG à la place du JPEG, un seul fichier gardé', png2.status === 200 && !fs.existsSync(path.join(stylesDir, 'plume', 'reference.jpg')) && readStyle('plume').reference.file === 'reference.png');
  check('dépôt de la référence : texte refusé', (await binary('/api/styles/reference', { id: 'plume' }, Buffer.from('pas une image'))).status === 409);
  check('dépôt de la référence : JSON refusé, 403', (await request({ path: `/api/styles/reference?dir=${BOOK_DIR}&id=plume`, headers, body: '{}' })).status === 403);
  check('dépôt de la référence : style sans référence, refus', (await binary('/api/styles/reference', { id: 'crayonne' }, drawing)).json.error.includes('pas de référence'));
  check('dépôt de la référence : GET, 405', (await request({ method: 'GET', path: '/api/styles/reference' })).status === 405);
  fs.writeFileSync(path.join(stylesDir, 'plume', 'reference.png'), Buffer.from('abîmé'));
  check('référence abîmée sur le disque : Styles en erreur', stylesStep().state === 'erreur' && stylesStep().reasons.some((r) => r.includes('Plume') && r.includes('PNG')));
  fs.writeFileSync(path.join(stylesDir, 'plume', 'reference.png'), drawing);

  const sdxl = await post('/api/styles/creer', { dir: BOOK_DIR, id: 'faux', style: { ...toInput(base), reference: { type: 'externe', rights: 'sdxl-base-1-0', grayscale: false } } });
  check('externe : une entrée qui n’est pas une image de référence, refusée', sdxl.status === 409 && sdxl.json.error.includes('image de référence'));
  put(dataRoot, 'collection/rights.json', { ...readCollectionRights(dataRoot), entries: [...readCollectionRights(dataRoot).entries, { id: 'planche-non', kind: 'image-reference', name: 'Planche interdite', author: 'X', license: 'NC', credit: 'X.', commercialOk: 'non' }] });
  const no = await post('/api/styles/creer', { dir: BOOK_DIR, id: 'faux', style: { ...toInput(base), reference: { type: 'externe', rights: 'planche-non', grayscale: false } } });
  check('externe : commercialOk non, refusée', no.status === 409 && no.json.error.includes('usage commercial') && !fs.existsSync(path.join(stylesDir, 'faux')));
  check('registre : une entrée à commercialOk non met Droits en erreur, l’étape Styles se verrouille alors', STEPS.find((s) => s.id === 'droits')!.evaluate(readFacts({ ok: true, config: { glbRoot, dataRoot } }, BOOK_DIR)).state === 'erreur');
  put(dataRoot, 'collection/rights.json', { ...readCollectionRights(dataRoot), entries: readCollectionRights(dataRoot).entries.filter((e) => e.id !== 'planche-non') });
}

// Génération : style de base identique à IC1, style sans référence, dessin en gris
{
  const entry = (kind: string, png: Buffer) => request({ path: `/api/sujet/entree?${new URLSearchParams({ dir: BOOK_DIR, subject: 'alpha', zone: 'illustration', kind })}`, headers: { ...headers, 'Content-Type': 'image/png' }, body: png });
  await entry('rendu', rendu);
  await entry('mist', mist);
  const gen0 = await post('/api/generer/state', { dir: BOOK_DIR, subjectId: 'alpha' });
  const z0 = gen0.json.zones[0];
  check('Générer : style par défaut présélectionné, sans choix propre', z0.style.id === 'base' && z0.style.chosen === false && z0.style.reason === null && gen0.json.defaultStyle === 'base' && gen0.json.styles.length === 4, z0.style);

  fake.prompts.length = 0;
  const launched = await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', seed: 2397429127 });
  await idle();
  check('graine imposée : une seule image, de cette graine', launched.status === 200 && fake.prompts.length === 1 && fake.prompts[0]!.graph['3']!.inputs.seed === 2397429127, launched.json);
  const sent = fake.prompts[0]!.graph as unknown as Graph;
  const ic1 = applyFields(G(), 'generation', { '3': { seed: 2397429127 }, '6': { text: String(G()['6']!.inputs.text) }, '9': { filename_prefix: 'book-print/alpha_illustration_g2397429127' }, '10': { image: `bookprint_${BOOK_ID}_alpha_illustration_rendu.png` }, '11': { image: `bookprint_${BOOK_ID}_alpha_illustration_mist.png` } });
  check('style de base : graphe envoyé identique à celui d’IC1, au nom de la référence près', diffInputs(ic1, sent).join() === '22.image' && sent['22']!.inputs.image === 'bookprint_style_base.png', diffInputs(ic1, sent));
  check('style de base : la référence envoyée est celle d’IL1, octet pour octet', fake.uploads.get('bookprint_style_base.png')!.equals(fake.uploads.get('reference-essai.png')!));
  const cand = readCandidates(dataRoot, BOOK_ID, 'alpha', 'illustration')!;
  check('candidats : style, empreinte de style.json, référence tracés', cand.style.id === 'base' && cand.style.sha256 === sha256(fs.readFileSync(styleFile('base'))) && cand.style.rights === 'niedot294a' && cand.inputs.reference?.sha256 === sha256(fake.uploads.get('reference-essai.png')!) && cand.dosage === 1);

  // Style sans référence, choisi pour la zone
  const chosen = await post('/api/generer/style', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', styleId: 'crayonne' });
  check('style de la zone : écrit dans subject.json, statut inchangé', chosen.status === 200 && subject().generationStyles?.illustration === 'crayonne' && chosen.json.zones[0].style.chosen === true && subject().status === 'brouillon');
  check('style de la zone : style inconnu refusé', (await post('/api/generer/style', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', styleId: 'aquarelle' })).status === 409);
  await post('/api/styles/enregistrer', { dir: BOOK_DIR, id: 'crayonne', style: { ...toInput(readStyle('crayonne') as Style), colorDosage: 0.5 } });
  fake.prompts.length = 0;
  const uploadsBefore = [...fake.uploads.keys()].filter((k) => k.startsWith('bookprint_style_crayonne')).length;
  await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration' });
  await idle();
  const noRef = fake.prompts[0]!.graph as unknown as Graph;
  check('sans référence : model du nœud 3 relié au nœud 4, 22 à 24 hors de tout chemin', json(noRef['3']!.inputs.model) === json(['4', 0]) && ['22', '23', '24'].every((id) => !reachable(noRef, '9').has(id)));
  check('sans référence : aucune référence déposée dans ComfyUI', [...fake.uploads.keys()].filter((k) => k.startsWith('bookprint_style_crayonne')).length === uploadsBefore);
  check('sans référence : prompt de zone et de style, négatif du style', noRef['6']!.inputs.text === `${G()['6']!.inputs.text}, pencil sketch, graphite, hatching` && noRef['7']!.inputs.text === 'paint, watercolor');
  const candC = readCandidates(dataRoot, BOOK_ID, 'alpha', 'illustration')!;
  check('sans référence : trois graines, style tracé, référence nulle', candC.candidates.length === 3 && candC.style.id === 'crayonne' && candC.inputs.reference === null && candC.style.rights === null, candC.style);
  const cacheZone = path.join(dataRoot, BOOK_ID, '.cache', 'ic1', 'alpha', 'illustration');
  const seed = candC.candidates[0]!.seed;
  const half = transferColors(await decodeRgb(fs.readFileSync(path.join(cacheZone, `g${seed}.png`))), await decodeRgb(rendu), 0.5);
  check('dosage du style : correction à 50 %, tracée', candC.dosage === 0.5 && Buffer.from((await decodeRgb(fs.readFileSync(path.join(cacheZone, `c${seed}.png`)))).data).equals(Buffer.from(half.data)));
  fake.prompts.length = 0;
  await post('/api/generer/agrandir', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', seed });
  await idle();
  const up = fake.prompts[0]!.graph as unknown as Graph;
  check('agrandissement : prompts de l’agrandissement du style', up['6']!.inputs.text === 'pencil sketch' && up['7']!.inputs.text === 'paint' && diffInputs(U(), up).join() === '6.text,7.text,10.image,32.seed,34.width,34.height,34.crop,35.filename_prefix', diffInputs(U(), up));
  const trace = subject().illustrations[0]!.generation!;
  check('traçabilité : style et empreinte de style.json, référence nulle', trace.style?.id === 'crayonne' && trace.style.sha256 === sha256(fs.readFileSync(styleFile('crayonne'))) && trace.inputs.reference === null && trace.fields.agrandissement['6']!.text === 'pencil sketch');
  const rights = readBookRights(dataRoot, BOOK_ID).illustrations[0]!.rights;
  check('droits : workflows seulement, aucune référence', rights.join() === 'sdxl-base-1-0,controlnet-union-promax,ip-adapter-plus-sdxl-vit-h,clip-vit-h-14,realesrgan-x4plus', rights);

  // Ancien workflows.json d'IC1, avec niedot294a coché : ignoré, sans réécriture
  const index = path.join(dataRoot, 'collection', 'workflows', 'workflows.json');
  const old = JSON.parse(fs.readFileSync(index, 'utf8'));
  old.generation.rights.push('niedot294a');
  fs.writeFileSync(index, `${JSON.stringify(old, null, 2)}\n`);
  const indexBytes = fs.readFileSync(index);
  const w = readWorkflows(dataRoot, BOOK_ID).generation as { state: string; ignored: string[]; rightsFaults: string[] };
  check('ancien workflows.json : image-reference ignoré, sans faute', w.state === 'ok' && w.ignored.join() === 'niedot294a' && w.rightsFaults.length === 0, w);
  const wfView = await post('/api/workflows/state', { dir: BOOK_DIR });
  check('ancien workflows.json : la page le nomme, Workflows reste validé', wfView.json.kinds.generation.ignored.join() === 'niedot294a' && !wfView.json.kinds.generation.rights.includes('niedot294a') && STEPS.find((s) => s.id === 'workflows')!.evaluate(readFacts({ ok: true, config: { glbRoot, dataRoot } }, BOOK_DIR)).state === 'validee');
  fake.prompts.length = 0;
  await post('/api/generer/agrandir', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', seed: candC.candidates[1]!.seed, confirm: true });
  await idle();
  check('ancien workflows.json : l’image ne reçoit plus la référence du workflow', !readBookRights(dataRoot, BOOK_ID).illustrations[0]!.rights.includes('niedot294a'));
  check('ancien workflows.json : jamais réécrit sans action de David', fs.readFileSync(index).equals(indexBytes));

  // Dessin de David, en niveaux de gris
  await post('/api/styles/enregistrer', { dir: BOOK_DIR, id: 'trait', style: { ...toInput(readStyle('trait') as Style), colorDosage: 0 } });
  await post('/api/generer/style', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', styleId: 'trait' });
  fake.prompts.length = 0;
  await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', seed: 12 });
  await idle();
  const gray = fake.uploads.get('bookprint_style_trait_gris.png');
  const decoded = gray && await decodeRgb(gray);
  const isGray = !!decoded && [...Array(decoded.width * decoded.height).keys()].every((p) => decoded.data[3 * p] === decoded.data[3 * p + 1] && decoded.data[3 * p + 1] === decoded.data[3 * p + 2]);
  check('gris : copie convertie envoyée, l’original reste dans le style', isGray && fs.readFileSync(path.join(stylesDir, 'trait', 'reference.png')).equals(makePng(64, 48, 3, (x, y) => [200, (x * 4) % 256, (y * 5) % 256])) && fake.prompts[0]!.graph['22']!.inputs.image === 'bookprint_style_trait_gris.png');
  const candT = readCandidates(dataRoot, BOOK_ID, 'alpha', 'illustration')!;
  const cz = path.join(dataRoot, BOOK_ID, '.cache', 'ic1', 'alpha', 'illustration');
  check('dosage 0 : sans correction, l’image générée sans ses métadonnées', candT.dosage === 0 && fs.readFileSync(path.join(cz, 'c12.png')).equals(keepImageChunks(fs.readFileSync(path.join(cz, 'g12.png')))));
  check('gris : empreinte des octets envoyés tracée', candT.inputs.reference?.sha256 === sha256(gray!) && candT.style.rights === 'dessin-trait');
  await post('/api/generer/agrandir', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', seed: 12, confirm: true });
  await idle();
  const rightsT = readBookRights(dataRoot, BOOK_ID).illustrations[0]!.rights;
  check('droits : la référence vient du style', rightsT.includes('dessin-trait') && !rightsT.includes('niedot294a'), rightsT);
  const images = await post('/api/sujet/images', { dir: BOOK_DIR, subjectId: 'alpha' });
  const c11 = images.json.checks.find((x: { id: string }) => x.id === 'C11');
  check('C11 : sans erreur avec la référence du dessin', c11.level !== 'erreur', c11);

  const reset = await post('/api/generer/style', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', styleId: null });
  check('retour au style par défaut : le choix de la zone disparaît', reset.status === 200 && subject().generationStyles === undefined && reset.json.zones[0].style.id === 'base');
  const noDefault = await post('/api/styles/defaut', { dir: BOOK_DIR, styleId: null });
  check('sans style par défaut : Générer le dit et refuse', noDefault.status === 200 && (await post('/api/generer/state', { dir: BOOK_DIR, subjectId: 'alpha' })).json.zones[0].style.reason.includes('style par défaut') && (await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration' })).status === 409);
  await post('/api/styles/defaut', { dir: BOOK_DIR, styleId: 'base' });
}

// Cohérence du livre, sur le disque
{
  createSubject(dataRoot, BOOK_ID, { sceneId: 'beta', pages: 2, template: '2A', theme: 'foret' }, ['alpha', 'beta'], ['foret']);
  const entryB = (kind: string, png: Buffer) => request({ path: `/api/sujet/entree?${new URLSearchParams({ dir: BOOK_DIR, subject: 'beta', zone: 'illustration', kind })}`, headers: { ...headers, 'Content-Type': 'image/png' }, body: png });
  await entryB('rendu', rendu);
  await entryB('mist', mist);
  await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'beta', zone: 'illustration', seed: 5 });
  await idle();
  await post('/api/generer/agrandir', { dir: BOOK_DIR, subjectId: 'beta', zone: 'illustration', seed: 5 });
  await idle();
  const mixed = stylesStep();
  check('mélange : Styles en alerte, zones et styles nommés', mixed.state === 'alerte' && mixed.reasons.some((r) => r.includes('Plusieurs styles') && r.includes('alpha/illustration') && r.includes('beta/illustration') && r.includes('Trait')), mixed);
  check('mélange : Sujets reste ouvert', STEPS.find((s) => s.id === 'sujets')!.requires.join() === 'gabarits');
  const sj = JSON.parse(fs.readFileSync(path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'subject.json'), 'utf8'));
  sj.generationStyles = { illustration: 'aquarelle' };
  fs.writeFileSync(path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'subject.json'), JSON.stringify(sj));
  check('style de zone inconnu : Styles en erreur, zone nommée', stylesStep().state === 'erreur' && stylesStep().reasons.some((r) => r.includes('alpha/illustration') && r.includes('aquarelle')));
  delete sj.generationStyles;
  delete sj.illustrations[0].generation.style;
  fs.writeFileSync(path.join(dataRoot, BOOK_ID, 'subjects', 'alpha', 'subject.json'), JSON.stringify(sj));
  const ic1 = stylesStep();
  check('image d’IC1 sans style : comptée dans le style de base, aucun mélange avec une image du style de base', ic1.state === 'alerte' && !ic1.reasons.some((r) => r.includes('Plusieurs styles')), ic1);
}

// Aperçus et planche (question 8)
{
  check('planche : sans rendu d’essai, refus qui dit quoi déposer', (await post('/api/styles/apercus', { dir: BOOK_DIR })).json.error.includes('rendu d\'essai'));
  check('essai : mauvaise taille refusée, taille dite', (await binary('/api/styles/essai', { kind: 'rendu' }, makePng(1152, 896, 3, () => [1, 2, 3]))).json.error.includes('832 × 1216'));
  check('essai : JPEG refusé, 403', (await binary('/api/styles/essai', { kind: 'rendu' }, rendu, 'image/jpeg')).status === 403);
  check('essai : type inconnu, 400', (await binary('/api/styles/essai', { kind: 'autre' }, rendu)).status === 400);
  const r = await binary('/api/styles/essai', { kind: 'rendu' }, rendu);
  const m = await binary('/api/styles/essai', { kind: 'mist' }, mist);
  check('essai : rendu et Mist gardés tels quels', r.status === 200 && m.status === 200 && fs.readFileSync(path.join(stylesDir, '_essai', 'rendu.png')).equals(rendu) && m.json.essai.inputs.mist.state === 'ok');
  check('essai : le dossier _essai n’est pas un style', !readStyles(dataRoot).some((s) => s.id === '_essai'));
  check('essai : aucun temporaire laissé', fs.readdirSync(path.join(dataRoot, 'collection', '.cache')).every((f) => !f.endsWith('.tmp')));
  fake.prompts.length = 0;
  const planche = await post('/api/styles/apercus', { dir: BOOK_DIR });
  check('planche : tous les styles prêts mis en file', planche.status === 200 && planche.json.queued.join() === 'base,crayonne,plume,trait', planche.json);
  await idle();
  const cache = path.join(dataRoot, 'collection', '.cache', 'styles');
  const files = () => fs.readdirSync(cache).sort();
  check('aperçus : un fichier par style, sous sa clé', files().length === 4 && files().every((f) => /^[a-z0-9-]+\.[0-9a-f]{16}\.png$/.test(f)), files());
  check('aperçus : graine fixe, rendu d’essai, sans agrandissement', fake.prompts.length === 4 && fake.prompts.every((p) => p.graph['3']!.inputs.seed === PREVIEW_SEED && p.graph['10']!.inputs.image === 'bookprint_style_essai_rendu.png' && !('35' in p.graph)));
  const st = await post('/api/styles/state', { dir: BOOK_DIR });
  check('état : chaque aperçu en cache', st.json.styles.every((s: { preview: { cached: boolean } }) => s.preview?.cached), st.json.styles.map((s: { preview: unknown }) => s.preview));
  const again = await post('/api/styles/apercus', { dir: BOOK_DIR });
  check('planche, seconde fois : tout sort du cache, rien en file', again.json.queued.length === 0 && runtime.queue.snapshot().pending.length === 0);
  const baseKey = st.json.styles.find((s: { id: string }) => s.id === 'base').preview.key;
  const bytes = await request({ method: 'GET', path: `/apercu-style?id=base&key=${baseKey}` });
  check('route /apercu-style : l’aperçu en cache', bytes.status === 200 && bytes.bytes.equals(fs.readFileSync(path.join(cache, `base.${baseKey}.png`))));
  check('route /apercu-style : clé mal formée, 400', (await request({ method: 'GET', path: '/apercu-style?id=base&key=../x' })).status === 400);
  check('route /apercu-style : aperçu absent, 409', (await request({ method: 'GET', path: `/apercu-style?id=crayonne&key=${'0'.repeat(16)}` })).status === 409);
  const mtimes = Object.fromEntries(files().map((f) => [f, fs.statSync(path.join(cache, f)).mtimeMs]));
  const crayon = toInput(readStyle('crayonne') as Style);
  await post('/api/styles/enregistrer', { dir: BOOK_DIR, id: 'crayonne', style: { ...crayon, prompt: 'charcoal sketch' } });
  fake.prompts.length = 0;
  const redo = await post('/api/styles/apercus', { dir: BOOK_DIR });
  await idle();
  check('style modifié : seul son aperçu est refait', redo.json.queued.join() === 'crayonne' && fake.prompts.length === 1, redo.json.queued);
  check('style modifié : l’ancien aperçu du style retiré, les autres intacts', files().filter((f) => f.startsWith('crayonne.')).length === 1 && !files().some((f) => mtimes[f] === undefined && !f.startsWith('crayonne.')) && Object.entries(mtimes).filter(([f]) => !f.startsWith('crayonne.')).every(([f, t]) => fs.statSync(path.join(cache, f)).mtimeMs === t));
  check('aperçu d’un style : un seul, à la demande', (await post('/api/styles/apercus', { dir: BOOK_DIR, ids: ['base'] })).json.queued.length === 0);
  await post('/api/styles/essai-prompt', { dir: BOOK_DIR, prompt: 'une autre scène d’essai' });
  const all = await post('/api/styles/apercus', { dir: BOOK_DIR });
  await idle();
  check('prompt d’essai changé : toute la planche est refaite', all.json.queued.length === 4 && files().length === 4);
}

// Lecture seule, dépôt hors git, configuration d'exemple
{
  const code = ['read.ts', 'library.ts', 'graph.ts', 'schema.ts'].map((f) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'styles', f), 'utf8')).join('');
  check('code des styles lu par le parcours : aucune écriture', !/writeFile|appendFile|renameSync|mkdirSync|rmSync|openSync|copyFile|writeAtomic/.test(code));
  check('collection/.cache/ hors git : *\/.cache/ dans le .gitignore des données', DATA_GITIGNORE.includes('*/.cache/'));
  const example = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config.example.json'), 'utf8'));
  check('config.example.json : comfyUrl et comfyLauncher montrés (P-42)', example.comfyUrl === 'http://127.0.0.1:8188' && typeof example.comfyLauncher === 'string' && example.comfyLauncher.endsWith('.bat'), example);
  check('route : corps invalide, 400', (await post('/api/styles/defaut', { dir: BOOK_DIR })).status === 400);
  check('route : sans en-tête, 403', (await request({ path: '/api/styles/state', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{}' })).status === 403);
  check('client : aucune autre route de ComfyUI appelée', fake.calls.every((c) => /^(GET \/system_stats|GET \/queue|POST \/upload\/image|POST \/prompt|GET \/history\/|GET \/view)/.test(c)));
  const glbFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? glbFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  check('GLBInterpreter : rien d’écrit', !glbFiles(glbRoot).some((f) => /styles|bookprint_|\.cache/.test(f)));
}

await new Promise((resolve) => server.close(resolve));
await fake.close();
finish('styles');
