import path from "node:path"; import fs from "node:fs"; import os from "node:os";
import { Engine } from "../src/engine/engine.js";
import { repoById } from "../src/experiment/dataset.js";
import { callImpactOracle } from "../src/experiment/oracles-ext.js";
const spec = repoById("repo-b");
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "sie-p12-"));
const engine = new Engine(spec.root, { cacheDir });
const oracle = callImpactOracle(spec.root, "handle");
const out: any = await engine.impactOfChange("handle");
const r = out.result;
console.log("ORACLE:", oracle.map((f:string)=>path.relative(spec.root,f)).sort());
console.log("ENGINE:", r.affectedFiles.map((f:string)=>path.relative(spec.root,f)).sort());
console.log("SEEDS/roots:", JSON.stringify(r.seeds ?? r.targets ?? r.roots ?? null));
console.log("keys:", Object.keys(r));
for (const d of [...(r.directDependents??[]),...(r.transitiveDependents??[])])
  console.log("dep", d.name, path.relative(spec.root, d.file), d.id);
for (const e of r.edges) console.log("edge", e.kind, e.resolution, e.fromId, "->", e.toId);
fs.rmSync(cacheDir,{recursive:true,force:true});
