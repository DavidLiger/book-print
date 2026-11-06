// src/parcours/steps.ts — registre des étapes et calcul du parcours (spec §5.3). Fonctions pures : l'état vient des faits lus par
// `facts.ts`, jamais d'un fichier d'état. Chaque lot qui ajoute un écran ajoute ici une entrée. `scope: 'sujet'` attend MP3 : le calcul
// le connaît, la page ne l'affiche pas encore.

export type Scope = 'livre' | 'sujet';
/** État propre d'une étape. `verrouillee` n'en est pas un : il vient de `requires`. */
export type OwnState = 'a-faire' | 'validee' | 'alerte' | 'erreur';
export type StepState = OwnState | 'verrouillee';

export interface ParcoursFacts {
  /** Message de configuration, `null` si elle est correcte. */
  configError: string | null;
  /** Lecture de GLBInterpreter, `null` si aucun livre n'est choisi. */
  book: { bookId: string | null; errors: string[]; alerts: string[] } | null;
  folder: { exists: boolean; error: string | null; printBook: 'ok' | 'absent' | 'invalide'; printBookError: string | null };
  pricing: { error: string | null; retained: boolean; retainedErrors: string[]; deviation: string[]; bookAlert: string | null };
  collection: { exists: boolean; error: string | null };
  essai: {
    /** Le livre et la collection ne se rendent pas : l'export est impossible. */
    renderError: string | null;
    control: { dateMs: number; errors: string[]; alerts: string[] } | null;
    controlError: string | null;
    styleMs: number | null;
    printBookMs: number | null;
  };
}

export interface StepVerdict {
  state: OwnState;
  /** `a-faire` seulement : un travail déjà fait, à reprendre. */
  redo?: boolean;
  reasons: string[];
}

export interface StepDef {
  id: string;
  label: string;
  scope: Scope;
  /** Étapes à valider avant d'ouvrir celle-ci, toutes plus haut dans le registre. */
  requires: string[];
  evaluate(facts: ParcoursFacts): StepVerdict;
}

export interface ComputedStep {
  id: string;
  label: string;
  scope: Scope;
  number: number;
  state: StepState;
  stateLabel: string;
  reasons: string[];
}

export interface Parcours {
  steps: ComputedStep[];
  /** Étape à ouvrir : la première non validée, sinon la dernière. */
  open: string;
}

const count = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

function livre(f: ParcoursFacts): StepVerdict {
  if (f.configError) return { state: 'erreur', reasons: [f.configError] };
  if (!f.book) return { state: 'a-faire', reasons: ['Choisir un livre.'] };
  if (f.book.errors.length > 0) return { state: 'erreur', reasons: [`${count(f.book.errors.length, 'erreur')} de lecture de GLBInterpreter.`] };
  if (!f.book.bookId) return { state: 'erreur', reasons: ['Lecture de GLBInterpreter sans bookId.'] };
  if (f.folder.error) return { state: 'erreur', reasons: [f.folder.error] };
  if (!f.folder.exists || f.folder.printBook === 'absent') return { state: 'a-faire', reasons: ['Créer le dossier du livre.'] };
  if (f.folder.printBook === 'invalide') return { state: 'erreur', reasons: [f.folder.printBookError ?? 'print-book.json invalide.'] };
  if (f.book.alerts.length > 0) return { state: 'alerte', reasons: [`${count(f.book.alerts.length, 'alerte')} de lecture de GLBInterpreter.`] };
  return { state: 'validee', reasons: [] };
}

function prix({ pricing: p }: ParcoursFacts): StepVerdict {
  if (p.error) return { state: 'erreur', reasons: [p.error] };
  if (!p.retained) return { state: 'a-faire', reasons: ['Retenir un scénario.'] };
  if (p.retainedErrors.length > 0) return { state: 'erreur', reasons: p.retainedErrors.map((e) => `Scénario retenu : ${e}`) };
  const alerts = [...p.deviation, ...(p.bookAlert ? [p.bookAlert] : [])];
  if (alerts.length > 0) return { state: 'alerte', reasons: alerts };
  return { state: 'validee', reasons: [] };
}

