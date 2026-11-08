// scripts/test-comfy.ts — pilotage de ComfyUI (IC1) : adresse, client, workflows, entrées, correction Lab, taille de sortie, file d'attente,
// rangement et routes. Un faux ComfyUI répond aux six routes et garde ce qu'il reçoit (`fixtures/fake-comfy.ts`). Fixtures synthétiques.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { DEFAULT_COMFY_URL, parseComfyUrl } from '../src/comfy/address';
import { ComfyClient, ComfyError } from '../src/comfy/client';
import { decodeRgb } from '../src/comfy/colors';
import { candidatesSchema, readCandidates } from '../src/comfy/files';
import { boxBlur, labToRgb, rgbToLab, transferColors } from '../src/comfy/lab';
import { checkLauncher, launchCommand } from '../src/comfy/launcher';
import { colorWords } from '../src/comfy/prompt';
import { QueueRefused, TaskQueue, type TaskContext } from '../src/comfy/queue';
import { OUTPUT_MARGIN, outputPixels, renderSize, zoneKind } from '../src/comfy/size';
import { applyFields, graphFaults, sha256, WorkflowRefused } from '../src/comfy/workflow';
import { depositWorkflow, readWorkflows, setWorkflowRights, workflowsReady } from '../src/comfy/workflow-file';
import { createCollection } from '../src/data/collection';
import { createBookFolder } from '../src/data/create-book';
import { createSubject, readSubject } from '../src/data/subject-file';
import { effectivePpi, targetPixels, visibleCrop } from '../src/images/crop';
import { pngChunks, readPngHeader } from '../src/images/png';
import { readFacts } from '../src/parcours/facts';
import { STEPS } from '../src/parcours/steps';
import { readBookRights } from '../src/rights/registry';
import { createPrintServer } from '../src/server/app';
import { createComfyRuntime, LAUNCH_GUARD_MS } from '../src/server/comfy-actions';
import { generationGraph, upscaleGraph } from './fixtures/workflows';
import { startFakeComfy } from './fixtures/fake-comfy';
import { BOOK_DIR, BOOK_ID, makeGlbi, put, tempDir } from './fixtures/make-glbi';
import { makePng } from './fixtures/make-png';
import { check, finish } from './test-lib';

const MM = 25.4;
const json = (v: unknown) => JSON.stringify(v);

// Adresse (question 1)
{
  check('adresse : défaut 127.0.0.1:8188', json(parseComfyUrl(undefined)) === json({ ok: true, origin: DEFAULT_COMFY_URL }));
  check('adresse : 127.0.0.1 et un port admis', json(parseComfyUrl('http://127.0.0.1:8190')) === json({ ok: true, origin: 'http://127.0.0.1:8190' }));
  check('adresse : [::1] admis', json(parseComfyUrl('http://[::1]:8188/')) === json({ ok: true, origin: 'http://[::1]:8188' }));
  check('adresse : port 80 explicite admis', json(parseComfyUrl('http://127.0.0.1:80')) === json({ ok: true, origin: 'http://127.0.0.1:80' }));
  const refused: [string, string][] = [
    ['http://localhost:8188', 'boucle locale'],
    ['http://192.168.1.20:8188', 'boucle locale'],
    ['http://127.0.0.2:8188', 'boucle locale'],
    ['http://comfy.example:8188', 'boucle locale'],
    ['https://127.0.0.1:8188', 'http://'],
    ['http://127.0.0.1', 'port attendu'],
    ['http://127.0.0.1:8188/api', 'chemin'],
    ['http://127.0.0.1:8188/?x=1', 'paramètre'],
    ['http://127.0.0.1:8188/#a', 'paramètre'],
    ['http://user:pw@127.0.0.1:8188', 'identifiant'],
    ['pas une adresse', 'illisible'],
  ];
  for (const [value, why] of refused) {
    const r = parseComfyUrl(value);
    check(`adresse refusée : ${value}`, !r.ok && r.message.includes(why) && r.message.includes('config.local.json'), r);
  }
}

// Client, contre le faux ComfyUI
const fake = await startFakeComfy();
{
  const client = new ComfyClient(fake.url);
  check('client : version lue dans /system_stats', (await client.systemStats()).version === '0.43.0');
  check('client : /queue lue', json(await client.queue()) === json({ running: 0, pending: 0, ids: [] }));
  const stopped = http.createServer();
  await new Promise<void>((r) => stopped.listen(0, '127.0.0.1', r));
  const port = (stopped.address() as AddressInfo).port;
  await new Promise((r) => stopped.close(r));
  const off = await new ComfyClient(`http://127.0.0.1:${port}`).systemStats().then(() => '', (e: Error) => e.message);
  check('client : ComfyUI arrêté, message clair', off.includes('ne répond pas') && off.includes('run_il0.bat'), off);
  fake.badStats = true;
  const bad = await client.systemStats().then(() => '', (e: Error) => e.message);
  fake.badStats = false;
  check('client : réponse invalide refusée par zod', bad.includes('Réponse inattendue') && bad.includes('comfyui_version'), bad);
  fake.delay = 400;
  const slow = await new ComfyClient(fake.url, { short: 100, long: 100 }).systemStats().then(() => '', (e: Error) => e.message);
  fake.delay = 0;
  check('client : délai dépassé', slow.includes('n\'a pas répondu') && slow.includes('0,1 s'), slow);
  fake.failPrompt = 'node';
  const refusedPrompt = await client.prompt(generationGraph() as never, 'essai').then(() => '', (e: Error) => e.message);
  check('client : refus de /prompt nommé, avec le nœud', refusedPrompt.includes('400') && refusedPrompt.includes('nœud 10') && refusedPrompt.includes('Invalid image file'), refusedPrompt);
  check('client : identifiant de tâche refusé avant tout appel', (await client.history('../x').then(() => '', (e: Error) => e.message)).includes('refusé'));
  check('client : image absente, refus', (await client.view({ filename: 'absent.png', subfolder: '', type: 'output' }).then(() => '', (e: Error) => e.message)).includes('404'));
  const name = await client.upload('essai-upload.png', makePng(4, 4, 3, () => [1, 2, 3]));
  check('client : dépôt multipart, nom rendu, type input, overwrite', name === 'essai-upload.png' && fake.uploads.has('essai-upload.png'));
  check('client : seules les routes du §13.5 sont appelées', fake.calls.every((c) => /^(GET \/system_stats|GET \/queue|POST \/upload\/image|POST \/prompt|GET \/history\/|GET \/view)/.test(c)), fake.calls);
}

