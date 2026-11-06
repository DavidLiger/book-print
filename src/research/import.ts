// src/research/import.ts — lecture et fusion du fichier de recherche (spec §5.2, étape 4). Fonctions pures : le texte du fichier entre, les
// données à écrire sortent. Rien n'est écrit ici. Une erreur nomme toujours le champ fautif.
//
// Second import. Le texte importé est comparé au texte importé précédent, jamais à ce que David a corrigé :
// - une affirmation de même `id`, même texte et mêmes sources garde tout ce que David y a fait ; les autres repartent en `propose` ;
// - un bloc dont la proposition n'a pas changé garde le texte de David ; sinon la nouvelle proposition le remplace, en `a-relire` ;
// - un bloc gardé qui perd une affirmation validée passe en `a-reprendre`.
import type { z } from 'zod';
import { blockId, type Block } from '../schema/block';
import { claimIsValidated, type Claim, type StoredClaim } from '../schema/claim';
import { researchImportSchema, type ResearchImport, type StoredResearch } from '../schema/research';
import type { Subject } from '../schema/subject';
import type { ExpectedBlock } from './blocks';
import { ResearchRefused } from './errors';

const issues = (e: z.ZodError) => e.issues.map((i) => `champ ${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');

export function parseResearch(text: string): ResearchImport {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new ResearchRefused(`Fichier refusé : ce n'est pas un JSON valide (${(e as Error).message}).`);
  }
  const parsed = researchImportSchema.safeParse(value);
  if (!parsed.success) throw new ResearchRefused(`Fichier refusé : ${issues(parsed.error)}.`);
  return parsed.data;
}

/** Le fichier doit viser ce sujet, dans la langue de l'édition, et remplir exactement les blocs du gabarit. */
export function checkAgainst(file: ResearchImport, subjectId: string, lang: string, expected: ExpectedBlock[]): void {
  const faults: string[] = [];
  if (file.subjectId !== subjectId) faults.push(`champ subjectId : ${file.subjectId}, ${subjectId} attendu`);
  if (file.lang !== lang) faults.push(`champ lang : ${file.lang}, ${lang} attendu`);
  const wanted = new Map(expected.map((b) => [b.id, b]));
  const seen = new Set<string>();
  file.blocks.forEach((b, i) => {
    const id = blockId(b.zone, b.item);
    const want = wanted.get(id);
    if (!want) {
      faults.push(`champ blocks.${i}.zone : ${b.item ? `${b.zone}, information ${b.item}` : b.zone} inconnue du gabarit`);
      return;
    }
    if (want.type !== b.type) faults.push(`champ blocks.${i}.type : ${b.type}, ${want.type} attendu pour la zone ${b.zone}`);
    if (seen.has(id)) faults.push(`champ blocks.${i} : bloc en double, ${id}`);
    seen.add(id);
  });
  for (const b of expected) if (!seen.has(b.id)) faults.push(`champ blocks : bloc manquant, ${b.id} (zone ${b.zone}, type ${b.type})`);
  if (faults.length > 0) throw new ResearchRefused(`Fichier refusé : ${faults.join(' ; ')}.`);
}

const sameImport = (a: Pick<Claim, 'text' | 'sources' | 'confidence'>, b: Pick<Claim, 'text' | 'sources' | 'confidence'>) => {
  const plain = (c: typeof a) => JSON.stringify({ text: c.text, confidence: c.confidence, sources: c.sources.map(({ url, title, publisher, published, accessed, support }) => ({ url, title, publisher, published, accessed, support })) });
  return plain(a) === plain(b);
};

export interface ImportSummary {
  /** Affirmations gardées telles quelles. */
  claimsKept: number;
  /** Affirmations nouvelles ou modifiées : `propose`. */
  claimsChanged: number;
  /** Affirmations absentes du nouveau fichier. */
  claimsRemoved: number;
  blocksKept: number;
  blocksChanged: number;
  blocksToRedo: number;
}

export interface Merged {
  research: StoredResearch;
  subject: Subject;
  summary: ImportSummary;
  /** Rien n'a changé : le fichier est le même. */
  same: boolean;
}

function fresh(claim: Claim): StoredClaim {
  return { ...claim, status: 'propose', validatedAt: null, note: '' };
}

/** `previous` : `research.json` en place, `null` au premier import. */
export function mergeImport(file: ResearchImport, previous: StoredResearch | null, subject: Subject, expected: ExpectedBlock[]): Merged {
  const oldClaims = new Map((previous?.claims ?? []).map((c) => [c.id, c]));
  const summary: ImportSummary = { claimsKept: 0, claimsChanged: 0, claimsRemoved: 0, blocksKept: 0, blocksChanged: 0, blocksToRedo: 0 };
  const claims = file.claims.map((claim): StoredClaim => {
    const old = oldClaims.get(claim.id);
    if (old && sameImport(old, claim)) {
      summary.claimsKept++;
      return old;
    }
    summary.claimsChanged++;
    return fresh(claim);
  });
  const newClaims = new Map(claims.map((c) => [c.id, c]));
  summary.claimsRemoved = [...oldClaims.keys()].filter((id) => !newClaims.has(id)).length;

  const lang = file.lang;
  const oldBlocks = new Map(subject.blocks.map((b) => [b.id, b]));
  const oldProposals = new Map((previous?.blocks ?? []).map((b) => [blockId(b.zone, b.item), b]));
  const blocks = file.blocks.map((proposal): Block => {
    const id = blockId(proposal.zone, proposal.item);
    const want = expected.find((b) => b.id === id)!;
    const fromFile: Block = { id, zone: proposal.zone, type: want.type, ...(proposal.item ? { item: proposal.item } : {}), text: { [lang]: proposal.text }, claims: [...proposal.claims], state: 'a-relire' };
    const old = oldBlocks.get(id);
    const oldProposal = oldProposals.get(id);
    if (!old || !oldProposal || oldProposal.text !== proposal.text || oldProposal.claims.join() !== proposal.claims.join()) {
      summary.blocksChanged++;
      return fromFile;
    }
    const kept = old.claims.filter((c) => newClaims.has(c));
    const lost = kept.length !== old.claims.length;
    const weakened = old.claims.some((c) => claimIsValidated(oldClaims.get(c)?.status ?? 'propose') && !claimIsValidated(newClaims.get(c)?.status ?? 'propose'));
    if (lost || weakened) {
      summary.blocksToRedo++;
      return { ...old, claims: kept.length > 0 ? kept : [...proposal.claims], state: 'a-reprendre' };
    }
    summary.blocksKept++;
    return old;
  });

  const research: StoredResearch = { schemaVersion: file.schemaVersion, subjectId: file.subjectId, lang, generatedAt: file.generatedAt, claims, blocks: file.blocks };
  const same = previous !== null && summary.claimsChanged === 0 && summary.claimsRemoved === 0 && summary.blocksChanged === 0 && summary.blocksToRedo === 0;
  return { research, subject: { ...subject, blocks, status: same ? subject.status : 'brouillon' }, summary, same };
}
