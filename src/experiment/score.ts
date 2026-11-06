import fs from "node:fs";
import path from "node:path";
const R = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../results");
const gt: Record<string, Record<string, string[]>> = {};
for (const f of fs.readdirSync(R).filter((f) => f.startsWith("gt-"))) {
  const d = JSON.parse(fs.readFileSync(path.join(R, f), "utf8"));
  gt[d.repo] = d.gt;
}
const rows: any[] = [];
for (const f of fs.readdirSync(R).filter((f) => f.startsWith("arm-"))) {
  const a = JSON.parse(fs.readFileSync(path.join(R, f), "utf8"));
  for (const r of a.records) {
    const truth = gt[a.repo]?.[`${r.type}:${r.symbol}`] ?? [];
    const norm = (x: string) => x.replace(/\\/g, "/");
    const T = new Set<string>(truth.map(norm));
    const P = new Set<string>(r.answer.map(norm));
    const tp = [...P].filter((x) => T.has(x)).length;
    const prec = P.size ? tp / P.size : T.size ? 0 : 1;
    const rec = T.size ? tp / T.size : 1;
    rows.push({ repo: a.repo, system: a.system, workload: a.workload, task: r.type, symbol: r.symbol,
      precision: prec, recall: rec, f1: prec + rec ? (2 * prec * rec) / (prec + rec) : 0,
      wallMs: r.wallMs, analysesRun: r.analysesRun, notRun: r.notRun, sufficient: r.sufficient });
  }
  rows.push({ __process: true, repo: a.repo, system: a.system, workload: a.workload, ...a.process });
}
fs.writeFileSync(path.join(R, "scores.json"), JSON.stringify(rows, null, 2));
const agg: Record<string, any> = {};
for (const r of rows.filter((r) => !r.__process)) {
  const k = `${r.system}|${r.workload}|${r.task}`;
  const a = (agg[k] ??= { n: 0, f1: 0, prec: 0, rec: 0, wallMs: 0, analyses: 0, notRun: 0 });
  a.n++; a.f1 += r.f1; a.prec += r.precision; a.rec += r.recall; a.wallMs += r.wallMs; a.analyses += r.analysesRun; a.notRun += r.notRun;
}
const table = Object.entries(agg).map(([k, a]) => ({ arm: k, tasks: a.n, f1: +(a.f1 / a.n).toFixed(3),
  precision: +(a.prec / a.n).toFixed(3), recall: +(a.rec / a.n).toFixed(3), meanWallMs: +(a.wallMs / a.n).toFixed(1),
  meanAnalyses: +(a.analyses / a.n).toFixed(2), meanNotRun: +(a.notRun / a.n).toFixed(2) })).sort((x, y) => x.arm.localeCompare(y.arm));
fs.writeFileSync(path.join(R, "summary.json"), JSON.stringify(table, null, 2));
console.table(table);
