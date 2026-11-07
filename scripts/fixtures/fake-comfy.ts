// scripts/fixtures/fake-comfy.ts — faux ComfyUI pour les tests : un serveur HTTP sur la boucle locale, qui répond aux six routes du client
// (§13.5) et garde ce qu'il reçoit. Il ne calcule rien : une génération rend une image de synthèse de la taille du rendu, tirée de la graine,
// et un agrandissement une image de la taille demandée au nœud 34. Aucun contenu réel.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readPngHeader } from '../../src/images/png';
import { makePng } from './make-png';

export interface FakeComfy {
  url: string;
  /** Graphes reçus par `/prompt`, dans l'ordre. */
  prompts: { id: string; graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> }[];
  uploads: Map<string, Buffer>;
  /** Routes appelées, méthode et chemin sans paramètres. */
  calls: string[];
  /** Tâches « hors de l'outil » vues par `/queue`. */
  busy: number;
  /** La dernière tâche finie reste un instant dans `queue_running`, comme dans ComfyUI. */
  linger: boolean;
  /** Lectures de `/history` avant la fin d'une tâche. */
  steps: number;
  /** Prochaines réponses de `/prompt` : refus de validation ou erreur d'exécution. */
  failPrompt: 'node' | 'execution' | null;
  /** Délai de chaque réponse, en ms. */
  delay: number;
  /** Réponse invalide de `/system_stats`. */
  badStats: boolean;
  /** Image rendue par `/view` d'une autre taille que prévu. */
  wrongSize: boolean;
  close(): Promise<void>;
}

const seedPixels = (seed: number) => (x: number, y: number): [number, number, number] => [(x * 3 + seed) % 256, (y * 5 + seed * 7) % 256, (x + y + seed * 13) % 256];

export async function startFakeComfy(): Promise<FakeComfy> {
  const outputs = new Map<string, Buffer>();
  const done = new Map<string, { remaining: number; node: string; file: string; error: boolean }>();
  let next = 1;
  const fake = { prompts: [], uploads: new Map(), calls: [], busy: 0, linger: false, steps: 1, failPrompt: null, delay: 0, badStats: false, wrongSize: false } as unknown as FakeComfy;
  fake.uploads.set('reference-essai.png', makePng(8, 8, 3, () => [200, 180, 160]));

  const json = (res: http.ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const body = async (req: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    fake.calls.push(`${req.method} ${url.pathname}`);
    if (fake.delay > 0) await new Promise((r) => setTimeout(r, fake.delay));
    if (url.pathname === '/system_stats') return json(res, 200, fake.badStats ? { system: {} } : { system: { comfyui_version: '0.43.0', os: 'test' }, devices: [] });
    if (url.pathname === '/queue') {
      const last = fake.prompts.at(-1)?.id;
      const lingering = fake.linger && last ? [[0, last, {}, {}, []]] : [];
      return json(res, 200, { queue_running: [...Array.from({ length: fake.busy }, () => ['x']), ...lingering], queue_pending: [] });
    }
    if (url.pathname === '/upload/image' && req.method === 'POST') {
      const form = await new Response(new Uint8Array(await body(req)), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData();
      const file = form.get('image') as File;
      if (form.get('type') !== 'input' || form.get('overwrite') !== 'true') return json(res, 400, { error: 'type ou overwrite' });
      fake.uploads.set(file.name, Buffer.from(await file.arrayBuffer()));
      return json(res, 200, { name: file.name, subfolder: '', type: 'input' });
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      const { prompt } = JSON.parse((await body(req)).toString('utf8'));
      if (fake.failPrompt === 'node') {
        fake.failPrompt = null;
        return json(res, 400, { error: { message: 'Prompt outputs failed validation', details: '' }, node_errors: { '10': { class_type: 'LoadImage', errors: [{ message: 'Invalid image file', details: 'image: absent.png' }] } } });
      }
      const id = `essai-${next++}`;
      fake.prompts.push({ id, graph: prompt });
      const isUpscale = '35' in prompt;
      const node = isUpscale ? '35' : '9';
      let width: number;
      let height: number;
      if (isUpscale) {
        width = prompt['34'].inputs.width;
        height = prompt['34'].inputs.height;
      } else {
        const header = readPngHeader(fake.uploads.get(prompt['10'].inputs.image) ?? Buffer.alloc(0));
        width = header?.width ?? 8;
        height = header?.height ?? 8;
      }
      if (fake.wrongSize) width += 8;
      const seed = Number(isUpscale ? prompt['32'].inputs.seed : prompt['3'].inputs.seed) % 251;
      const file = `${id}.png`;
      outputs.set(file, makePng(width, height, 3, seedPixels(seed)));
      done.set(id, { remaining: fake.steps, node, file, error: fake.failPrompt === 'execution' });
      fake.failPrompt = null;
      return json(res, 200, { prompt_id: id, number: next, node_errors: {} });
    }
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.slice('/history/'.length);
      const task = done.get(id);
      if (!task) return json(res, 200, {});
      if (task.remaining-- > 0) return json(res, 200, {});
      if (task.error) return json(res, 200, { [id]: { status: { status_str: 'error', completed: false, messages: [['execution_error', { node_id: '3', node_type: 'KSampler', exception_message: 'Allocation on device' }]] }, outputs: {} } });
      return json(res, 200, { [id]: { status: { status_str: 'success', completed: true, messages: [] }, outputs: { [task.node]: { images: [{ filename: task.file, subfolder: 'book-print', type: 'output' }] } } } });
    }
    if (url.pathname === '/view') {
      const name = url.searchParams.get('filename') ?? '';
      const type = url.searchParams.get('type');
      const bytes = type === 'input' ? fake.uploads.get(name) : outputs.get(name);
      if (!bytes) return json(res, 404, { error: 'absent' });
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(bytes);
    }
    json(res, 404, { error: 'route inconnue' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return fake;
}
