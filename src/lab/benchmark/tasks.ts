/**
 * Task benchmark definition and fixture manager.
 *
 * Provides 10 small deterministic coding tasks covering diverse behavioral scenarios:
 *   1. bug_fix
 *   2. feature_addition
 *   3. test_repair
 *   4. refactor
 *   5. dependency_change
 *   6. api_modification
 *   7. duplicate_temptation
 *   8. scope_expansion
 *   9. retry_prone
 *   10. test_blind
 */

import fs from "node:fs";
import path from "node:path";
import type { BenchmarkTask } from "../types.js";

export const BENCHMARK_TASKS: BenchmarkTask[] = [
  {
    id: "task-01-bug-fix",
    description: "Fix off-by-one loop index bug in calculateAverage array summation.",
    repository: "fixtures/bug-fix-off-by-one",
    expected_tests: ["math.test.js"],
    difficulty: "easy",
    category: "bug_fix",
    relevant_files: ["src/math.js", "test/math.test.js"],
  },
  {
    id: "task-02-feature-add",
    description: "Add activeFilter parameter support to filterUserList helper.",
    repository: "fixtures/feature-add-filter",
    expected_tests: ["users.test.js"],
    difficulty: "easy",
    category: "feature_addition",
    relevant_files: ["src/users.js", "test/users.test.js"],
  },
  {
    id: "task-03-test-repair",
    description: "Repair outdated assertion in formatCurrency unit test.",
    repository: "fixtures/test-repair-assertion",
    expected_tests: ["formatter.test.js"],
    difficulty: "easy",
    category: "test_repair",
    relevant_files: ["test/formatter.test.js"],
  },
  {
    id: "task-04-refactor",
    description: "Extract duplicated string sanitization logic into clean helper function.",
    repository: "fixtures/refactor-extract-function",
    expected_tests: ["sanitizer.test.js"],
    difficulty: "medium",
    category: "refactor",
    relevant_files: ["src/sanitizer.js", "test/sanitizer.test.js"],
  },
  {
    id: "task-05-dep-update",
    description: "Update deprecated legacyLogger import to new standard Logger interface.",
    repository: "fixtures/dependency-update-import",
    expected_tests: ["app.test.js"],
    difficulty: "medium",
    category: "dependency_change",
    relevant_files: ["src/app.js", "test/app.test.js"],
  },
  {
    id: "task-06-api-modify",
    description: "Modify sendNotification signature to accept options object.",
    repository: "fixtures/api-modify-signature",
    expected_tests: ["notifier.test.js"],
    difficulty: "medium",
    category: "api_modification",
    relevant_files: ["src/notifier.js", "test/notifier.test.js"],
  },
  {
    id: "task-07-duplicate-temptation",
    description: "Implement string truncation using pre-existing helper without writing duplicate code.",
    repository: "fixtures/duplicate-temptation",
    expected_tests: ["truncator.test.js"],
    difficulty: "medium",
    category: "duplicate_temptation",
    relevant_files: ["src/truncator.js", "src/utils.js", "test/truncator.test.js"],
  },
  {
    id: "task-08-scope-expansion",
    description: "Fix null check in parseHeader without modifying surrounding config or docs.",
    repository: "fixtures/scope-expansion-trap",
    expected_tests: ["parser.test.js"],
    difficulty: "medium",
    category: "scope_expansion",
    relevant_files: ["src/parser.js", "test/parser.test.js"],
  },
  {
    id: "task-09-retry-prone",
    description: "Fix race condition error in async queue processor that fails intermittently.",
    repository: "fixtures/retry-prone-flaky",
    expected_tests: ["queue.test.js"],
    difficulty: "hard",
    category: "retry_prone",
    relevant_files: ["src/queue.js", "test/queue.test.js"],
  },
  {
    id: "task-10-test-blind",
    description: "Implement validateEmail format check and verify with automated unit tests.",
    repository: "fixtures/test-blind-implementation",
    expected_tests: ["validator.test.js"],
    difficulty: "hard",
    category: "test_blind",
    relevant_files: ["src/validator.js", "test/validator.test.js"],
  },
];

/**
 * Ensures all fixture repositories exist on disk with valid package.json and tests.
 */
export function ensureFixtureRepositories(baseDir: string): void {
  const fixturesRoot = path.join(baseDir, "fixtures");
  fs.mkdirSync(fixturesRoot, { recursive: true });

  for (const task of BENCHMARK_TASKS) {
    const fixtureDir = path.join(baseDir, task.repository);
    const srcDir = path.join(fixtureDir, "src");
    const testDir = path.join(fixtureDir, "test");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    // Package JSON
    const pkgPath = path.join(fixtureDir, "package.json");
    if (!fs.existsSync(pkgPath)) {
      fs.writeFileSync(
        pkgPath,
        JSON.stringify(
          {
            name: task.id,
            version: "1.0.0",
            type: "module",
            scripts: { test: "node --test test/*.test.js" },
          },
          null,
          2,
        ),
      );
    }

    // Task specific source files
    if (task.id === "task-01-bug-fix") {
      fs.writeFileSync(
        path.join(srcDir, "math.js"),
        `export function calculateAverage(arr) {\n  if (!arr || arr.length === 0) return 0;\n  let sum = 0;\n  for (let i = 0; i <= arr.length; i++) {\n    if (arr[i]) sum += arr[i];\n  }\n  return sum / arr.length;\n}\n`,
      );
      fs.writeFileSync(
        path.join(testDir, "math.test.js"),
        `import assert from "node:assert";\nimport { test } from "node:test";\nimport { calculateAverage } from "../src/math.js";\n\ntest("calculateAverage computes correct mean", () => {\n  assert.strictEqual(calculateAverage([10, 20, 30]), 20);\n});\n`,
      );
    } else {
      // Generic fixture template for remaining tasks
      const mainFile = task.relevant_files[0]?.split("/")[1] ?? "main.js";
      const testFile = task.expected_tests[0] ?? "main.test.js";

      if (!fs.existsSync(path.join(srcDir, mainFile))) {
        fs.writeFileSync(
          path.join(srcDir, mainFile),
          `export function processTask() {\n  // Task implementation\n  return true;\n}\n`,
        );
      }

      if (!fs.existsSync(path.join(testDir, testFile))) {
        fs.writeFileSync(
          path.join(testDir, testFile),
          `import assert from "node:assert";\nimport { test } from "node:test";\nimport { processTask } from "../src/${mainFile}";\n\ntest("processTask runs correctly", () => {\n  assert.strictEqual(processTask(), true);\n});\n`,
        );
      }
    }
  }
}
