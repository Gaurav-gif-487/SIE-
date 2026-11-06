#!/usr/bin/env node
/**
 * MCP server (stdio, JSON-RPC 2.0) exposing the same Task API as the CLI.
 * No MCP-specific analysis logic: every tool call goes through Engine.
 *
 * Two fixes from the original 3-tool version:
 *
 * 1. Full task surface. Every Engine method the CLI exposes is now a tool
 *    here too — this process (an agent harness talking MCP) is the primary
 *    product surface, not a side output of the engine, so it should not lag
 *    the CLI's capabilities.
 * 2. Warm engines across tool calls. The MCP server is already a long-lived
 *    process for the duration of a session (unlike a CLI invocation), so it
 *    keeps one `Engine` per repository root alive in memory for the life of
 *    the process instead of constructing a fresh one — and therefore paying
 *    a full `ts.Program` rebuild — on every single tool call. This is the
 *    same warm-instance idea as `src/daemon`, scoped to this process.
 *
 * This hand-rolls the JSON-RPC methods MCP actually needs (initialize,
 * tools/list, tools/call) rather than depending on the official MCP SDK,
 * because this environment has no network access to install it. The tool
 * definitions and `handle()` below are written so that swapping in
 * `@modelcontextprotocol/sdk`'s `McpServer` + `StdioServerTransport` later
 * is a mechanical change: each TOOLS entry becomes a `server.tool(...)`
 * registration and `handle()`'s dispatch becomes the tool callback.
 */
import { Engine } from "../engine/engine.js";
import { buildFindCallersContext } from "../reasoning/context.js";
import { exportScip, encodeScipIndex } from "../scip/export.js";
import { runAnalysis, analysisByName } from "../analyses/library.js";

interface Req {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "index_repository",
    description: "Cheapest crystallization: files and modules",
    inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  },
  {
    name: "index_python_repository",
    description:
      "Index .py files: files, modules, functions/methods/classes, name-based CALLS edges (independent python3 ast extractor, not tree-sitter or the TS pipeline — see src/acquisition/python.ts for exactly what 'name-based' resolution does and doesn't guarantee)",
    inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  },
  {
    name: "refresh_repository",
    description: "Invalidate files whose content hash changed since they were last analyzed",
    inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  },
  {
    name: "find_callers",
    description: "FindCallers(symbol) with evidence, uncertainty and residual risk",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, symbol: { type: "string" } },
      required: ["repo", "symbol"],
    },
  },
  {
    name: "find_python_callers",
    description:
      "FindPythonCallers(symbol): name-based CALLS resolution over .py files (no type checker, independent python3 ast pipeline — see src/acquisition/python.ts). Buckets are possible/ambiguous/unresolved-site, never confirmed.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, symbol: { type: "string" } },
      required: ["repo", "symbol"],
    },
  },
  {
    name: "find_callees",
    description: "FindCallees(symbol): what this symbol calls",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, symbol: { type: "string" } },
      required: ["repo", "symbol"],
    },
  },
  {
    name: "find_references",
    description: "FindReferences(symbol): every reference, call or not",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, symbol: { type: "string" } },
      required: ["repo", "symbol"],
    },
  },
  {
    name: "impact_of_change",
    description: "ImpactOfChange(symbol, maxDepth): transitive blast radius of a change",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, symbol: { type: "string" }, maxDepth: { type: "number" } },
      required: ["repo", "symbol"],
    },
  },
  {
    name: "which_tests_exercise",
    description: "WhichTestsExercise(symbol): tests with coverage/trace evidence touching this symbol",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, symbol: { type: "string" } },
      required: ["repo", "symbol"],
    },
  },
  {
    name: "why_did_change",
    description: "WhyDidChange(symbol): git evidence for a symbol's history",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, symbol: { type: "string" } },
      required: ["repo", "symbol"],
    },
  },
  {
    name: "module_dependents",
    description: "ModuleDependents(module): what imports this module",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, module: { type: "string" } },
      required: ["repo", "module"],
    },
  },
  {
    name: "build_context",
    description: "Smallest useful evidence-backed context for a FindCallers task, under a token budget",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, symbol: { type: "string" }, budget: { type: "number" } },
      required: ["repo", "symbol"],
    },
  },
  {
    name: "repo_overview",
    description:
      "RepoOverview: compressed, evidence-backed structural summary of the repository within a token budget — the first-contact tool to call before you know which symbol or module to ask about",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, budget: { type: "number" } },
      required: ["repo"],
    },
  },
  {
    name: "crystallization_report",
    description: "How deeply the repository is currently understood, derived from completed analyses",
    inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  },
  {
    name: "export_scip",
    description:
      "Export currently-known symbols/occurrences as a base64-encoded SCIP index, for interop with SCIP-consuming tooling",
    inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  },
];