// Workflows (question 2)
{
  check('graphe de génération synthétique : conforme', graphFaults(generationGraph(), 'generation').length === 0, graphFaults(generationGraph(), 'generation'));
  check('graphe d’agrandissement synthétique : conforme', graphFaults(upscaleGraph(), 'agrandissement').length === 0);
  const no34 = upscaleGraph();
  delete (no34 as Record<string, unknown>)['34'];
  check('nœud 34 retiré : refus nommé', graphFaults(no34, 'agrandissement').some((f) => f.includes('nœud 34 (ImageScale') && f.includes('absent')), graphFaults(no34, 'agrandissement'));
  const other = upscaleGraph();
  other['34']!.class_type = 'ImageScaleBy';
  check('class_type différent : refus nommé', graphFaults(other, 'agrandissement').some((f) => f.includes('ImageScale attendu, ImageScaleBy trouvé')));
  const noField = generationGraph();
  delete noField['3']!.inputs.seed;
  check('champ absent : refus nommé', graphFaults(noField, 'generation').some((f) => f.includes('nœud 3') && f.includes('seed absent')));
  const linked = generationGraph();
  linked['10']!.inputs.image = ['12', 0];
  check('champ relié à un nœud : refus', graphFaults(linked, 'generation').some((f) => f.includes('nœud 10') && f.includes('texte attendu')));
  check('format de l’interface : refus nommé', graphFaults({ nodes: [], links: [] }, 'generation')[0]!.includes('format API'));
  check('JSON vide : refus', graphFaults([], 'generation').length > 0);
  check('génération déposée comme agrandissement : refus', graphFaults(generationGraph(), 'agrandissement').some((f) => f.includes('nœud 32')));

  const original = generationGraph();
  const changed = applyFields(original as never, 'generation', { '3': { seed: 77 }, '6': { text: 'autre' }, '10': { image: 'r.png' } });
  const diff: string[] = [];
  for (const id of Object.keys(original)) for (const k of Object.keys(original[id]!.inputs)) if (json(original[id]!.inputs[k]) !== json(changed[id]!.inputs[k])) diff.push(`${id}.${k}`);
  check('copie : seuls les champs demandés changent', diff.join() === '3.seed,6.text,10.image', diff);
  check('copie : l’original reste intact', original['3']!.inputs.seed === 1);
  check('champ non déclaré : refusé', (() => { try { applyFields(original as never, 'generation', { '3': { steps: 20 } }); return false; } catch (e) { return e instanceof WorkflowRefused; } })());
  check('lien : jamais écrit par applyFields', (() => { try { applyFields(original as never, 'generation', { '3': { model: 'x' } }); return false; } catch (e) { return e instanceof WorkflowRefused; } })());
  check('nœud non contrôlé : refusé', (() => { try { applyFields(original as never, 'generation', { '14': { type: 'tile' } }); return false; } catch (e) { return e instanceof WorkflowRefused; } })());
}

// Données : livre, collection, sujet
const glbRoot = makeGlbi();
const parent = tempDir();
const dataRoot = path.join(parent, 'donnees');
fs.mkdirSync(dataRoot);
createBookFolder(dataRoot, BOOK_ID);
createCollection(dataRoot);
createSubject(dataRoot, BOOK_ID, { sceneId: 'alpha', pages: 2, template: '2A', theme: 'foret' }, ['alpha', 'beta'], ['foret']);
const NOW = new Date('2026-11-07T10:00:00Z');

{
  check('workflows : absents au départ', readWorkflows(dataRoot, BOOK_ID).generation.state === 'absent' && !workflowsReady(readWorkflows(dataRoot, BOOK_ID)).ready);
  const refusedDeposit = (() => { try { depositWorkflow(dataRoot, BOOK_ID, 'agrandissement', JSON.stringify({ '10': upscaleGraph()['10'] }), NOW); return ''; } catch (e) { return (e as Error).message; } })();
  check('dépôt refusé : rien d’écrit', refusedDeposit.includes('nœud 34') && !fs.existsSync(path.join(dataRoot, 'collection', 'workflows', 'workflows.json')), refusedDeposit);
  const content = JSON.stringify(generationGraph(), null, 1);
  const { entry } = depositWorkflow(dataRoot, BOOK_ID, 'generation', content, NOW);
  check('dépôt : fichier daté, tel quel', entry.file === 'generation.2026-11-07T10-00-00Z.json' && fs.readFileSync(path.join(dataRoot, 'collection', 'workflows', entry.file), 'utf8') === content);
  check('dépôt : empreinte SHA-256 du fichier', entry.sha256 === sha256(Buffer.from(content)));
  check('dépôt : droits proposés, présents au registre, sans référence (IC2)', entry.rights.join() === 'sdxl-base-1-0,controlnet-union-promax,ip-adapter-plus-sdxl-vit-h,clip-vit-h-14', entry.rights);
  const again = depositWorkflow(dataRoot, BOOK_ID, 'generation', content, NOW);
  check('second dépôt, même seconde : autre nom, rien d’écrasé', again.entry.file === 'generation.2026-11-07T10-00-00Z-2.json' && again.previous === entry.file && fs.existsSync(path.join(dataRoot, 'collection', 'workflows', entry.file)));
  setWorkflowRights(dataRoot, BOOK_ID, 'generation', ['sdxl-base-1-0']);
  depositWorkflow(dataRoot, BOOK_ID, 'generation', content, new Date('2026-11-07T10:00:05Z'));
  check('nouveau dépôt : droits cochés gardés', (readWorkflows(dataRoot, BOOK_ID).generation as { entry: { rights: string[] } }).entry.rights.join() === 'sdxl-base-1-0');
  setWorkflowRights(dataRoot, BOOK_ID, 'generation', ['sdxl-base-1-0', 'controlnet-union-promax', 'ip-adapter-plus-sdxl-vit-h', 'clip-vit-h-14']);
  const refRight = (() => { try { setWorkflowRights(dataRoot, BOOK_ID, 'generation', ['sdxl-base-1-0', 'niedot294a']); return ''; } catch (e) { return (e as Error).message; } })();
  check('référence de style : refusée sur un workflow (IC2)', refRight.includes('ne porte pas ce type') && refRight.includes('vient du style'), refRight);
  const unknown = (() => { try { setWorkflowRights(dataRoot, BOOK_ID, 'generation', ['inconnu']); return ''; } catch (e) { return (e as Error).message; } })();
  check('droit inconnu : refusé', unknown.includes('inconnu du registre'));
  const font = (() => { try { setWorkflowRights(dataRoot, BOOK_ID, 'generation', ['andika']); return ''; } catch (e) { return (e as Error).message; } })();
  check('police : refusée sur un workflow', font.includes('ne porte pas ce type'));
  const extension = (() => { try { setWorkflowRights(dataRoot, BOOK_ID, 'generation', ['comfyui-ipadapter-plus']); return ''; } catch (e) { return (e as Error).message; } })();
  check('extension : jamais rattachée', extension.includes('ne porte pas ce type'));
  const ready1 = workflowsReady(readWorkflows(dataRoot, BOOK_ID));
  check('génération seule : pas prêt, le motif nomme l’agrandissement', !ready1.ready && ready1.reasons.join().includes('agrandissement'), ready1);
  depositWorkflow(dataRoot, BOOK_ID, 'agrandissement', JSON.stringify(upscaleGraph()), NOW);
  check('les deux : prêts', workflowsReady(readWorkflows(dataRoot, BOOK_ID)).ready);

  // Le verdict propre de l'étape : Prix n'est pas retenu dans ces fixtures, l'étape serait verrouillée par le parcours.
  const wfStep = () => STEPS.find((s) => s.id === 'workflows')!.evaluate(readFacts({ ok: true, config: { glbRoot, dataRoot } }, BOOK_DIR));
  check('parcours : Workflows validée, sans écrire', wfStep().state === 'validee', wfStep());
  const file = path.join(dataRoot, 'collection', 'workflows', (readWorkflows(dataRoot, BOOK_ID).agrandissement as { entry: { file: string } }).entry.file);
  const saved = fs.readFileSync(file);
  fs.writeFileSync(file, saved.toString().replace('lanczos', 'bicubic'));
  check('fichier modifié à la main : refusé, Workflows en erreur', readWorkflows(dataRoot, BOOK_ID).agrandissement.state === 'refuse' && wfStep().state === 'erreur' && wfStep().reasons[0]!.includes('empreinte'), wfStep());
  fs.writeFileSync(file, saved);
  setWorkflowRights(dataRoot, BOOK_ID, 'agrandissement', []);
  check('aucun droit coché : à faire', wfStep().state === 'a-faire' && wfStep().reasons[0]!.includes('Cocher'), wfStep());
  setWorkflowRights(dataRoot, BOOK_ID, 'agrandissement', ['sdxl-base-1-0', 'realesrgan-x4plus']);
  put(dataRoot, 'collection/workflows/workflows.json', '{');
  check('workflows.json illisible : erreur, fichier conservé', wfStep().state === 'erreur' && fs.readFileSync(path.join(dataRoot, 'collection', 'workflows', 'workflows.json'), 'utf8') === '{');
}

