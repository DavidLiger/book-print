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
  /** Gabarit absent ou invalide (GB1). */
  templateError: string | null;
  /** Blocs attendus par le gabarit et absents, blocs en trop : un gabarit modifié depuis l'import (GB1). */
  blocksGap: { missing: string[]; extra: string[] };
  /** Mise en page du sujet (ED1) : sa copie (`layout.json`) ou le gabarit d'un sujet d'avant ED1 ; format, côté de départ (C16) et C17. */
  miseEnPage: { source: 'layout.json' | 'gabarit' | null; errors: string[] };
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
  /** Gabarits de la collection (GB1). */
  gabarits: {
    /** `collection/gabarits/` refusé. */
    error: string | null;
    valid: number;
    /** Fichiers invalides, avec leur erreur. */
    invalid: string[];
    /** Sujets du livre posés sur un gabarit absent. */
    orphans: string[];
    /** C17 sur chaque mise en page du format du livre (ED1). */
    overlaps: string[];
  };
  essai: {
    /** Le livre et la collection ne se rendent pas : l'export est impossible. */
    renderError: string | null;
    control: { dateMs: number; errors: string[]; alerts: string[] } | null;
    controlError: string | null;
    styleMs: number | null;
    printBookMs: number | null;
    /** Date de `collection/gabarits/2A.json` (GB1). */
    templateMs: number | null;
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
  /** Workflows de ComfyUI (IC1), communs à la collection. */
  workflows: {
    /** Dossier ou `workflows.json` illisible. */
    error: string | null;
    /** Travail à faire : workflow à déposer, droits à cocher. */
    todo: string[];
    /** Workflow refusé, droit inconnu ou d'un autre type. */
    faults: string[];
  };
  /** Bibliothèque de styles (IC2), commune à la collection ; style par défaut et cohérence du livre. */
  styles: {
    /** `collection/styles/` ou un registre illisible. */
    error: string | null;
    count: number;
    /** Style invalide, référence absente, droit inconnu ou refusé, style par défaut ou de zone inconnu. */
    faults: string[];
    /** Style par défaut à choisir. */
    todo: string[];
    /** Mélange de styles, version antérieure, référence à vérifier. */
    alerts: string[];
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

function gabarits({ gabarits: g }: ParcoursFacts): StepVerdict {
  if (g.error) return { state: 'erreur', reasons: [g.error] };
  if (g.invalid.length + g.orphans.length + g.overlaps.length > 0) return { state: 'erreur', reasons: [...g.invalid, ...g.orphans, ...g.overlaps] };
  if (g.valid === 0) return { state: 'a-faire', reasons: ['Ajouter les gabarits livrés, ou poser un gabarit dans collection/gabarits/.'] };
  return { state: 'validee', reasons: [] };
}

function essai({ essai: e }: ParcoursFacts): StepVerdict {
  if (e.renderError) return { state: 'erreur', reasons: [e.renderError] };
  if (e.controlError) return { state: 'a-faire', redo: true, reasons: [`${e.controlError} Relancer l'export.`] };
  if (!e.control) return { state: 'a-faire', reasons: ['Exporter le PDF d\'essai.'] };
  const { control } = e;
  const styleNewer = e.styleMs !== null && e.styleMs >= control.dateMs;
  const bookNewer = e.bookChanged ?? (e.printBookMs !== null && e.printBookMs >= control.dateMs);
  const templateNewer = e.templateMs !== null && e.templateMs >= control.dateMs;
  const newer = ([['collection/style.json', styleNewer], ['collection/gabarits/2A.json', templateNewer], ['print-book.json', bookNewer]] as const).filter(([, changed]) => changed);
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

function workflows({ workflows: w }: ParcoursFacts): StepVerdict {
  if (w.error) return { state: 'erreur', reasons: [w.error] };
  if (w.faults.length > 0) return { state: 'erreur', reasons: w.faults };
  if (w.todo.length > 0) return { state: 'a-faire', reasons: w.todo };
  return { state: 'validee', reasons: [] };
}

function styles({ styles: s }: ParcoursFacts): StepVerdict {
  if (s.error) return { state: 'erreur', reasons: [s.error] };
  if (s.faults.length > 0) return { state: 'erreur', reasons: s.faults };
  if (s.count === 0) return { state: 'a-faire', reasons: ['Créer un premier style : « Créer le style de base depuis les workflows ».'] };
  if (s.todo.length > 0) return { state: 'a-faire', reasons: s.todo };
  if (s.alerts.length > 0) return { state: 'alerte', reasons: s.alerts };
  return { state: 'validee', reasons: [] };
}

const isRelu = (s: SubjectFacts) => s.status === 'relu' || s.status === 'prêt';

/** Écart d'un sujet avec son gabarit (GB1) : `null` si les blocs sont ceux attendus. */
function gapReason(s: SubjectFacts): string | null {
  const { missing, extra } = s.blocksGap;
  if (missing.length + extra.length === 0) return null;
  const parts = [...(missing.length ? [`blocs attendus absents : ${missing.join(', ')}`] : []), ...(extra.length ? [`blocs en trop : ${extra.join(', ')}`] : [])];
  return `Gabarit ${s.template} modifié depuis l'import, ${parts.join(' ; ')}. Un second import règle l'écart.`;
}

function sujets({ subjects }: ParcoursFacts): StepVerdict {
  const broken = subjects.flatMap((s) => {
    const fault = s.error ?? s.templateError ?? gapReason(s);
    return fault ? [`${s.id} : ${fault}`] : [];
  });
  if (broken.length > 0) return { state: 'erreur', reasons: broken };
  if (subjects.length === 0) return { state: 'a-faire', reasons: ['Créer un premier sujet.'] };
  const left = subjects.filter((s) => !isRelu(s)).length;
  if (left > 0) return { state: 'a-faire', reasons: [`${count(left, 'sujet')} à relire, sur ${subjects.length}.`] };
  return { state: 'validee', reasons: [] };
}

const unreadable = (s: SubjectFacts | undefined): StepVerdict | null => (s?.error ? { state: 'erreur', reasons: [s.error] } : null);

/** Mise en page du sujet (ED1) : lisible, au format du livre, sur le bon côté (C16), sans chevauchement interdit (C17). */
function sujetMiseEnPage(_f: ParcoursFacts, s?: SubjectFacts): StepVerdict {
  const fault = unreadable(s);
  if (fault) return fault;
  if (s?.templateError) return { state: 'erreur', reasons: [s.templateError] };
  if (s && s.miseEnPage.errors.length > 0) return { state: 'erreur', reasons: s.miseEnPage.errors };
  return { state: 'validee', reasons: [] };
}

function sujetRecherche(_f: ParcoursFacts, s?: SubjectFacts): StepVerdict {
  const fault = unreadable(s);
  if (fault) return fault;
  if (s?.templateError) return { state: 'erreur', reasons: [s.templateError] };
  if (s?.research.state === 'invalide') return { state: 'erreur', reasons: [s.research.error ?? 'research.json invalide.'] };
  if (s?.research.state !== 'ok') return { state: 'a-faire', reasons: ['Préparer la recherche, puis importer le fichier.'] };
  const gap = gapReason(s);
  if (gap) return { state: 'erreur', reasons: [gap] };
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
 * Sujets exige Gabarits et non Essai : une couleur modifiée ne reverrouille pas tout le contenu. Essai reste jusqu'à MP5.
 * Gabarits exige Collection (GB1) : ses fichiers y vivent et ses zones lisent le style. Essai et Sujets l'exigent : ils posent un gabarit.
 * Droits exige Collection : le registre commun y vit. Sujets ne l'exige pas : une licence à revoir ne reverrouille pas le contenu.
 * Workflows exige Droits : ses cases viennent du registre. Sujets ne l'exige pas : le dépôt manuel d'une image reste possible sans ComfyUI.
 * Styles exige Workflows : le style de base en vient, et un aperçu passe par eux. Sujets ne l'exige pas non plus.
 * Illustrations exige Recherche et ne touche pas `relu`, qui porte sur le texte.
 * Mises en page (ex-Gabarits, ED1) garde l'identifiant `gabarits`. Recherche exige Mise en page (ED1) : les blocs attendus en viennent.
 * Aperçu exige Recherche et non Relecture : un bloc allongé repasse à relire, et c'est justement dans l'aperçu que se voit son débordement.
 */
export const STEPS: StepDef[] = [
  { id: 'livre', label: 'Livre', scope: 'livre', requires: [], evaluate: livre },
  { id: 'prix', label: 'Prix', scope: 'livre', requires: ['livre'], evaluate: prix },
  { id: 'collection', label: 'Collection', scope: 'livre', requires: ['prix'], evaluate: collection },
  { id: 'gabarits', label: 'Mises en page', scope: 'livre', requires: ['collection'], evaluate: gabarits },
  { id: 'essai', label: 'Essai', scope: 'livre', requires: ['gabarits'], evaluate: essai },
  { id: 'droits', label: 'Droits', scope: 'livre', requires: ['collection'], evaluate: droits },
  { id: 'workflows', label: 'Workflows', scope: 'livre', requires: ['droits'], evaluate: workflows },
  { id: 'styles', label: 'Styles', scope: 'livre', requires: ['workflows'], evaluate: styles },
  { id: 'sujets', label: 'Sujets', scope: 'livre', requires: ['gabarits'], evaluate: sujets },
  { id: 'sujet-mise-en-page', label: 'Mise en page', scope: 'sujet', requires: [], evaluate: sujetMiseEnPage },
  { id: 'sujet-recherche', label: 'Recherche', scope: 'sujet', requires: ['sujet-mise-en-page'], evaluate: sujetRecherche },
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