/** One warm Engine per repository root, for the lifetime of this process. */
const engines = new Map<string, Engine>();

function engineFor(repo: string): Engine {
  const existing = engines.get(repo);
  if (existing) return existing;
  const engine = new Engine(repo, { autoPersist: false });
  engines.set(repo, engine);
  return engine;
}

function text(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export async function handle(req: Req): Promise<unknown> {
  if (req.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "software-intelligence-engine", version: "2.0.0" },
    };
  }
  if (req.method === "tools/list") return { tools: TOOLS };
  if (req.method === "tools/call") {
    const name = String(req.params?.name);
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    const repo = String(args.repo);
    const engine = engineFor(repo);

    switch (name) {
      case "index_repository":
        return text(await engine.index());
      case "index_python_repository":
        return text(await engine.indexPython());
      case "refresh_repository":
        return text(engine.refresh());
      case "find_callers":
        return text(await engine.findCallers(String(args.symbol)));
      case "find_python_callers":
        return text(await engine.findPythonCallers(String(args.symbol)));
      case "find_callees":
        return text(await engine.findCallees(String(args.symbol)));
      case "find_references":
        return text(await engine.findReferences(String(args.symbol)));
      case "impact_of_change":
        return text(
          await engine.impactOfChange(String(args.symbol), typeof args.maxDepth === "number" ? args.maxDepth : 4),
        );
      case "which_tests_exercise":
        return text(await engine.whichTestsExercise(String(args.symbol)));
      case "why_did_change":
        return text(await engine.whyDidChange(String(args.symbol)));
      case "module_dependents":
        return text(await engine.moduleDependents(String(args.module)));
      case "build_context": {
        const outcome = await engine.findCallers(String(args.symbol));
        const pack = buildFindCallersContext(engine.store, outcome.result, outcome.uncertainty, outcome.risk, {
          tokenBudget: typeof args.budget === "number" ? args.budget : 2000,
        });
        return text(pack);
      }
      case "repo_overview":
        return text(await engine.repoOverview(typeof args.budget === "number" ? args.budget : 2000));
      case "crystallization_report":
        return text(engine.crystallization());
      case "export_scip": {
        await engine.index();
        for (const analysis of ["ResolveSymbols", "ResolveTypes", "ResolveCalls", "BuildReferences"]) {
          await runAnalysis(analysisByName(analysis), engine.context);
        }
        const index = exportScip(engine.store, engine.root);
        const bytes = encodeScipIndex(index);
        return text({ documents: index.documents.length, base64: bytes.toString("base64") });
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
  throw new Error(`unsupported method: ${req.method}`);
}

function persistAllWarmEngines(): void {
  for (const engine of engines.values()) engine.persist();
}

async function main(): Promise<void> {
  let buffer = "";
  process.stdin.setEncoding("utf8");

  // The stdio transport is long-lived across many tool calls; persist
  // periodically so a crash doesn't lose everything learned this session,
  // same rationale as the daemon's interval persist.
  const persistInterval = setInterval(persistAllWarmEngines, 30_000);
  persistInterval.unref();
  process.on("exit", persistAllWarmEngines);
  process.on("SIGINT", () => {
    persistAllWarmEngines();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    persistAllWarmEngines();
    process.exit(0);
  });

  for await (const chunk of process.stdin) {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let req: Req;
      try {
        req = JSON.parse(line) as Req;
      } catch {
        continue;
      }
      try {
        const result = await handle(req);
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n`);
      } catch (err) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: (err as Error).message } })}\n`,
        );
      }
    }
  }
}

const isMain =
  (process.argv[1] && process.argv[1].endsWith("mcp-server.ts")) ||
  (process.argv[1] && process.argv[1].endsWith("mcp-server.js"));
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