// Tailles du §13.2 et taille de sortie (question 6)
{
  const t69 = { widthIn: 6, heightIn: 9 };
  const t811 = { widthIn: 8.5, heightIn: 11 };
  const page69 = { widthMm: 6.125 * MM, heightMm: 9.25 * MM };
  const double69 = { widthMm: 12.25 * MM, heightMm: 9.25 * MM };
  const page811 = { widthMm: 8.625 * MM, heightMm: 11.25 * MM };
  const double811 = { widthMm: 17.25 * MM, heightMm: 11.25 * MM };
  check('6 × 9", page pleine : 832 × 1216', zoneKind(page69, t69) === 'page' && json(renderSize(t69, 'page')) === json({ width: 832, height: 1216 }));
  check('6 × 9", double page : 1152 × 896', zoneKind(double69, t69) === 'double' && json(renderSize(t69, 'double')) === json({ width: 1152, height: 896 }));
  check('8,5 × 11", page pleine : 896 × 1152', zoneKind(page811, t811) === 'page' && json(renderSize(t811, 'page')) === json({ width: 896, height: 1152 }));
  check('8,5 × 11", double page : 1216 × 832', zoneKind(double811, t811) === 'double' && json(renderSize(t811, 'double')) === json({ width: 1216, height: 832 }));
  check('autre zone : ni page ni double page', zoneKind({ widthMm: 60, heightMm: 80 }, t69) === null);
  check('autre format : aucune taille de rendu', renderSize({ widthIn: 7, heightIn: 10 }, 'page') === null);
  check('marge de cadrage : 15 %', OUTPUT_MARGIN === 1.15);
  const sizes: [string, { widthMm: number; heightMm: number }, string][] = [
    ['6 × 9", page', page69, '2114,3192'],
    ['6 × 9", double page', double69, '4227,3192'],
    ['8,5 × 11", page', page811, '2976,3882'],
    ['8,5 × 11", double page', double811, '5952,3882'],
  ];
  for (const [label, zone, want] of sizes) {
    const out = outputPixels(zone);
    const target = targetPixels(zone);
    check(`sortie ${label} : ${want.replace(',', ' × ')}`, `${out.width},${out.height}` === want, out);
    check(`sortie ${label} : rapport de la zone, à un pixel près`, Math.abs(out.width - (out.height * zone.widthMm) / zone.heightMm) < 1, out);
    check(`sortie ${label} : plus grande que la cible de 15 % environ`, out.width / target.width > 1.149 && out.width / target.width < 1.151, [out, target]);
    const crop = (zoom: number) => effectivePpi(visibleCrop(out, zone, { focusX: 0.5, focusY: 0.5, zoom }), zone);
    check(`sortie ${label} : 345 ppp à zoom 1, ≥ 300 jusqu’à 1,15`, crop(1) >= 345 && crop(1.15) >= 300 && crop(1.16) < 300, [crop(1), crop(1.15), crop(1.16)]);
  }
}

