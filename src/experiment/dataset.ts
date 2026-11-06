import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
import { listSourceFiles, rel } from "../acquisition/program.js";

/**
 * Experiment corpus.
 *
 * Every repository is pinned: fixtures are in-tree, external repositories are
 * cloned once and their HEAD sha is recorded in results/corpus.json so a run
 * can be reproduced exactly.
 */

export interface RepoSpec {
  id: string;
  size: "small" | "medium" | "large";
  root: string;
  origin: string | null;
  taskCount: number;
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const REPO_ROOT = path.resolve(HERE, "../..");

export function corpus(): RepoSpec[] {
  return [
    { id: "repo-a", size: "small", root: path.join(REPO_ROOT, "tests/fixtures/repo-a"), origin: null, taskCount: 4 },
    { id: "repo-b", size: "small", root: path.join(REPO_ROOT, "tests/fixtures/repo-b"), origin: null, taskCount: 5 },
    { id: "repo-c", size: "small", root: path.join(REPO_ROOT, "tests/fixtures/repo-c"), origin: null, taskCount: 5 },
    {
      id: "ky",
      size: "medium",
      root: path.join(REPO_ROOT, "corpus/ky/source"),
      origin: "https://github.com/sindresorhus/ky.git",
      taskCount: 8,
    },
    {
      id: "zod",
      size: "large",
      root: path.join(REPO_ROOT, "corpus/zod/packages/zod/src"),
      origin: "https://github.com/colinhacks/zod.git",
      taskCount: 8,
    },
  ].filter((r) => fs.existsSync(r.root)) as RepoSpec[];
}

export function repoById(id: string): RepoSpec {
  const r = corpus().find((c) => c.id === id);
  if (!r) throw new Error(`unknown repo ${id}`);
  return r;
}

export function pinOf(spec: RepoSpec): { sha: string | null; files: number; loc: number } {
  const files = listSourceFiles(spec.root);
  let loc = 0;
  for (const f of files) loc += fs.readFileSync(f, "utf8").split("\n").length;
  let sha: string | null = null;
  let dir = spec.root;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      try {
        sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      } catch {
        sha = null;
      }
      break;
    }
    dir = path.dirname(dir);
  }
  return { sha, files: files.length, loc };
}

export interface TaskItem {
  repo: string;
  type: "FindCallers" | "FindCallees" | "ImportImpact" | "CallImpact" | "TestImpact";
  symbol: string;
  declaration: string;
}

/**
 * Deterministic task selection: exported functions / class methods, sorted by
 * name, filtered to symbols with a unique declaration name so the task is
 * well-posed. Nothing here looks at any system's answer.
 */
export function selectTasks(spec: RepoSpec): TaskItem[] {
  const files = listSourceFiles(spec.root);
  const program = ts.createProgram(files, {
    allowJs: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noResolve: false,
  });
  const counts = new Map<string, number>();
  const decls = new Map<string, string>();
  const bodySize = new Map<string, number>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!path.resolve(sf.fileName).startsWith(path.resolve(spec.root))) continue;
    const visit = (node: ts.Node) => {
      let name: string | null = null;
      let body: ts.Node | undefined;
      if (ts.isFunctionDeclaration(node) && node.name) {
        name = node.name.text;
        body = node.body;
      } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        name = node.name.text;
        body = node.body;
      }
      if (name && name.length > 3) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        if (!decls.has(name)) {
          decls.set(name, `${rel(spec.root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
          bodySize.set(name, body ? body.getText(sf).length : 0);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  const unique = [...counts.entries()]
    .filter(([, c]) => c === 1)
    .map(([n]) => n)
    // prefer symbols with real bodies (so FindCallees is non-trivial), then name order
    .sort((a, b) => (bodySize.get(b)! - bodySize.get(a)!) || a.localeCompare(b))
    .slice(0, spec.taskCount);

  const curated: Record<string, string[]> = {
    "repo-a": ["execute"],
    "repo-b": ["handle"],
    "repo-c": ["encode", "roundTrip"],
  };
  for (const extra of curated[spec.id] ?? []) if (!unique.includes(extra)) unique.unshift(extra);

  const tasks: TaskItem[] = [];
  for (const name of unique) {
    // ChangeImpact was one overloaded task conflating three different
    // notions of "impact" (import-dependency reach, call reachability, and
    // test exposure) into a single score. Splitting it means a recall gap
    // in one dimension (e.g. missing re-export/barrel edges) is visible on
    // its own instead of being averaged away against, or blamed on, the
    // other two.
    for (const type of ["FindCallers", "FindCallees", "ImportImpact", "CallImpact", "TestImpact"] as const) {
      tasks.push({ repo: spec.id, type, symbol: name, declaration: decls.get(name)! });
    }
  }
  return tasks;
}
