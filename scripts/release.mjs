// Publie les packages qui ne sont pas encore sur le registre (idempotent :
// `npm view` détecte ce qui existe déjà). La liste est DÉDUITE du workspace —
// une liste écrite à la main finit toujours par oublier un package. L'ordre est
// topologique (dépendances d'abord) pour que les dépendants résolvent des
// versions déjà publiées ; `bun publish` remplace les specifiers `workspace:*`
// et `catalog:` par leur version concrète.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const IGNORED = new Set(
  JSON.parse(readFileSync(".changeset/config.json", "utf8")).ignore ?? [],
);

const entries = readdirSync("packages", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({
    dir: d.name,
    pkg: JSON.parse(readFileSync(`packages/${d.name}/package.json`, "utf8")),
  }))
  .filter(({ pkg }) => !pkg.private && !IGNORED.has(pkg.name));

const byName = new Map(entries.map((e) => [e.pkg.name, e]));

/** Dépendances internes d'un package, tous types confondus. */
function internalDeps({ pkg }) {
  return Object.keys({
    ...pkg.dependencies,
    ...pkg.peerDependencies,
    ...pkg.devDependencies,
  }).filter((name) => byName.has(name));
}

// Tri topologique : un package n'est publié qu'après ce dont il dépend.
const ordered = [];
const done = new Set();
function visit(entry, stack = new Set()) {
  if (done.has(entry.pkg.name) || stack.has(entry.pkg.name)) return;
  stack.add(entry.pkg.name);
  for (const dep of internalDeps(entry)) visit(byName.get(dep), stack);
  stack.delete(entry.pkg.name);
  done.add(entry.pkg.name);
  ordered.push(entry);
}
entries.forEach((entry) => visit(entry));

const failures = [];
for (const { dir, pkg } of ordered) {
  const id = `${pkg.name}@${pkg.version}`;

  const view = spawnSync("npm", ["view", id, "version"], { stdio: "pipe" });
  if (view.status === 0) {
    console.log(`skip ${id} — already on the registry`);
    continue;
  }

  console.log(`publishing ${id}`);
  // `--access public` explicite : un package SCOPÉ publié pour la première fois
  // est restreint par défaut, et `publishConfig` ne suffit pas toujours.
  const publish = spawnSync(
    "bun",
    ["publish", "--cwd", `packages/${dir}`, "--access", "public"],
    { stdio: "inherit" },
  );
  if (publish.status !== 0) {
    // On continue : l'échec d'un package ne doit pas retenir les autres, sinon
    // un nouveau venu bloque toute la publication sans qu'on le voie.
    console.error(`failed to publish ${id}`);
    failures.push(id);
    continue;
  }
  console.log(`New tag: v${pkg.version}`);
}

if (failures.length) {
  console.error(
    `\n${failures.length} package(s) not published: ${failures.join(", ")}`,
  );
  process.exit(1);
}
