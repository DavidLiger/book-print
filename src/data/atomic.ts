// src/data/atomic.ts — réécriture d'un fichier du dossier de données : fichier temporaire dans le même dossier, `fsync`, puis renommage.
// Une coupure ne laisse jamais un fichier à moitié écrit. `wx` n'écrase rien et ne suit pas un lien.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function writeAtomic(dir: string, name: string, content: string): void {
  const tmp = path.join(dir, `${name}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path.join(dir, name));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
