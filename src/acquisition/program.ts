import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface ProgramHandle {
  program: ts.Program;
  checker: ts.TypeChecker;
  root: string;
  /** absolute paths of the repository's own source files (no node_modules, no .d.ts libs) */
  sourceFiles: ts.SourceFile[];
  configPath: string | null;
  diagnosticsCount: number;
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo"]);

export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (EXTENSIONS.includes(ext) && !entry.name.endsWith(".d.ts")) out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

export function fileHashes(files: string[], root: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    try {
      const content = fs.readFileSync(file);
      map.set(rel(root, file), createHash("sha1").update(content).digest("hex"));
    } catch {
      // unreadable file: caller records a missing-file unknown region
    }
  }
  return map;
}

export function rel(root: string, file: string): string {
  const r = path.relative(root, file);
  return r.split(path.sep).join("/");
}

/** git revision if available, otherwise a content hash of the file set. */
export function detectRevision(root: string, files: string[]): { revision: string; source: "git" | "content-hash" } {
  try {
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha) return { revision: sha, source: "git" };
  } catch {
    // no git: fall through
  }
  const hash = createHash("sha1");
  for (const [file, h] of fileHashes(files, root)) hash.update(`${file}:${h}`);
  return { revision: `content-${hash.digest("hex").slice(0, 12)}`, source: "content-hash" };
}

function findConfig(root: string): string | null {
  const direct = path.join(root, "tsconfig.json");
  if (fs.existsSync(direct)) return direct;
  return null;
}

/**
 * Build a TypeScript Program for a repository.
 * Uses tsconfig.json when present (respecting its options) and always includes
 * every discovered source file so callers outside the config's `include` are seen.
 */
export function createProgram(root: string, files?: string[]): ProgramHandle {
  const configPath = findConfig(root);
  let options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
    noResolve: false,
    jsx: ts.JsxEmit.ReactJSX,
  };
  if (configPath) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!read.error && read.config) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
      options = { ...parsed.options, noEmit: true, allowJs: parsed.options.allowJs ?? true };
      if (options.moduleResolution === undefined) options.moduleResolution = ts.ModuleResolutionKind.Bundler;
    }
  }
  const rootNames = (files ?? listSourceFiles(root)).map((f) => path.resolve(f));
  const program = ts.createProgram({ rootNames, options });
  const checker = program.getTypeChecker();
  const rootResolved = path.resolve(root);
  const sourceFiles = program
    .getSourceFiles()
    .filter(
      (sf) =>
        !sf.isDeclarationFile &&
        !sf.fileName.includes("/node_modules/") &&
        path.resolve(sf.fileName).startsWith(rootResolved),
    );
  const diagnosticsCount = program.getConfigFileParsingDiagnostics().length;
  return { program, checker, root: rootResolved, sourceFiles, configPath, diagnosticsCount };
}