// Correction Lab (question 5)
{
  const near = (a: number[], b: number[], eps: number) => a.every((v, i) => Math.abs(v - b[i]!) < eps);
  check('Lab : blanc = 100, 0, 0', near(rgbToLab(1, 1, 1), [100, 0, 0], 1e-3), rgbToLab(1, 1, 1));
  check('Lab : noir = 0, 0, 0', near(rgbToLab(0, 0, 0), [0, 0, 0], 1e-9));
  check('Lab : rouge sRGB = 53,24 ; 80,09 ; 67,20', near(rgbToLab(1, 0, 0), [53.2408, 80.0925, 67.2032], 1e-2), rgbToLab(1, 0, 0));
  check('Lab : bleu sRGB = 32,30 ; 79,19 ; −107,86', near(rgbToLab(0, 0, 1), [32.297, 79.1875, -107.8602], 1e-2), rgbToLab(0, 0, 1));
  check('Lab : gris 50 % = 53,39 ; 0 ; 0', near(rgbToLab(0.5, 0.5, 0.5), [53.3890, 0, 0], 1e-2), rgbToLab(0.5, 0.5, 0.5));
  let worst = 0;
  for (let i = 0; i < 2000; i++) {
    const c = [(i * 37) % 256, (i * 91) % 256, (i * 13) % 256].map((v) => v / 255);
    const back = labToRgb(...rgbToLab(c[0]!, c[1]!, c[2]!));
    worst = Math.max(worst, ...back.map((v, k) => Math.abs(v - c[k]!)));
  }
  check('Lab : aller-retour exact à 1e-9', worst < 1e-9, worst);
  const w = 9;
  const h = 7;
  const flat = boxBlur(new Float64Array(w * h).fill(4.5), w, h, 4);
  check('flou : une image unie reste unie', flat.every((v) => Math.abs(v - 4.5) < 1e-12));
  const impulse = new Float64Array(31 * 31);
  impulse[15 * 31 + 15] = 1;
  const spread = boxBlur(impulse, 31, 31, 4);
  check('flou : masse conservée loin des bords', Math.abs(spread.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  check('flou : symétrique, maximum au centre', Math.abs(spread[15 * 31 + 10]! - spread[15 * 31 + 20]!) < 1e-15 && spread[15 * 31 + 15] === Math.max(...spread));
  check('flou : rayon de 4, trois passes, étendue de 12 pixels', spread[15 * 31 + 3]! > 0 && spread[15 * 31 + 2]! === 0);
  const uniform = (rgb: [number, number, number], width = 16, height = 12) => ({ width, height, data: Uint8Array.from({ length: width * height * 3 }, (_, i) => rgb[i % 3]!) });
  const same = transferColors(uniform([120, 160, 90]), uniform([120, 160, 90]));
  check('image unie : chrominance inchangée, pixels identiques', same.data.every((v, i) => v === uniform([120, 160, 90]).data[i]), [...same.data.slice(0, 3)]);
  const dosed = transferColors(uniform([120, 160, 90]), uniform([200, 30, 30]), 0);
  check('dosage 0 : l’illustration reste à 1 près', dosed.data.every((v, i) => Math.abs(v - uniform([120, 160, 90]).data[i]!) <= 1));
  const red = transferColors(uniform([128, 128, 128]), uniform([200, 30, 30]));
  const [l, a] = rgbToLab(red.data[0]! / 255, red.data[1]! / 255, red.data[2]! / 255);
  check('dosage 1 : luminance de l’illustration, chrominance du rendu', Math.abs(l - rgbToLab(0.502, 0.502, 0.502)[0]) < 1 && a > 40, [l, a]);
  check('tailles différentes : refus', (() => { try { transferColors(uniform([1, 1, 1], 4, 4), uniform([1, 1, 1], 5, 4)); return false; } catch { return true; } })());
  const decoded = await decodeRgb(makePng(3, 2, 4, (x) => [x * 10, 20, 30, 0]));
  check('décodage : alpha retiré sans aplatir, comme convert("RGB")', decoded.width === 3 && decoded.data.length === 18 && decoded.data[3] === 10 && decoded.data[4] === 20);
}

// Couleurs du prompt
check('prompt : couleurs anglaises et françaises relevées', colorWords('A red raptor with golden eyes, plumes vertes, Red').join() === 'red,golden,vertes');
check('prompt : aucune couleur, aucune alerte', colorWords('a velociraptor on a rocky slope, detailed illustration').length === 0);

// File d'attente (question 9)
{
  const queue = new TaskQueue();
  const log: string[] = [];
  const gates = new Map<string, () => void>();
  const task = (kind: 'generation' | 'agrandissement', zoneKey: string, name: string) => ({
    kind, zoneKey, label: name,
    run: (ctx: TaskContext) => new Promise<string>((resolve) => {
      log.push(`début ${name}`);
      ctx.sent();
      gates.set(name, () => { log.push(`fin ${name}`); resolve(`${name} faite`); });
    }),
  });
  queue.add(task('generation', 'b/s/z1', 'g1'));
  queue.add(task('agrandissement', 'b/s/z1', 'a1'));
  queue.add(task('agrandissement', 'b/s/z2', 'a2'));
  queue.add(task('generation', 'b/s/z3', 'g3'));
  const snap = queue.snapshot();
  check('file : une seule tâche en cours', snap.current?.label === 'g1' && log.join() === 'début g1');
  check('file : la génération ajoutée passe avant les agrandissements', snap.pending.map((t) => t.label).join() === 'g3,a1,a2', snap.pending);
  check('file : même zone, même type, refusé', (() => { try { queue.add(task('agrandissement', 'b/s/z1', 'a1bis')); return false; } catch (e) { return e instanceof QueueRefused; } })());
  check('file : tâche envoyée, non annulable', (() => { try { queue.cancel(snap.current!.id); return false; } catch (e) { return e instanceof QueueRefused && e.message.includes('à son terme'); } })());
  queue.cancel(snap.pending.find((t) => t.label === 'a2')!.id);
  check('file : tâche en attente annulée', queue.snapshot().pending.map((t) => t.label).join() === 'g3,a1' && queue.snapshot().recent[0]!.outcome === 'annulee');
  gates.get('g1')!();
  await new Promise((r) => setTimeout(r, 10));
  check('file : la suivante démarre seulement à la fin', log.join() === 'début g1,fin g1,début g3' && queue.snapshot().recent[0]!.outcome === 'reussie');
  gates.get('g3')!();
  await new Promise((r) => setTimeout(r, 10));
  gates.get('a1')!();
  await queue.idle();
  check('file : jamais deux tâches à la fois', log.join() === 'début g1,fin g1,début g3,fin g3,début a1,fin a1', log);
  const failing = new TaskQueue();
  failing.add({ kind: 'generation', zoneKey: 'x', label: 'casse', run: async () => { throw new ComfyError('panne'); } });
  await failing.idle();
  check('file : une tâche en échec garde son message, la file continue', failing.snapshot().recent[0]!.outcome === 'echouee' && failing.snapshot().recent[0]!.message === 'panne' && failing.snapshot().current === null);
}

// Serveur, de bout en bout contre le faux ComfyUI
put(parent, 'config.local.json', { glbRoot, dataRoot, comfyUrl: fake.url });
const seeds = [101, 202, 303, 404, 505, 606, 707, 808, 909];
let seedAt = 0;
const runtime = createComfyRuntime({ historyPollMs: 5, busyPollMs: 5, maxWaitMs: 60_000 }, () => seeds[seedAt++ % seeds.length]!);
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
const entry = (kind: string, png: Buffer, zone = 'illustration') => request({ path: `/api/sujet/entree?${new URLSearchParams({ dir: BOOK_DIR, subject: 'alpha', zone, kind })}`, headers: { ...headers, 'Content-Type': 'image/png' }, body: png });
const idle = () => runtime.queue.idle();
const subject = () => readSubject(dataRoot, BOOK_ID, 'alpha');
const rendu = makePng(832, 1216, 3, (x, y) => [x % 256, y % 256, 90]);
const mist = makePng(832, 1216, 3, (_x, y) => [y % 256, y % 256, y % 256]);

{
  fs.rmSync(path.join(dataRoot, 'collection', 'workflows'), { recursive: true });
  const state0 = await post('/api/comfy/state', { ping: true });
  check('route : état de ComfyUI, version', state0.status === 200 && state0.json.server.ok && state0.json.server.version === '0.43.0' && state0.json.address.url === fake.url, state0.json);
  const wf0 = await post('/api/workflows/state', { dir: BOOK_DIR });
  check('route : workflows absents, nœuds contrôlés listés', wf0.json.kinds.generation.state === 'absent' && wf0.json.checked.agrandissement.includes('34 ImageScale') && wf0.json.checked.generation.includes('16 ControlNetApplyAdvanced') && !wf0.json.entries.some((e: { id: string }) => e.id === 'andika'), wf0.json);
  check('route : référence de style plus proposée sur un workflow (IC2)', !wf0.json.entries.some((e: { id: string }) => e.id === 'niedot294a'), wf0.json.entries);
  const no34 = upscaleGraph();
  delete (no34 as Record<string, unknown>)['34'];
  const refused = await post('/api/workflows/depot', { dir: BOOK_DIR, kind: 'agrandissement', content: JSON.stringify(no34) });
  check('route : nœud 34 retiré, refus nommé', refused.status === 409 && refused.json.error.includes('nœud 34 (ImageScale'), refused.json);
  const genDeposit = await post('/api/workflows/depot', { dir: BOOK_DIR, kind: 'generation', content: JSON.stringify(generationGraph()) });
  const upDeposit = await post('/api/workflows/depot', { dir: BOOK_DIR, kind: 'agrandissement', content: JSON.stringify(upscaleGraph()) });
  check('route : deux workflows déposés, prêts', genDeposit.status === 200 && upDeposit.status === 200 && upDeposit.json.ready.ready, upDeposit.json);
  const big = await post('/api/workflows/depot', { dir: BOOK_DIR, kind: 'generation', content: 'x'.repeat(100 * 1024) });
  check('route : dépôt de workflow jusqu’à 2 Mio, puis refus du contenu', big.status === 409 && big.json.error.includes('JSON invalide'), big.status);

  const gen0 = await post('/api/generer/state', { dir: BOOK_DIR, subjectId: 'alpha' });
  const z0 = gen0.json.zones[0];
  check('vue Générer : page pleine, 832 × 1216 attendus, sortie 2114 × 3192', z0.kind === 'page' && json(z0.render) === json({ width: 832, height: 1216 }) && json(z0.output) === json({ width: 2114, height: 3192 }) && z0.inputs.rendu.state === 'absent', z0);
  check('vue Générer : prompt prérempli depuis le workflow', z0.prompt === generationGraph()['6']!.inputs.text && z0.promptIsDefault && z0.colors.length === 0);
  check('lancer sans entrées : refus', (await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration' })).json.error.includes('Déposer d\'abord le rendu'));
  const wrong = await entry('rendu', makePng(1216, 832, 3, () => [1, 2, 3]));
  check('entrée à une mauvaise taille : refusée, taille attendue dite', wrong.status === 409 && wrong.json.error.includes('1216 × 832') && wrong.json.error.includes('832 × 1216 px attendus'), wrong.json);
  check('entrée refusée : rien de gardé', !fs.existsSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha', 'illustration.rendu.png')) && fs.readdirSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha')).length === 0);
  const fakePng = await entry('mist', Buffer.from('pas un png'));
  check('entrée : faux PNG refusé', fakePng.status === 409 && fakePng.json.error.includes('pas un PNG'));
  const okRendu = await entry('rendu', rendu);
  const okMist = await entry('mist', mist);
  check('entrées gardées telles quelles, sans nettoyage', okRendu.status === 200 && okMist.status === 200 && fs.readFileSync(path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha', 'illustration.rendu.png')).equals(rendu), okRendu.json);
  check('entrées : la vue les montre prêtes', okMist.json.zones[0].inputs.rendu.state === 'ok' && okMist.json.zones[0].inputs.mist.state === 'ok');
  const otherZone = await entry('rendu', rendu, 'titre');
  check('entrée sur une zone qui n’est pas une illustration : refus', otherZone.status === 409 && otherZone.json.error.includes('pas de zone d\'illustration'));

  // IC2 : sans style, rien ne part ; le style de base, créé depuis les workflows, devient le style par défaut.
  const noStyle = await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration' });
  check('Générer sans style : refus qui dit quoi faire', noStyle.status === 409 && noStyle.json.error.includes('style par défaut'), noStyle.json);
  const base = await post('/api/styles/base', { dir: BOOK_DIR });
  const def = await post('/api/styles/defaut', { dir: BOOK_DIR, styleId: 'base' });
  check('style de base créé et choisi par défaut', base.status === 200 && def.status === 200 && def.json.defaultStyle === 'base', [base.json, def.json]);
  const prompt = await post('/api/generer/prompt', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', text: 'an imaginary red animal' });
  check('prompt : enregistré dans le sujet, couleur relevée', subject().generationPrompts?.illustration === 'an imaginary red animal' && prompt.json.zones[0].colors.join() === 'red' && subject().status === 'brouillon');
  await post('/api/generer/prompt', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', text: String(generationGraph()['6']!.inputs.text) });
  check('prompt revenu à celui du workflow : plus de surcharge', subject().generationPrompts === undefined);
  await post('/api/generer/prompt', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', text: 'an imaginary animal, detailed' });

  fake.busy = 1;
  fake.prompts.length = 0;
  const launched = await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration' });
  check('Générer : tâche dans la file', launched.status === 200 && launched.json.task.kind === 'generation', launched.json);
  check('Générer deux fois : refusé tant qu’elle est dans la file', (await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration' })).json.error.includes('déjà dans la file'));
  check('entrée changée pendant une génération : refusée', (await entry('rendu', rendu)).json.error.includes('dans la file'));
  await new Promise((r) => setTimeout(r, 60));
  const waiting = (await post('/api/comfy/state', {})).json.queue.current;
  check('file de ComfyUI non vide : rien n’est envoyé, la tâche attend', fake.prompts.length === 0 && waiting.step.includes('ComfyUI occupé') && !waiting.sent, waiting);
  fake.busy = 0;
  await idle();
  const done = runtime.queue.snapshot().recent[0]!;
  check('génération : réussie, trois graines', done.outcome === 'reussie' && fake.prompts.length === 3 && done.message.includes('101, 202, 303'), done);
  const sent = fake.prompts[0]!.graph;
  const original = generationGraph();
  const diff: string[] = [];
  for (const id of Object.keys(original)) for (const k of Object.keys(original[id]!.inputs)) if (json(original[id]!.inputs[k]) !== json(sent[id]!.inputs[k])) diff.push(`${id}.${k}`);
  check('graphe envoyé : seuls les champs déclarés changent, style de base = graphe d’IC1 au nom de la référence près', diff.join() === '3.seed,6.text,9.filename_prefix,10.image,11.image,22.image' && Object.keys(sent).join() === Object.keys(original).join(), diff);
  check('graphe envoyé : graine, prompt, entrées et sortie', sent['3']!.inputs.seed === 101 && sent['6']!.inputs.text === 'an imaginary animal, detailed' && sent['10']!.inputs.image === `bookprint_${BOOK_ID}_alpha_illustration_rendu.png` && sent['9']!.inputs.filename_prefix === 'book-print/alpha_illustration_g101');
  check('graphe envoyé : référence du style, réglages du fichier repris par le style de base', sent['22']!.inputs.image === 'bookprint_style_base.png' && sent['24']!.inputs.weight === 0.6 && sent['3']!.inputs.denoise === 0.75 && fake.uploads.get('bookprint_style_base.png')!.equals(fake.uploads.get('reference-essai.png')!));
  check('entrées déposées dans ComfyUI telles quelles', fake.uploads.get(`bookprint_${BOOK_ID}_alpha_illustration_rendu.png`)!.equals(rendu) && fake.uploads.get(`bookprint_${BOOK_ID}_alpha_illustration_mist.png`)!.equals(mist));
  const cache = path.join(dataRoot, BOOK_ID, '.cache', 'ic1', 'alpha', 'illustration');
  check('cache : trois générées, trois corrigées, candidats.json', ['c101.png', 'c202.png', 'c303.png', 'candidats.json', 'g101.png', 'g202.png', 'g303.png'].join() === fs.readdirSync(cache).sort().join(), fs.readdirSync(cache));
  const candidates = readCandidates(dataRoot, BOOK_ID, 'alpha', 'illustration')!;
  check('candidats : version, empreintes des entrées et de la référence', candidatesSchema.safeParse(candidates).success && candidates.comfyuiVersion === '0.43.0' && candidates.inputs.rendu === sha256(rendu) && candidates.inputs.reference?.sha256 === sha256(fake.uploads.get('reference-essai.png')!) && candidates.style.id === 'base');
  const g = fs.readFileSync(path.join(cache, 'g202.png'));
  const c = fs.readFileSync(path.join(cache, 'c202.png'));
  const expected = transferColors(await decodeRgb(g), await decodeRgb(rendu));
  check('correction : faite en local, sur l’image générée, à la taille de génération', json(readPngHeader(c)) === json({ width: 832, height: 1216, bitDepth: 8, colorType: 2 }) && Buffer.from((await decodeRgb(c)).data).equals(Buffer.from(expected.data)));
  check('correction : PNG sans métadonnée', pngChunks(c).filter((n) => n !== 'IDAT').join() === 'IHDR,IEND');
  const shown = await request({ method: 'GET', path: `/candidat?${new URLSearchParams({ dir: BOOK_DIR, subject: 'alpha', zone: 'illustration', seed: '202' })}` });
  check('route /candidat : l’image corrigée', shown.status === 200 && shown.bytes.equals(c));
  check('route /candidat : graine inconnue refusée', (await request({ method: 'GET', path: `/candidat?${new URLSearchParams({ dir: BOOK_DIR, subject: 'alpha', zone: 'illustration', seed: '5' })}` })).status === 409);
  check('route /candidat : graine mal formée refusée', (await request({ method: 'GET', path: `/candidat?${new URLSearchParams({ dir: BOOK_DIR, subject: 'alpha', zone: 'illustration', seed: '../x' })}` })).status === 400);

  // Agrandissement
  const rights3d = { id: 'auteur-fictif-foret', kind: 'modele-3d', name: 'Forêt', author: 'Auteur Fictif', license: 'CC BY 4.0', credit: 'Forêt', commercialOk: 'oui' };
  const bookRights = readBookRights(dataRoot, BOOK_ID);
  put(dataRoot, `${BOOK_ID}/rights.json`, { ...bookRights, entries: [rights3d], illustrations: [{ subject: 'alpha', zone: 'illustration', file: 'illustrations/alpha/illustration.png', rights: ['auteur-fictif-foret', 'controlnet-union-promax'], aiGenerated: true }] });
  fake.prompts.length = 0;
  const up = await post('/api/generer/agrandir', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', seed: 202 });
  check('Agrandir : zone vide, aucune confirmation', up.status === 200 && up.json.task.kind === 'agrandissement', up.json);
  await idle();
  const finalDone = runtime.queue.snapshot().recent[0]!;
  check('agrandissement : réussi', finalDone.outcome === 'reussie' && finalDone.message.includes('2114 × 3192'), finalDone);
  const upSent = fake.prompts[0]!.graph;
  const upOriginal = upscaleGraph();
  const upDiff: string[] = [];
  for (const id of Object.keys(upOriginal)) for (const k of Object.keys(upOriginal[id]!.inputs)) if (json(upOriginal[id]!.inputs[k]) !== json(upSent[id]!.inputs[k])) upDiff.push(`${id}.${k}`);
  check('graphe d’agrandissement : seuls les champs déclarés changent', upDiff.join() === '10.image,32.seed,34.width,34.height,34.crop,35.filename_prefix', upDiff);
  check('graphe d’agrandissement : taille de la zone, crop center, même graine', upSent['34']!.inputs.width === 2114 && upSent['34']!.inputs.height === 3192 && upSent['34']!.inputs.crop === 'center' && upSent['32']!.inputs.seed === 202 && upSent['32']!.inputs.denoise === 0.2);
  check('candidat corrigé déposé tel quel', fake.uploads.get(upSent['10']!.inputs.image as string)!.equals(c));
  const final = path.join(dataRoot, BOOK_ID, 'illustrations', 'alpha', 'illustration.png');
  const finalBytes = fs.readFileSync(final);
  check('image finale : nettoyée comme un dépôt de MP4', pngChunks(finalBytes).filter((n) => n !== 'IDAT').join() === 'IHDR,IEND' && json(readPngHeader(finalBytes)) === json({ width: 2114, height: 3192, bitDepth: 8, colorType: 2 }));
  const ill = subject().illustrations[0]!;
  check('sujet : dimensions et cadrage remis à zéro', ill.width === 2114 && ill.height === 3192 && json(ill.framing) === json({ focusX: 0.5, focusY: 0.5, zoom: 1 }));
  const gtrace = ill.generation!;
  check('traçabilité : workflows nommés, datés, empreintes', !!gtrace && gtrace.workflows.generation.sha256 === sha256(Buffer.from(JSON.stringify(generationGraph()))) && gtrace.workflows.agrandissement.file.startsWith('agrandissement.'), gtrace?.workflows);
  check('traçabilité : graine, prompt, champs modifiés, version, dosage', gtrace.seed === 202 && gtrace.prompt === 'an imaginary animal, detailed' && gtrace.fields.generation['3']!.seed === 202 && gtrace.fields.agrandissement['34']!.crop === 'center' && gtrace.comfyuiVersion === '0.43.0' && gtrace.dosage === 1);
  check('traçabilité : empreintes des entrées, de la référence et du candidat', gtrace.inputs.rendu === sha256(rendu) && gtrace.inputs.mist === sha256(mist) && gtrace.inputs.corrected === sha256(c) && gtrace.inputs.generated === sha256(g) && gtrace.inputs.reference?.name === 'bookprint_style_base.png' && gtrace.style?.id === 'base');
  const linked = readBookRights(dataRoot, BOOK_ID).illustrations[0]!.rights;
  check('droits : modèles 3D gardés, ceux des deux workflows et la référence du style rattachés, le reste remplacé', linked.join() === 'auteur-fictif-foret,sdxl-base-1-0,controlnet-union-promax,ip-adapter-plus-sdxl-vit-h,clip-vit-h-14,realesrgan-x4plus,niedot294a', linked);
  check('droits : aucune extension', !linked.some((id) => id.startsWith('comfyui-')));
  const images = await post('/api/sujet/images', { dir: BOOK_DIR, subjectId: 'alpha' });
  const c5 = images.json.checks.find((x: { id: string }) => x.id === 'C5');
  const c11 = images.json.checks.find((x: { id: string }) => x.id === 'C11');
  check('C5 vert à 345 ppp, C11 sans erreur', c5.level === 'ok' && images.json.zones[0].ppi >= 345 && c11.level !== 'erreur', [c5, c11]);
  const zoomed = await post('/api/sujet/cadrage', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', framing: { focusX: 0.5, focusY: 0.5, zoom: 1.15 } });
  check('zoom 1,15 : C5 reste vert', zoomed.json.checks.find((x: { id: string }) => x.id === 'C5').level === 'ok', zoomed.json.zones[0].ppi);
  check('cadrage : la traçabilité reste', subject().illustrations[0]!.generation?.seed === 202);

  const again = await post('/api/generer/agrandir', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', seed: 303 });
  check('Agrandir sur une zone remplie : confirmation, rien dans la file', again.json.needsConfirm === true && runtime.queue.snapshot().pending.length === 0 && runtime.queue.snapshot().current === null);
  check('Agrandir une graine inconnue : refus', (await post('/api/generer/agrandir', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', seed: 1, confirm: true })).json.error.includes('Aucun candidat'));

  // Dépôt manuel : la traçabilité tombe
  const manual = makePng(2114, 3192, 3, () => [10, 20, 30]);
  const deposit = await request({ path: `/api/sujet/illustration?${new URLSearchParams({ dir: BOOK_DIR, subject: 'alpha', zone: 'illustration', confirm: '1' })}`, headers: { ...headers, 'Content-Type': 'image/png' }, body: manual });
  check('dépôt manuel de MP4 : generation effacé, droits gardés', deposit.status === 200 && subject().illustrations[0]!.generation === undefined && readBookRights(dataRoot, BOOK_ID).illustrations[0]!.rights.length === 7);

  // Erreur d'exécution et taille inattendue
  fake.failPrompt = 'execution';
  await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration' });
  await idle();
  const failed = runtime.queue.snapshot().recent[0]!;
  check('erreur de ComfyUI : tâche échouée, message nommé', failed.outcome === 'echouee' && failed.message.includes('KSampler') && failed.message.includes('Allocation on device'), failed);
  fake.wrongSize = true;
  await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration' });
  await idle();
  fake.wrongSize = false;
  check('image générée d’une autre taille : refus', runtime.queue.snapshot().recent[0]!.message.includes('840 × 1216'), runtime.queue.snapshot().recent[0]);
  // Générer, puis Agrandir aussitôt un ancien candidat : il est emporté par la tâche, la génération passe d'abord.
  fake.prompts.length = 0;
  fake.busy = 1;
  await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration' });
  const queued = await post('/api/generer/agrandir', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', seed: 303, confirm: true });
  const order = runtime.queue.snapshot();
  check('deux tâches à la suite : la seconde attend', queued.status === 200 && order.current?.kind === 'generation' && order.pending.map((t) => t.kind).join() === 'agrandissement', [queued.json, order]);
  const old303 = readCandidates(dataRoot, BOOK_ID, 'alpha', 'illustration')?.candidates.find((x) => x.seed === 303)?.corrected;
  check('anciens candidats gardés jusqu’à la première image nouvelle', old303 !== undefined);
  fake.busy = 0;
  await idle();
  const [lastUp, lastGen] = runtime.queue.snapshot().recent;
  check('la génération, puis l’agrandissement de l’ancien candidat', lastGen!.kind === 'generation' && lastGen!.outcome === 'reussie' && lastUp!.kind === 'agrandissement' && lastUp!.outcome === 'reussie' && subject().illustrations[0]!.generation?.seed === 303, [lastGen, lastUp]);
  check('agrandissement : le candidat emporté au lancement, pas un nouveau', subject().illustrations[0]!.generation!.inputs.corrected === old303 && !readCandidates(dataRoot, BOOK_ID, 'alpha', 'illustration')!.candidates.some((x) => x.corrected === old303));
  check('nouvelle entrée : les candidats tombent', (await entry('mist', mist)).status === 200 && readCandidates(dataRoot, BOOK_ID, 'alpha', 'illustration') === null);

  // Une tâche de l'outil restée un instant dans la file de ComfyUI ne la rend pas occupée
  fake.linger = true;
  fake.prompts.length = 0;
  const slowBusy = runtime.deps.busyPollMs;
  runtime.deps.busyPollMs = 20_000;
  const lingerStart = Date.now();
  await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration' });
  await idle();
  runtime.deps.busyPollMs = slowBusy;
  fake.linger = false;
  check('file de ComfyUI : sa propre tâche finie n’est pas une tâche étrangère', runtime.queue.snapshot().recent[0]!.outcome === 'reussie' && Date.now() - lingerStart < 15_000, Date.now() - lingerStart);

  // Annulation d'une tâche en attente
  fake.busy = 1;
  await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration' });
  await new Promise((r) => setTimeout(r, 30));
  const current = (await post('/api/comfy/state', {})).json.queue.current;
  const cancel = await post('/api/comfy/annuler', { id: current.id });
  fake.busy = 0;
  await idle();
  check('annulation avant envoi : la tâche s’arrête sans rien envoyer', cancel.status === 200 && runtime.queue.snapshot().recent[0]!.outcome === 'annulee', runtime.queue.snapshot().recent[0]);
  check('annulation d’une tâche inconnue : refus', (await post('/api/comfy/annuler', { id: 9999 })).status === 409);

  // Adresse refusée dans la configuration
  put(parent, 'config.local.json', { glbRoot, dataRoot, comfyUrl: 'http://localhost:8188' });
  const st = await post('/api/comfy/state', { ping: true });
  check('adresse refusée : dite, aucun appel', st.status === 200 && !st.json.address.ok && st.json.address.error.includes('boucle locale') && st.json.server === null);
  await entry('rendu', rendu);
  check('adresse refusée : Générer refusé', (await post('/api/generer/lancer', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration' })).json.error.includes('boucle locale'));
  put(parent, 'config.local.json', { glbRoot, dataRoot, comfyUrl: fake.url });
}

// Lanceur de ComfyUI (correctif du lanceur)
{
  const bat = path.join(parent, 'lanceur-essai.bat');
  fs.writeFileSync(bat, '@echo off\r\n');
  fs.mkdirSync(path.join(parent, 'dossier.bat'));
  check('lanceur : absent de la configuration', checkLauncher(undefined).state === 'absent');
  check('lanceur : .bat existant admis', json(checkLauncher(bat)) === json({ state: 'ok', file: path.resolve(bat) }));
  check('lanceur : .cmd admis, sans casse', (() => { const f = path.join(parent, 'LANCE.CMD'); fs.writeFileSync(f, ''); return checkLauncher(f).state === 'ok'; })());
  const refusedLauncher: [string, string][] = [
    ['run_il0.bat', 'chemin absolu'],
    [path.join(parent, 'comfy.exe'), '.bat ou .cmd'],
    [path.join(parent, 'a%PATH%.bat'), 'caractère interdit'],
    [path.join(parent, 'a&b.bat'), 'caractère interdit'],
    [path.join(parent, 'absent.bat'), 'introuvable'],
    [path.join(parent, 'dossier.bat'), 'pas un fichier'],
  ];
  for (const [value, why] of refusedLauncher) {
    const l = checkLauncher(value);
    check(`lanceur refusé : ${path.basename(value)}`, l.state === 'refuse' && l.message.includes(why) && l.message.includes('config.local.json'), l);
  }
  check('lanceur : start dans une nouvelle fenêtre, dossier du lanceur, commande entre guillemets', launchCommand('D:/IA/ComfyUI/run_il0.bat').join(' ') === `/d /s /c "start "ComfyUI" /D "${path.dirname('D:/IA/ComfyUI/run_il0.bat')}" "D:/IA/ComfyUI/run_il0.bat""`);

  const launched: string[] = [];
  const realLaunch = runtime.launch;
  runtime.launch = (f) => { launched.push(f); };
  const stopped = http.createServer();
  await new Promise<void>((r) => stopped.listen(0, '127.0.0.1', r));
  const closedUrl = `http://127.0.0.1:${(stopped.address() as AddressInfo).port}`;
  await new Promise((r) => stopped.close(r));
  const noLauncher = await post('/api/comfy/lancer', {});
  check('Lancer : sans lanceur, refus qui dit quoi ajouter', noLauncher.status === 409 && noLauncher.json.error.includes('"comfyLauncher"'), noLauncher.json);
  put(parent, 'config.local.json', { glbRoot, dataRoot, comfyUrl: fake.url, comfyLauncher: bat });
  const up = await post('/api/comfy/lancer', {});
  check('Lancer : ComfyUI répond déjà, rien n’est lancé', up.status === 409 && up.json.error.includes('répond déjà') && launched.length === 0);
  put(parent, 'config.local.json', { glbRoot, dataRoot, comfyUrl: closedUrl, comfyLauncher: bat });
  const st = await post('/api/comfy/state', { ping: true });
  check('état : ComfyUI arrêté, lanceur prêt', st.json.server.ok === false && st.json.launcher.state === 'ok' && st.json.starting === false, st.json);
  const go = await post('/api/comfy/lancer', {});
  check('Lancer : le lanceur de la configuration, une fois', go.status === 200 && launched.join() === path.resolve(bat) && go.json.starting === true, go.json);
  const twice = await post('/api/comfy/lancer', {});
  check('Lancer deux fois de suite : refusé, rien de relancé', twice.status === 409 && twice.json.error.includes('déjà demandé') && launched.length === 1);
  runtime.launchedAt = Date.now() - LAUNCH_GUARD_MS - 1;
  check('Lancer après le délai : admis', (await post('/api/comfy/lancer', {})).status === 200 && launched.length === 2);
  put(parent, 'config.local.json', { glbRoot, dataRoot, comfyUrl: closedUrl, comfyLauncher: 'run_il0.bat' });
  const bad = await post('/api/comfy/state', {});
  check('état : lanceur refusé, dit', bad.json.launcher.state === 'refuse' && bad.json.launcher.message.includes('chemin absolu'));
  check('Lancer : lanceur refusé, rien de lancé', (await post('/api/comfy/lancer', {})).status === 409 && launched.length === 2);
  check('Lancer : corps invalide, 400', (await post('/api/comfy/lancer', { file: bat })).status === 400);
  runtime.launch = realLaunch;
  runtime.launchedAt = null;
  put(parent, 'config.local.json', { glbRoot, dataRoot, comfyUrl: fake.url });
}

// Routes : les refus habituels
{
  check('route : GET d’une action, 405', (await request({ method: 'GET', path: '/api/comfy/state' })).status === 405);
  check('route : sans en-tête, 403', (await request({ path: '/api/generer/state', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{}' })).status === 403);
  check('route : autre origine, 403', (await request({ path: '/api/workflows/state', headers: { ...headers, Origin: 'https://attaque.example' }, body: '{}' })).status === 403);
  check('route : corps invalide, 400', (await post('/api/generer/lancer', { dir: BOOK_DIR })).status === 400);
  check('route : type de workflow inconnu, 400', (await post('/api/workflows/depot', { dir: BOOK_DIR, kind: 'autre', content: '{}' })).status === 400);
  check('route : graine négative, 400', (await post('/api/generer/agrandir', { dir: BOOK_DIR, subjectId: 'alpha', zone: 'illustration', seed: -1 })).status === 400);
  check('route : sujet refusé, 400', (await post('/api/generer/state', { dir: BOOK_DIR, subjectId: '../x' })).status === 400);
  check('entrée : JSON refusé, 403', (await request({ path: `/api/sujet/entree?dir=${BOOK_DIR}&subject=alpha&zone=illustration&kind=rendu`, headers, body: '{}' })).status === 403);
  check('entrée : type inconnu, 400', (await request({ path: `/api/sujet/entree?dir=${BOOK_DIR}&subject=alpha&zone=illustration&kind=autre`, headers: { ...headers, 'Content-Type': 'image/png' }, body: rendu })).status === 400);
  check('entrée : GET, 405', (await request({ method: 'GET', path: '/api/sujet/entree' })).status === 405);
  check('entrée : trop gros annoncé, 413', (await request({ path: `/api/sujet/entree?dir=${BOOK_DIR}&subject=alpha&zone=illustration&kind=rendu`, headers: { ...headers, 'Content-Type': 'image/png', 'Content-Length': String(65 * 1024 * 1024) } }).catch(() => ({ status: 413 }))).status === 413);
  check('/candidat : POST, 405', (await request({ path: '/candidat', headers, body: '{}' })).status === 405);
}

// Aucune écriture hors du dossier de données ; GLBInterpreter intact
{
  const glbFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? glbFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  check('GLBInterpreter : aucun fichier de génération', !glbFiles(glbRoot).some((f) => /bookprint_|candidats|\.rendu\.png|workflows/.test(f)));
  check('client : aucune autre route appelée', fake.calls.every((c) => /^(GET \/system_stats|GET \/queue|POST \/upload\/image|POST \/prompt|GET \/history\/|GET \/view)/.test(c)));
  check('module comfy : aucune adresse en dur hors de la boucle locale', fs.readdirSync('src/comfy').every((f) => !/https?:\/\/(?!127\.0\.0\.1|\[::1\]|\$\{)[a-z0-9]/i.test(fs.readFileSync(path.join('src/comfy', f), 'utf8'))));
}

await new Promise((resolve) => server.close(resolve));
await fake.close();
finish('comfy');
