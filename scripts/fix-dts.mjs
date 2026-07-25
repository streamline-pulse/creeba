// Réécrit les extensions `.ts` des imports/exports RELATIFS en `.js` dans les
// fichiers .d.ts émis. tsc (rewriteRelativeImportExtensions) le fait pour le
// JavaScript mais pas pour les déclarations ; on aligne pour un dist 100 %
// standard (résoluble sans mapping .ts→.d.ts par tout outil).
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "dist";

function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".d.ts")) fix(p);
  }
}

function fix(file) {
  const src = readFileSync(file, "utf8");
  // from "./x.ts" | from '../x.ts'  →  .js   (imports relatifs uniquement)
  const out = src.replace(/(from\s*["'])(\.\.?\/[^"']*?)\.ts(["'])/g, "$1$2.js$3");
  if (out !== src) writeFileSync(file, out);
}

walk(dir);
