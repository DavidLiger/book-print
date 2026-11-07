// src/comfy/client.ts — client de l'API locale de ComfyUI (spec §13.5), par `fetch` de Node. Six routes seulement : `/system_stats`, `/queue`,
// `/upload/image`, `/prompt`, `/history/{id}` et `/view`. Chaque appel a son délai, chaque réponse est validée par zod et sa taille bornée.
// Aucun nom de fichier venu de ComfyUI ne sert de chemin local : ces noms ne repartent que vers ComfyUI, en paramètres de `/view`.
import { z } from 'zod';
import { MAX_INPUT_PIXELS, MAX_UPLOAD_BYTES } from '../images/clean';
import { readPngHeader } from '../images/png';
import type { Graph } from './workflow';

export class ComfyError extends Error {}

export interface Timeouts {
  /** `/system_stats`, `/queue`, `/history`. */
  short: number;
  /** `/upload/image`, `/prompt`, `/view`. */
  long: number;
}
export const DEFAULT_TIMEOUTS: Timeouts = { short: 10_000, long: 60_000 };

/** Une réponse JSON de ComfyUI reste petite : l'historique d'une tâche porte son graphe, quelques Ko. */
const MAX_JSON_BYTES = 4 * 1024 * 1024;

const statsSchema = z.looseObject({ system: z.looseObject({ comfyui_version: z.string() }) });
const queueSchema = z.looseObject({ queue_running: z.array(z.unknown()), queue_pending: z.array(z.unknown()) });
const uploadSchema = z.looseObject({ name: z.string().min(1), subfolder: z.string().optional(), type: z.string().optional() });
const promptSchema = z.looseObject({ prompt_id: z.string().min(1) });
const imageRefSchema = z.looseObject({ filename: z.string().min(1), subfolder: z.string(), type: z.enum(['output', 'temp', 'input']) });
const historyEntrySchema = z.looseObject({
  status: z.looseObject({ status_str: z.string().optional(), completed: z.boolean().optional(), messages: z.array(z.unknown()).optional() }).optional(),
  outputs: z.record(z.string(), z.looseObject({ images: z.array(imageRefSchema).optional() })),
});
const historySchema = z.record(z.string(), historyEntrySchema);
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type ImageRef = z.infer<typeof imageRefSchema>;

export interface ImageFile {
  png: Buffer;
  width: number;
  height: number;
}

const seconds = (ms: number) => `${String(Math.round(ms / 100) / 10).replace('.', ',')} s`;

export class ComfyClient {
  constructor(readonly origin: string, readonly timeouts: Timeouts = DEFAULT_TIMEOUTS) {}

