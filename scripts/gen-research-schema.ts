// scripts/gen-research-schema.ts — écrit `schema/research.schema.json` depuis zod. Le fichier versionné n'est jamais modifié à la main :
// `test:research` vérifie qu'il est identique au schéma généré.
import fs from 'node:fs';
import path from 'node:path';
import { researchJsonSchema } from '../src/schema/research';

export const SCHEMA_FILE = path.join(import.meta.dirname, '..', 'schema', 'research.schema.json');
export const schemaText = () => `${JSON.stringify(researchJsonSchema(), null, 2)}\n`;

if (process.argv[1] && path.basename(process.argv[1]).startsWith('gen-research-schema')) fs.writeFileSync(SCHEMA_FILE, schemaText());
