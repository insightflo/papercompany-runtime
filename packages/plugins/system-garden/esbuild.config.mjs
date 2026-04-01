import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");
const repoNodeModulesDir = path.resolve("../../../node_modules");
const pnpmStoreDir = path.join(repoNodeModulesDir, ".pnpm");

/* ------------------------------------------------------------------ */
/*  Embed code knowledge graph JSON into the worker bundle             */
/* ------------------------------------------------------------------ */
const kgPath = path.resolve(".understand-anything/knowledge-graph.json");
let embeddedCodeKG = "null";
if (fs.existsSync(kgPath)) {
  embeddedCodeKG = fs.readFileSync(kgPath, "utf-8");
}

function resolveCytoscapeNodePath() {
  if (!fs.existsSync(pnpmStoreDir)) return [];
  const cytoscapeEntry = fs.readdirSync(pnpmStoreDir).find((entry) => entry.startsWith("cytoscape@"));
  if (!cytoscapeEntry) return [];
  return [path.join(pnpmStoreDir, cytoscapeEntry, "node_modules")];
}

const uiBuild = {
  ...presets.esbuild.ui,
  nodePaths: [
    ...(presets.esbuild.ui.nodePaths ?? []),
    repoNodeModulesDir,
    ...resolveCytoscapeNodePath(),
  ],
};

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(uiBuild);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
