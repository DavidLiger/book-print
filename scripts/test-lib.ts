// scripts/test-lib.ts — mini-outil des tests : pas de framework (spec §8).
let passed = 0;
let failed = 0;

export function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`ÉCHEC : ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

export function finish(family: string): void {
  console.log(`${family} : ${passed} réussi(s), ${failed} échec(s)`);
  if (failed > 0) process.exit(1);
}