function collection({ collection: c }: ParcoursFacts): StepVerdict {
  if (c.error) return { state: 'erreur', reasons: [c.error] };
  if (!c.exists) return { state: 'a-faire', reasons: ['Créer la collection.'] };
  return { state: 'validee', reasons: [] };
}

function essai({ essai: e }: ParcoursFacts): StepVerdict {
  if (e.renderError) return { state: 'erreur', reasons: [e.renderError] };
  if (e.controlError) return { state: 'a-faire', redo: true, reasons: [`${e.controlError} Relancer l'export.`] };
  if (!e.control) return { state: 'a-faire', reasons: ['Exporter le PDF d\'essai.'] };
  const { control } = e;
  const newer = ([['collection/style.json', e.styleMs], ['print-book.json', e.printBookMs]] as const).filter(([, ms]) => ms !== null && ms >= control.dateMs);
  if (newer.length > 0) return { state: 'a-faire', redo: true, reasons: [`${newer.map(([name]) => name).join(' et ')} modifié après le dernier export : relancer l'export.`] };
  if (control.errors.length > 0) return { state: 'erreur', reasons: [`${control.errors.join(', ')} en erreur dans le dernier export.`] };
  if (control.alerts.length > 0) return { state: 'alerte', reasons: [`${control.alerts.join(', ')} en alerte dans le dernier export.`] };
  return { state: 'validee', reasons: [] };
}

export const STEPS: StepDef[] = [
  { id: 'livre', label: 'Livre', scope: 'livre', requires: [], evaluate: livre },
  { id: 'prix', label: 'Prix', scope: 'livre', requires: ['livre'], evaluate: prix },
  { id: 'collection', label: 'Collection', scope: 'livre', requires: ['prix'], evaluate: collection },
  { id: 'essai', label: 'Essai', scope: 'livre', requires: ['collection'], evaluate: essai },
];

const LABELS: Record<StepState, string> = { 'a-faire': 'à faire', validee: 'validée', alerte: 'alerte', erreur: 'erreur', verrouillee: 'verrouillée' };

/** Une alerte n'empêche pas d'avancer : seule une erreur ou un travail à faire retient la suite. */
export const isValidated = (state: StepState) => state === 'validee' || state === 'alerte';

export function computeParcours(facts: ParcoursFacts, steps: StepDef[] = STEPS): Parcours {
  const computed = new Map<string, ComputedStep>();
  /** Étape à valider d'abord : la première de la chaîne, celle sur laquelle David peut agir. */
  const blockers = new Map<string, StepDef>();
  const numbers: Record<Scope, number> = { livre: 0, sujet: 0 };
  for (const def of steps) {
    const number = ++numbers[def.scope];
    const blockedBy = def.requires.find((id) => !computed.has(id) || !isValidated(computed.get(id)!.state));
    const { label, scope, id } = def;
    if (blockedBy !== undefined) {
      const first = blockers.get(blockedBy) ?? steps.find((s) => s.id === blockedBy);
      if (first) blockers.set(id, first);
      computed.set(id, { id, label, scope, number, state: 'verrouillee', stateLabel: LABELS.verrouillee, reasons: [`Valider d'abord « ${first?.label ?? blockedBy} ».`] });
      continue;
    }
    const verdict = def.evaluate(facts);
    computed.set(id, { id, label, scope, number, state: verdict.state, stateLabel: verdict.redo ? 'à refaire' : LABELS[verdict.state], reasons: verdict.reasons });
  }
  const list = [...computed.values()];
  const shown = list.filter((s) => s.scope === 'livre');
  const open = (shown.find((s) => !isValidated(s.state)) ?? shown[shown.length - 1])?.id ?? '';
  return { steps: list, open };
}
