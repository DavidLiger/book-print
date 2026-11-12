// src/render/pdf-checks.ts — les contrôles de rendu qu'un modèle ou un sujet garde : C3, C4, C6, C7, C8. Le PDF d'essai (C1, C14, C15) revient avec MP6.
import type { CheckInput, CheckResult } from '../checks/rules';
import { runChecks } from '../checks/rules';
import { FONT_PACK } from './fonts';

export const PDF_KEPT = ['C3', 'C4', 'C6', 'C7', 'C8'];

export const packFonts = () => Object.values(FONT_PACK).map(({ family, pdfName }) => ({ family, pdfName }));

export const pdfChecks = (input: Omit<CheckInput, 'pack'>): CheckResult[] => runChecks({ ...input, pack: packFonts() }).filter((c) => PDF_KEPT.includes(c.id));
