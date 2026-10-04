#!/usr/bin/env node
// Links the Liveforge JS packages (@liveforge/sdk, @liveforge/three, @liveforge/protocol) into node_modules so the
// game imports them exactly like a customer who ran `npm i @liveforge/sdk @liveforge/three` would.
//
//   node scripts/link-liveforge.mjs            (also runs automatically before `npm run dev` / `npm run build`)
//   LIVEFORGE_DIR=D:/src/Liveforge node scripts/link-liveforge.mjs
//
// The kit (the Reactive repo, formerly Liveforge) is found via $LIVEFORGE_DIR, else a sibling folder named "Liveforge"
// next to this repo, else the repo two levels up when Livecraft lives inside it at examples/livecraft, else a
// "Liveforge" folder next to any folder above this one (so git worktrees under .claude/worktrees find it too). The links are directory junctions on
// Windows and symlinks elsewhere; they point at the packages themselves, so their `dist/` must be built
// (`npm install && npm run build` in the Liveforge repo). Idempotent; `--quiet` only prints problems.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const quiet = process.argv.includes("--quiet");
const log = (...a) => { if (!quiet) console.log("[link-liveforge]", ...a); };
const warn = (...a) => console.warn("[link-liveforge]", ...a);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const PACKAGES = { sdk: "sdk-js", three: "sdk-three", protocol: "protocol" };

const isKit = (dir) => fs.existsSync(path.join(dir, "packages/protocol/package.json")) && fs.existsSync(path.join(dir, "packages/sdk-js/package.json"));

function findLiveforge() {
  const env = process.env.LIVEFORGE_DIR;
  if (env) return fs.existsSync(path.join(env, "packages/sdk-js/package.json")) ? path.resolve(env) : null;
  // 1) a sibling checkout: ../Liveforge
  const sibling = path.resolve(repoRoot, "../Liveforge");
  if (isKit(sibling)) return sibling;
  // 2) inside the Reactive repo at examples/livecraft: the kit is ../..
  const host = path.resolve(repoRoot, "../..");
  if (isKit(host)) return host;
  // 3) a "Liveforge" folder next to any folder above this repo (git worktrees under .claude/worktrees)
  for (let dir = path.dirname(repoRoot); ; dir = path.dirname(dir)) {
    const cand = path.join(path.dirname(dir), "Liveforge");
    if (fs.existsSync(path.join(cand, "packages/sdk-js/package.json"))) return cand;
    if (path.dirname(dir) === dir) return null;
  }
}

/** The node_modules the game resolves its own deps from (the nearest one above the repo that has three). */
function findNodeModules() {
  for (let dir = repoRoot; ; dir = path.dirname(dir)) {
    const nm = path.join(dir, "node_modules");
    if (fs.existsSync(path.join(nm, "three/package.json"))) return nm;
    if (path.dirname(dir) === dir) return path.join(repoRoot, "node_modules");
  }
}

const lf = findLiveforge();
if (!lf) {
  warn("Reactive kit not found. Run from <reactive>/examples/livecraft, clone it next to this repo (../Liveforge) or set LIVEFORGE_DIR. The game build needs it.");
  process.exit(quiet ? 0 : 1);
}
const nm = findNodeModules();
const scope = path.join(nm, "@liveforge");
fs.mkdirSync(scope, { recursive: true });

let linked = 0;
for (const [name, dir] of Object.entries(PACKAGES)) {
  const target = path.join(lf, "packages", dir);
  const link = path.join(scope, name);
  let st = null;
  try { st = fs.lstatSync(link); } catch { /* missing */ }
  if (st && !st.isSymbolicLink()) {
    warn(`${link} is a real folder (an installed package?); leaving it alone`);
    continue;
  }
  if (st) {
    let current = null;
    try { current = fs.realpathSync(link); } catch { /* dangling */ }
    if (current && path.resolve(current) === path.resolve(fs.realpathSync(target))) continue;
    // stale or dangling link: remove the link itself (never its target)
    try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
  }
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  linked++;
  log(`@liveforge/${name} -> ${target}`);
  if (!fs.existsSync(path.join(target, "dist/index.js"))) {
    warn(`${target}/dist is missing: run \`npm install && npm run build\` in ${lf}`);
  }
}
log(linked ? `linked into ${scope}` : `already linked (${scope} -> ${lf})`);
