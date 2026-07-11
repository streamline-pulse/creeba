#!/usr/bin/env bun
/**
 * Electrobun postBuild hook.
 *
 * The Bun bundle marks `@duckdb/*` and `bare-sidecar` as `external`, and the
 * Bare sidecar (hyperswarm, b4a, native addons) runs outside the bundle. In dev
 * the `.app` lives in the project and resolves these modules from ./node_modules;
 * but in a canary/stable `.app` distributed to a third party, that node_modules
 * does not exist. So we embed the **transitive closure of runtime dependencies**
 * into Contents/Resources/app/node_modules (and nothing else: no build deps).
 *
 * No-op in dev (automatic resolution from the project's node_modules).
 */
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

const env = process.env.ELECTROBUN_BUILD_ENV ?? "";
const os = process.env.ELECTROBUN_OS ?? process.platform;
const arch = process.env.ELECTROBUN_ARCH ?? process.arch;
const projectRoot = process.cwd();

/** Electrobun names the OS "macos"/"win"/"linux"; Holepunch prebuilds use the
 * Node convention ("darwin"/"win32"/"linux"). */
const PLAT = { macos: "darwin", win: "win32", linux: "linux" }[os] ?? os;
/** Prebuild folder prefixes to keep (target platform only). */
const KEEP_PREBUILD = [`${PLAT}-${arch}`, `${PLAT}-universal`];

if (env === "dev" || env === "") {
  console.log("[postbuild] env=dev: node_modules resolved from the project, skip.");
  process.exit(0);
}

const buildDir =
  process.env.ELECTROBUN_BUILD_DIR ?? join(projectRoot, "build", `${env}-${os}-${arch}`);
const nmSource = join(projectRoot, "node_modules");

if (!existsSync(nmSource)) {
  console.error(`[postbuild] node_modules not found: ${nmSource}`);
  process.exit(1);
}
if (!existsSync(buildDir)) {
  console.error(`[postbuild] build directory not found: ${buildDir}`);
  process.exit(1);
}

/** Roots of `external` native dependencies to embed (the rest is bundled). */
const RUNTIME_ROOTS = ["@duckdb/node-api", "@number0/iroh"];

/** Noise files/folders to never embed. */
const NOISE = new Set([".git", ".github", ".claude", ".vscode", "test", "tests", "example", "examples", "docs", "coverage"]);

/**
 * Resolve a package name seen from `fromDir`: first a nested node_modules
 * (classic upward Node resolution), otherwise the project's hoisted root.
 */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  while (true) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const top = join(nmSource, name);
  return existsSync(join(top, "package.json")) ? top : null;
}

/**
 * Transitive closure (dependencies + present optionalDependencies).
 * Returns a Map name->dir. The `name` (package.json field) is used as the
 * FLATTENED destination in the embedded node_modules: robust to workspace
 * hoisting (packages may live at the monorepo root, not under ./node_modules).
 */
function computeClosure(roots) {
  const found = new Map(); // name -> dir
  const seenDirs = new Set();
  const queue = [];

  for (const name of roots) {
    const dir = resolvePackageDir(name, projectRoot);
    if (dir) queue.push(dir);
    else console.warn(`[postbuild] runtime root missing: ${name}`);
  }

  while (queue.length) {
    const pkgDir = queue.pop();
    if (seenDirs.has(pkgDir)) continue;
    seenDirs.add(pkgDir);

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (pkg.name) found.set(pkg.name, pkgDir);

    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    };
    for (const depName of Object.keys(deps)) {
      const depDir = resolvePackageDir(depName, pkgDir);
      if (depDir && !seenDirs.has(depDir)) queue.push(depDir);
      // optional dependency not installed (e.g. another platform's binding): ignored
    }
  }
  return found;
}

function filter(src) {
  const parts = src.split("/");
  const base = parts[parts.length - 1];
  if (NOISE.has(base)) return false;

  // Prune native prebuilds of other platforms (segment right after
  // "prebuilds/", e.g. android-arm64, win32-x64, darwin-x64…).
  const pbIndex = parts.lastIndexOf("prebuilds");
  if (pbIndex >= 0 && parts.length > pbIndex + 1) {
    const platformDir = parts[pbIndex + 1];
    if (!KEEP_PREBUILD.some((k) => platformDir.startsWith(k))) return false;
  }
  return true;
}

function findAppCodeRoots(dir) {
  const roots = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".app")) continue;
    const codePath = join(dir, name, "Contents", "Resources", "app");
    if (existsSync(join(codePath, "bun", "index.js"))) roots.push(codePath);
  }
  return roots;
}

const appRoots = findAppCodeRoots(buildDir);
if (appRoots.length === 0) {
  console.error(`[postbuild] no .app bundle with bun/index.js under ${buildDir}`);
  process.exit(1);
}

const closure = computeClosure(RUNTIME_ROOTS);
console.log(`[postbuild] ${closure.size} runtime packages to embed.`);

for (const codeRoot of appRoots) {
  const destNm = join(codeRoot, "node_modules");
  for (const [name, pkgDir] of closure) {
    const dest = join(destNm, name); // flat layout by name (@scope/pkg handled)
    try {
      cpSync(pkgDir, dest, { recursive: true, dereference: true, filter });
    } catch (err) {
      console.warn(`[postbuild] partial copy ${name}: ${err.message}`);
    }
  }

  console.log(`[postbuild] node_modules embedded (~${dirSizeMB(destNm)} MB) in ${relative(buildDir, codeRoot)}`);
}

function dirSizeMB(dir) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          bytes += statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return Math.round(bytes / (1024 * 1024));
}
