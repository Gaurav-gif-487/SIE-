import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach } from "vitest";

/**
 * `Engine` persists analysis facts to a disk cache that defaults to
 * `$SIE_CACHE_DIR` or `~/.sie-cache`, keyed only by the repository's
 * absolute path (see src/knowledge/persist.ts). That default is correct for
 * real usage (a repeated query against an unchanged repo should be a disk
 * lookup, not a recompute), but it is machine-global: every test file in
 * this suite constructs `new Engine(REPO)` against the same handful of
 * fixture paths, so without isolation they all read and write the *same*
 * on-disk snapshot.
 *
 * That cross-test sharing is a real bug, not just theoretical: a test that
 * queries one symbol (touching only the analyses that symbol's task needs)
 * can persist a snapshot that a *different* test later hydrates and
 * mistakes for complete evidence toward its own, differently-scoped query
 * — silently skipping analyses (ResolveCalls, AnalyzeInheritance, …) it
 * actually needed and returning false negatives. Point every test at a
 * fresh, private cache directory so each test's engines only ever see
 * evidence produced within that same test.
 */
beforeEach(() => {
  process.env.SIE_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sie-test-cache-"));
});
