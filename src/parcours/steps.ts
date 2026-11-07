// src/parcours/steps.ts — registre des étapes et calcul du parcours (spec §5.3). Fonctions pures : l'état vient des faits lus par
// `facts.ts`, jamais d'un fichier d'état. Chaque lot qui ajoute un écran ajoute ici une entrée. Les étapes `scope: 'sujet'` sont calculées
// une fois par sujet, numérotées à part, et n'entrent pas dans l'ouverture du livre.

export type Scope = 'livre' | 'sujet';
/** État propre d'une étape. `verrouillee` n'en est pas un : il vient de `requires`. */
export type OwnState = 'a-faire' | 'validee' | 'alerte' | 'erreur';
export type StepState = OwnState | 'verrouillee';

export interface SubjectFacts {
  id: string;
  title: string;
  /** Sujet illisible : les autres champs ne valent rien. */
  error: string | null;
  status: 'brouillon' | 'relu' | 'prêt' | null;
  pages: number;
  template: string | null;
  theme: string | null;
  research: { state: 'absent' | 'ok' | 'invalide'; error: string | null };
  blocks: { total: number; valide: number; aRelire: number; aReprendre: number };
  claims: { total: number; propose: number };
  illustrations: {
    /** Sujet impossible à poser (gabarit, thème, collection) ou registre illisible. */
    error: string | null;
    zones: number;
    /** Zones sans image. */
    missing: number;
    /** Lignes en erreur : fichier absent ou refusé, C5, C11. */
    errors: string[];
    alerts: string[];
  };
}

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
    /** Le format ou la fiche ont changé depuis l'export. `null` : export d'avant MP3, seule la date de `print-book.json` le dit. */
    bookChanged: boolean | null;
  };
  droits: {
    /** Un registre illisible. */
    error: string | null;
    /** Valeurs par défaut absentes de `collection/rights.json`. */
    missing: number;
    /** Entrées invalides ou à `commercialOk: non`. */
    faults: string[];
    /** Entrées à `a-verifier`. */
    toCheck: string[];
  };
  subjects: SubjectFacts[];
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
  /** `subject` : le sujet évalué, pour une étape `scope: 'sujet'`. */
  evaluate(facts: ParcoursFacts, subject?: SubjectFacts): StepVerdict;
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

export interface ComputedSubject {
  id: string;
  title: string;
  status: SubjectFacts['status'];
  pages: number;
  template: string | null;
  theme: string | null;
  error: string | null;
  steps: ComputedStep[];
  open: string;
}

export interface Parcours {
  /** Étapes du livre. */
  steps: ComputedStep[];
  /** Étape à ouvrir : la première non validée, sinon la dernière. */
  open: string;
  subjects: ComputedSubject[];
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
  const styleNewer = e.styleMs !== null && e.styleMs >= control.dateMs;
  const bookNewer = e.bookChanged ?? (e.printBookMs !== null && e.printBookMs >= control.dateMs);
  const newer = ([['collection/style.json', styleNewer], ['print-book.json', bookNewer]] as const).filter(([, changed]) => changed);
  if (newer.length > 0) return { state: 'a-faire', redo: true, reasons: [`${newer.map(([name]) => name).join(' et ')} modifié après le dernier export : relancer l'export.`] };
  if (control.errors.length > 0) return { state: 'erreur', reasons: [`${control.errors.join(', ')} en erreur dans le dernier export.`] };
  if (control.alerts.length > 0) return { state: 'alerte', reasons: [`${control.alerts.join(', ')} en alerte dans le dernier export.`] };
  return { state: 'validee', reasons: [] };
}

function droits({ droits: d }: ParcoursFacts): StepVerdict {
  if (d.error) return { state: 'erreur', reasons: [d.error] };
  if (d.faults.length > 0) return { state: 'erreur', reasons: d.faults };
  if (d.missing > 0) return { state: 'a-faire', reasons: [`${count(d.missing, 'entrée')} par défaut à ajouter : « Ajouter ce qui manque ».`] };
  if (d.toCheck.length > 0) return { state: 'alerte', reasons: [`À vérifier : ${d.toCheck.join(', ')}.`] };
  return { state: 'validee', reasons: [] };
}

const isRelu = (s: SubjectFacts) => s.status === 'relu' || s.status === 'prêt';

function sujets({ subjects }: ParcoursFacts): StepVerdict {
  const broken = subjects.filter((s) => s.error);
  if (broken.length > 0) return { state: 'erreur', reasons: broken.map((s) => `${s.id} : ${s.error}`) };
  if (subjects.length === 0) return { state: 'a-faire', reasons: ['Créer un premier sujet.'] };
  const left = subjects.filter((s) => !isRelu(s)).length;
  if (left > 0) return { state: 'a-faire', reasons: [`${count(left, 'sujet')} à relire, sur ${subjects.length}.`] };
  return { state: 'validee', reasons: [] };
}

const unreadable = (s: SubjectFacts | undefined): StepVerdict | null => (s?.error ? { state: 'erreur', reasons: [s.error] } : null);

function sujetRecherche(_f: ParcoursFacts, s?: SubjectFacts): StepVerdict {
  const fault = unreadable(s);
  if (fault) return fault;
  if (s?.research.state === 'invalide') return { state: 'erreur', reasons: [s.research.error ?? 'research.json invalide.'] };
  if (s?.research.state !== 'ok') return { state: 'a-faire', reasons: ['Préparer la recherche, puis importer le fichier.'] };
  return { state: 'validee', reasons: [] };
}

