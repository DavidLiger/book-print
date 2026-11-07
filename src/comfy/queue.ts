// src/comfy/queue.ts — file d'attente des tâches de ComfyUI, en mémoire dans le serveur (IC1, question 9). Une seule tâche tourne à la fois : la
// mémoire vidéo est au bord de la limite (P-14). Les générations passent avant les agrandissements, parce que chaque alternance recharge les
// modèles (255 s, §11.1). Une tâche en attente s'annule ; une tâche envoyée à ComfyUI va à son terme. Un redémarrage de l'outil perd la file.

export type TaskKind = 'generation' | 'agrandissement';

export class QueueRefused extends Error {}
export class TaskCancelled extends Error {}

export interface TaskContext {
  /** Étape affichée dans la page et le bandeau. */
  progress(text: string): void;
  /** Vrai si David a annulé la tâche avant son premier envoi à ComfyUI. */
  cancelled(): boolean;
  /** Premier envoi à ComfyUI : la tâche ne s'annule plus. */
  sent(): void;
}

export interface TaskSpec {
  kind: TaskKind;
  /** `<bookId>/<sujetId>/<zone>` : une tâche de chaque type par zone à la fois. */
  zoneKey: string;
  label: string;
  /** Rend le résumé affiché à la fin. */
  run(ctx: TaskContext): Promise<string>;
}

export interface TaskView {
  id: number;
  kind: TaskKind;
  zoneKey: string;
  label: string;
  step: string;
  /** Date de début, `null` en attente. */
  startedAt: number | null;
  sent: boolean;
}
export interface DoneView {
  id: number;
  kind: TaskKind;
  zoneKey: string;
  label: string;
  outcome: 'reussie' | 'echouee' | 'annulee';
  message: string;
  seconds: number;
  endedAt: number;
}
export interface QueueSnapshot {
  current: TaskView | null;
  pending: TaskView[];
  /** Dernières tâches finies, la plus récente en tête. */
  recent: DoneView[];
}

interface Entry {
  view: TaskView;
  spec: TaskSpec;
  cancelled: boolean;
}

const RECENT = 10;

export class TaskQueue {
  private current: Entry | null = null;
  private pending: Entry[] = [];
  private recent: DoneView[] = [];
  private nextId = 1;
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly now: () => number = Date.now) {}

  add(spec: TaskSpec): TaskView {
    const busy = [this.current, ...this.pending].find((e) => e && e.spec.zoneKey === spec.zoneKey && e.spec.kind === spec.kind);
    if (busy) throw new QueueRefused(`${spec.kind === 'generation' ? 'Une génération' : 'Un agrandissement'} de cette zone est déjà dans la file.`);
    const entry: Entry = { view: { id: this.nextId++, kind: spec.kind, zoneKey: spec.zoneKey, label: spec.label, step: 'en attente', startedAt: null, sent: false }, spec, cancelled: false };
    // Les générations avant les agrandissements : une génération ajoutée passe devant le premier agrandissement en attente.
    const at = spec.kind === 'generation' ? this.pending.findIndex((e) => e.spec.kind === 'agrandissement') : -1;
    if (at < 0) this.pending.push(entry);
    else this.pending.splice(at, 0, entry);
    this.pump();
    return { ...entry.view };
  }

  cancel(id: number): void {
    const at = this.pending.findIndex((e) => e.view.id === id);
    if (at >= 0) {
      const [entry] = this.pending.splice(at, 1);
      this.finish(entry!, 'annulee', 'annulée avant son envoi', 0);
      return;
    }
    if (this.current?.view.id === id) {
      if (this.current.view.sent) throw new QueueRefused('Cette tâche est déjà envoyée à ComfyUI : elle va à son terme.');
      this.current.cancelled = true;
      return;
    }
    throw new QueueRefused('Tâche inconnue : déjà finie, ou perdue au redémarrage de l\'outil.');
  }

  snapshot(): QueueSnapshot {
    return { current: this.current ? { ...this.current.view } : null, pending: this.pending.map((e) => ({ ...e.view })), recent: this.recent.map((d) => ({ ...d })) };
  }

  busy(zoneKey: string): TaskKind[] {
    return [this.current, ...this.pending].filter((e): e is Entry => !!e && e.spec.zoneKey === zoneKey).map((e) => e.spec.kind);
  }

  /** Pour les tests : attend que la file soit vide. */
  async idle(): Promise<void> {
    while (this.current || this.pending.length > 0) await this.running;
  }

  private finish(entry: Entry, outcome: DoneView['outcome'], message: string, seconds: number): void {
    const { id, kind, zoneKey, label } = entry.view;
    this.recent.unshift({ id, kind, zoneKey, label, outcome, message, seconds, endedAt: this.now() });
    this.recent.length = Math.min(this.recent.length, RECENT);
  }

  private pump(): void {
    if (this.current || this.pending.length === 0) return;
    const entry = this.pending.shift()!;
    this.current = entry;
    entry.view.startedAt = this.now();
    entry.view.step = 'démarrage';
    const ctx: TaskContext = {
      progress: (text) => { entry.view.step = text; },
      cancelled: () => entry.cancelled,
      sent: () => { entry.view.sent = true; },
    };
    this.running = (async () => {
      const start = this.now();
      try {
        const message = await entry.spec.run(ctx);
        this.finish(entry, 'reussie', message, (this.now() - start) / 1000);
      } catch (e) {
        if (e instanceof TaskCancelled) this.finish(entry, 'annulee', e.message, (this.now() - start) / 1000);
        else this.finish(entry, 'echouee', e instanceof Error ? e.message : String(e), (this.now() - start) / 1000);
      } finally {
        this.current = null;
        this.pump();
      }
    })();
  }
}
