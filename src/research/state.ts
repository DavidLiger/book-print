// src/research/state.ts — états des affirmations et des blocs (spec §3.5, §3.7). Fonctions pures : elles reçoivent les données et rendent les
// données modifiées. Toute modification de fond repasse le sujet en `brouillon`. La note de David n'est pas une modification de fond.
import { claimIsValidated, claimText, type StoredClaim } from '../schema/claim';
import type { Block } from '../schema/block';
import type { StoredResearch } from '../schema/research';
import type { Subject } from '../schema/subject';
import { ResearchRefused } from './errors';

export interface Data {
  subject: Subject;
  research: StoredResearch;
}

export type ClaimAction = { kind: 'valider' } | { kind: 'corriger'; text: string } | { kind: 'rejeter' } | { kind: 'note'; text: string };
export type BlockAction = { kind: 'texte'; text: string } | { kind: 'valider' } | { kind: 'citer'; claims: string[] };

const draft = (subject: Subject): Subject => ({ ...subject, status: 'brouillon' });

function findClaim(research: StoredResearch, id: string): StoredClaim {
  const claim = research.claims.find((c) => c.id === id);
  if (!claim) throw new ResearchRefused(`Affirmation inconnue : ${id}.`);
  return claim;
}

function findBlock(subject: Subject, id: string): Block {
  const block = subject.blocks.find((b) => b.id === id);
  if (!block) throw new ResearchRefused(`Bloc inconnu : ${id}.`);
  return block;
}

/** Les blocs qui citent cette affirmation sont à reprendre. */
function redoCiting(subject: Subject, claimId: string): void {
  for (const block of subject.blocks) if (block.claims.includes(claimId)) block.state = 'a-reprendre';
}

export function applyClaimAction(data: Data, claimId: string, action: ClaimAction, now: Date): Data {
  const { subject, research } = structuredClone(data);
  const claim = findClaim(research, claimId);
  const was = claim.status;
  switch (action.kind) {
    case 'note':
      claim.note = action.text;
      return { subject, research };
    case 'valider':
      if (claimIsValidated(was)) throw new ResearchRefused(`L'affirmation ${claimId} est déjà validée.`);
      claim.status = 'valide';
      claim.validatedAt = now.toISOString();
      break;
    case 'corriger': {
      const text = action.text.trim();
      if (text === '') throw new ResearchRefused('Correction vide : écrire le texte, ou rejeter l\'affirmation.');
      if (text === claimText(claim) && was === 'corrige') return data;
      claim.correctedText = text;
      claim.status = 'corrige';
      claim.validatedAt = now.toISOString();
      // Une correction faite après validation change le fait sur lequel le bloc a été validé.
      if (claimIsValidated(was)) redoCiting(subject, claimId);
      break;
    }
    case 'rejeter':
      if (was === 'rejete') throw new ResearchRefused(`L'affirmation ${claimId} est déjà rejetée.`);
      claim.status = 'rejete';
      claim.validatedAt = null;
      redoCiting(subject, claimId);
      break;
  }
  return { subject: draft(subject), research };
}

export function applyBlockAction(data: Data, blockId: string, action: BlockAction): Data {
  const { subject, research } = structuredClone(data);
  const block = findBlock(subject, blockId);
  const lang = research.lang;
  switch (action.kind) {
    case 'texte':
      if ((block.text[lang] ?? '') === action.text) return data;
      block.text[lang] = action.text;
      if (block.state === 'valide') block.state = 'a-relire';
      break;
    case 'citer': {
      if (action.claims.length === 0) throw new ResearchRefused('Un bloc garde au moins une affirmation.');
      if (new Set(action.claims).size !== action.claims.length) throw new ResearchRefused('Affirmation citée deux fois.');
      for (const id of action.claims) findClaim(research, id);
      if (action.claims.join() === block.claims.join()) return data;
      block.claims = action.claims;
      if (block.state === 'valide') block.state = 'a-relire';
      break;
    }
    case 'valider': {
      if ((block.text[lang] ?? '').trim() === '') throw new ResearchRefused(`Bloc ${blockId} sans texte.`);
      const pending = block.claims.filter((id) => !claimIsValidated(findClaim(research, id).status));
      if (pending.length > 0) throw new ResearchRefused(`Bloc ${blockId} : affirmations non validées, ${pending.join(', ')}.`);
      block.state = 'valide';
      return { subject, research };
    }
  }
  return { subject: draft(subject), research };
}

/** Modification du titre, de la légende ou du thème : le texte relu n'est plus celui qui a été contrôlé. */
export function touched(subject: Subject): Subject {
  return draft(subject);
}