function sujetRelecture(_f: ParcoursFacts, s?: SubjectFacts): StepVerdict {
  if (!s || s.blocks.total === 0) return { state: 'a-faire', reasons: ['Importer d\'abord la recherche.'] };
  const { aRelire, aReprendre } = s.blocks;
  if (aRelire + aReprendre === 0) return { state: 'validee', reasons: [] };
  const parts = [...(aRelire ? [`${count(aRelire, 'bloc')} à relire`] : []), ...(aReprendre ? [`${count(aReprendre, 'bloc')} à reprendre`] : [])];
  return { state: 'a-faire', reasons: [`${parts.join(', ')}.`] };
}

function sujetIllustrations(_f: ParcoursFacts, s?: SubjectFacts): StepVerdict {
  if (!s) return { state: 'a-faire', reasons: [] };
  const { error, missing, errors, alerts } = s.illustrations;
  if (error) return { state: 'erreur', reasons: [error] };
  if (errors.length > 0) return { state: 'erreur', reasons: errors };
  if (missing > 0) return { state: 'a-faire', reasons: [`${count(missing, 'zone')} sans image.`] };
  if (alerts.length > 0) return { state: 'alerte', reasons: alerts };
  return { state: 'validee', reasons: [] };
}

function sujetApercu(_f: ParcoursFacts, s?: SubjectFacts): StepVerdict {
  if (s && isRelu(s)) return { state: 'validee', reasons: [] };
  return { state: 'a-faire', reasons: ['Contrôler le sujet, puis le marquer relu.'] };
}

/**
 * Sujets exige Collection et non Essai : une couleur modifiée ne reverrouille pas tout le contenu. Essai reste jusqu'à MP5.
 * Droits exige Collection : le registre commun y vit. Sujets ne l'exige pas : une licence à revoir ne reverrouille pas le contenu.
 * Illustrations exige Recherche et ne touche pas `relu`, qui porte sur le texte.
 * Aperçu exige Recherche et non Relecture : un bloc allongé repasse à relire, et c'est justement dans l'aperçu que se voit son débordement.
 */
export const STEPS: StepDef[] = [
  { id: 'livre', label: 'Livre', scope: 'livre', requires: [], evaluate: livre },
  { id: 'prix', label: 'Prix', scope: 'livre', requires: ['livre'], evaluate: prix },
  { id: 'collection', label: 'Collection', scope: 'livre', requires: ['prix'], evaluate: collection },
  { id: 'essai', label: 'Essai', scope: 'livre', requires: ['collection'], evaluate: essai },
  { id: 'droits', label: 'Droits', scope: 'livre', requires: ['collection'], evaluate: droits },
  { id: 'sujets', label: 'Sujets', scope: 'livre', requires: ['collection'], evaluate: sujets },
  { id: 'sujet-recherche', label: 'Recherche', scope: 'sujet', requires: [], evaluate: sujetRecherche },
  { id: 'sujet-relecture', label: 'Relecture', scope: 'sujet', requires: ['sujet-recherche'], evaluate: sujetRelecture },
  { id: 'sujet-illustrations', label: 'Illustrations', scope: 'sujet', requires: ['sujet-recherche'], evaluate: sujetIllustrations },
  { id: 'sujet-apercu', label: 'Aperçu', scope: 'sujet', requires: ['sujet-recherche'], evaluate: sujetApercu },
];

const LABELS: Record<StepState, string> = { 'a-faire': 'à faire', validee: 'validée', alerte: 'alerte', erreur: 'erreur', verrouillee: 'verrouillée' };

/** Une alerte n'empêche pas d'avancer : seule une erreur ou un travail à faire retient la suite. */
export const isValidated = (state: StepState) => state === 'validee' || state === 'alerte';

function computeLevel(facts: ParcoursFacts, steps: StepDef[], subject?: SubjectFacts): { list: ComputedStep[]; open: string } {
  const computed = new Map<string, ComputedStep>();
  /** Étape à valider d'abord : la première de la chaîne, celle sur laquelle David peut agir. */
  const blockers = new Map<string, StepDef>();
  let number = 0;
  for (const def of steps) {
    number++;
    const blockedBy = def.requires.find((id) => !computed.has(id) || !isValidated(computed.get(id)!.state));
    const { label, scope, id } = def;
    if (blockedBy !== undefined) {
      const first = blockers.get(blockedBy) ?? steps.find((s) => s.id === blockedBy);
      if (first) blockers.set(id, first);
      computed.set(id, { id, label, scope, number, state: 'verrouillee', stateLabel: LABELS.verrouillee, reasons: [`Valider d'abord « ${first?.label ?? blockedBy} ».`] });
      continue;
    }
    const verdict = def.evaluate(facts, subject);
    computed.set(id, { id, label, scope, number, state: verdict.state, stateLabel: verdict.redo ? 'à refaire' : LABELS[verdict.state], reasons: verdict.reasons });
  }
  const list = [...computed.values()];
  return { list, open: (list.find((s) => !isValidated(s.state)) ?? list[list.length - 1])?.id ?? '' };
}

export function computeParcours(facts: ParcoursFacts, steps: StepDef[] = STEPS): Parcours {
  const book = computeLevel(facts, steps.filter((s) => s.scope === 'livre'));
  const subjectSteps = steps.filter((s) => s.scope === 'sujet');
  const subjects = facts.subjects.map((s): ComputedSubject => {
    const level = computeLevel(facts, subjectSteps, s);
    return { id: s.id, title: s.title, status: s.status, pages: s.pages, template: s.template, theme: s.theme, error: s.error, steps: level.list, open: level.open };
  });
  return { steps: book.list, open: book.open, subjects };
}
