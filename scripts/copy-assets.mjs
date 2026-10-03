// Post-build asset copy: tsc only emits .ts -> .js, so non-code files the runtime reads (the
// externalized prompts) must be copied into dist/ for `npm start` (the compiled path) to find them.
// Local dev (`npm run dev` via tsx) reads from src/ directly; Vercel uses vercel.json includeFiles.
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

const assets = [["src/agent/prompts/prompts.txt", "dist/agent/prompts/prompts.txt"]];

for (const [src, dest] of assets) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`copied ${src} -> ${dest}`);
}