  private async request(route: string, init: RequestInit, timeoutMs: number, maxBytes: number): Promise<{ status: number; body: Buffer }> {
    let res: Response;
    try {
      res = await fetch(`${this.origin}${route}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new ComfyError(`ComfyUI n'a pas répondu en ${seconds(timeoutMs)} (${route.split('?')[0]}).`);
      if (err.cause?.code === 'ECONNREFUSED') throw new ComfyError(`ComfyUI ne répond pas à ${this.origin} : lancer run_il0.bat, puis réessayer.`);
      throw new ComfyError(`ComfyUI injoignable à ${this.origin} (${err.cause?.code ?? (err.cause as Error | undefined)?.message ?? err.message}) : vérifier qu'il est lancé.`);
    }
    if (res.status >= 300 && res.status < 400) throw new ComfyError(`ComfyUI répond par une redirection (${res.status}) sur ${route.split('?')[0]} : refusée.`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      await res.body?.cancel();
      throw new ComfyError(`Réponse de ComfyUI trop grosse sur ${route.split('?')[0]} : ${maxBytes} octets au plus.`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body ?? []) {
        size += chunk.length;
        if (size > maxBytes) throw new ComfyError(`Réponse de ComfyUI trop grosse sur ${route.split('?')[0]} : ${maxBytes} octets au plus.`);
        chunks.push(Buffer.from(chunk));
      }
    } catch (e) {
      if (e instanceof ComfyError) throw e;
      const err = e as Error;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new ComfyError(`ComfyUI n'a pas répondu en ${seconds(timeoutMs)} (${route.split('?')[0]}).`);
      throw new ComfyError(`Réponse de ComfyUI interrompue : ${err.message}.`);
    }
    return { status: res.status, body: Buffer.concat(chunks) };
  }

  private async json<T extends z.ZodType>(route: string, init: RequestInit, timeoutMs: number, schema: T): Promise<z.infer<T>> {
    const { status, body } = await this.request(route, init, timeoutMs, MAX_JSON_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      throw new ComfyError(`ComfyUI a répondu ${status} sur ${route.split('?')[0]}, sans JSON lisible.`);
    }
    if (status !== 200) throw new ComfyError(`ComfyUI a refusé ${route.split('?')[0]} (${status}) : ${errorText(value)}`);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ComfyError(`Réponse inattendue de ComfyUI sur ${route.split('?')[0]} : ${parsed.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ')}.`);
    return parsed.data;
  }

  async systemStats(): Promise<{ version: string }> {
    const stats = await this.json('/system_stats', {}, this.timeouts.short, statsSchema);
    return { version: stats.system.comfyui_version };
  }

  /** Tâches en cours et en attente dans ComfyUI, y compris celles lancées à la main. `ids` : leurs identifiants, quand ComfyUI les donne. */
  async queue(): Promise<{ running: number; pending: number; ids: string[] }> {
    const q = await this.json('/queue', {}, this.timeouts.short, queueSchema);
    const idOf = (item: unknown) => (Array.isArray(item) && typeof item[1] === 'string' ? [item[1]] : []);
    return { running: q.queue_running.length, pending: q.queue_pending.length, ids: [...q.queue_running, ...q.queue_pending].flatMap(idOf) };
  }

  /** Dépôt dans le dossier d'entrée de ComfyUI, à plat. Rend le nom à citer dans le graphe. */
  async upload(name: string, png: Buffer): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), name);
    form.append('overwrite', 'true');
    form.append('type', 'input');
    const r = await this.json('/upload/image', { method: 'POST', body: form }, this.timeouts.long, uploadSchema);
    return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  }

  async prompt(graph: Graph, clientId: string): Promise<string> {
    const body = JSON.stringify({ prompt: graph, client_id: clientId });
    const r = await this.json('/prompt', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }, this.timeouts.long, promptSchema);
    return r.prompt_id;
  }

  /** `null` : la tâche n'est pas encore finie. */
  async history(promptId: string): Promise<HistoryEntry | null> {
    if (!/^[A-Za-z0-9-]+$/.test(promptId)) throw new ComfyError(`Identifiant de tâche refusé : ${promptId}.`);
    const h = await this.json(`/history/${promptId}`, {}, this.timeouts.short, historySchema);
    return h[promptId] ?? null;
  }

  /** Un PNG de ComfyUI, borné comme un dépôt de MP4 : taille du fichier, signature, nombre de pixels. */
  async view(ref: ImageRef): Promise<ImageFile> {
    const query = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
    const { status, body } = await this.request(`/view?${query}`, {}, this.timeouts.long, MAX_UPLOAD_BYTES);
    if (status !== 200) throw new ComfyError(`ComfyUI ne donne pas l'image ${ref.filename} (${status}).`);
    const header = readPngHeader(body);
    if (!header) throw new ComfyError(`ComfyUI a rendu autre chose qu'un PNG pour ${ref.filename}.`);
    if (header.width * header.height > MAX_INPUT_PIXELS) throw new ComfyError(`Image de ComfyUI trop grande : ${header.width} × ${header.height} px.`);
    return { png: body, width: header.width, height: header.height };
  }
}

/** Message de refus de ComfyUI : `/prompt` répond 400 avec `error.message` et `node_errors`. */
export function errorText(value: unknown): string {
  const v = value as { error?: { message?: string; details?: string } | string; node_errors?: Record<string, { errors?: { message?: string; details?: string }[]; class_type?: string }> };
  const parts: string[] = [];
  if (typeof v?.error === 'string') parts.push(v.error);
  else if (v?.error?.message) parts.push(v.error.message + (v.error.details ? ` (${v.error.details})` : ''));
  for (const [id, node] of Object.entries(v?.node_errors ?? {})) {
    for (const e of node.errors ?? []) parts.push(`nœud ${id}${node.class_type ? ` (${node.class_type})` : ''} : ${e.message ?? ''}${e.details ? `, ${e.details}` : ''}`);
  }
  return parts.join(' ; ').slice(0, 600) || 'sans détail';
}

/** Erreur d'exécution lue dans l'historique : le message d'exception de ComfyUI, s'il y en a un. */
export function executionError(entry: HistoryEntry): string | null {
  if (entry.status?.status_str !== 'error') return null;
  for (const m of entry.status.messages ?? []) {
    if (Array.isArray(m) && m[0] === 'execution_error') {
      const d = m[1] as { node_id?: string; node_type?: string; exception_message?: string };
      return `ComfyUI : erreur au nœud ${d?.node_id ?? '?'}${d?.node_type ? ` (${d.node_type})` : ''} : ${String(d?.exception_message ?? '').trim().slice(0, 400)}`;
    }
  }
  return 'ComfyUI : la tâche a échoué, sans message.';
}
