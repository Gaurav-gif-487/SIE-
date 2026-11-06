/**
 * Language capability metadata.
 *
 * A language appears here only with the capabilities that are actually
 * implemented and covered by a fixture test. Nothing in this table is
 * aspirational: `false` means the engine will refuse to answer rather than
 * degrade silently to name matching.
 */

export interface LanguageCapability {
  language: string;
  extensions: string[];
  parserSupported: boolean;
  symbolSupport: boolean;
  typeResolution: boolean;
  callResolution: boolean;
  crossFileResolution: boolean;
  parser: string | null;
  note: string;
}

export const LANGUAGE_CAPABILITIES: LanguageCapability[] = [
  {
    language: "TypeScript",
    extensions: [".ts", ".mts", ".cts"],
    parserSupported: true,
    symbolSupport: true,
    typeResolution: true,
    callResolution: true,
    crossFileResolution: true,
    parser: "typescript (compiler API + type checker)",
    note: "full type-aware resolution including aliases and re-exports",
  },
  {
    language: "TSX",
    extensions: [".tsx"],
    parserSupported: true,
    symbolSupport: true,
    typeResolution: true,
    callResolution: true,
    crossFileResolution: true,
    parser: "typescript (compiler API + type checker)",
    note: "same pipeline as TypeScript; JSX elements are not treated as calls",
  },
  {
    language: "JavaScript",
    extensions: [".js", ".mjs", ".cjs", ".jsx"],
    parserSupported: true,
    symbolSupport: true,
    typeResolution: false,
    callResolution: true,
    crossFileResolution: true,
    parser: "typescript (allowJs, checkJs off)",
    note: "inferred types only where the checker can infer them; receiver types are frequently `any`, which the engine reports as PARTIAL rather than EXACT",
  },
  {
    language: "Python",
    extensions: [".py"],
    parserSupported: true,
    symbolSupport: true,
    typeResolution: false,
    callResolution: true,
    crossFileResolution: false,
    parser: "python3 stdlib ast (subprocess, independent of the TS pipeline)",
    note:
      "functions/methods/classes and CALLS edges are name-based only, never type-resolved: a single name match is reported PARTIAL (never EXACT), 2+ matches are reported AMBIGUOUS rather than guessed. Import resolution only matches modules discovered in this same repository scan (no sys.path, no installed packages, no namespace packages) -- anything else is UNRESOLVED with `external: true`, never assumed. Acquisition-layer only: not wired into the planner, crystallization levels, CLI, or MCP server yet (see src/acquisition/python.ts for why).",
  },
];

export function capabilityForFile(file: string): LanguageCapability | null {
  const lower = file.toLowerCase();
  return (
    LANGUAGE_CAPABILITIES.find((cap) => cap.extensions.some((ext) => lower.endsWith(ext))) ?? null
  );
}

/** Languages a caller may ask about that this engine deliberately does not claim. */
export const UNSUPPORTED_LANGUAGES = [
  "Go",
  "Rust",
  "Java",
  "C#",
  "C/C++",
  "Ruby",
  "PHP",
  "Kotlin",
  "Swift",
] as const;

export function capabilityReport(): {
  supported: LanguageCapability[];
  unsupported: { language: string; reason: string }[];
} {
  return {
    supported: LANGUAGE_CAPABILITIES,
    unsupported: UNSUPPORTED_LANGUAGES.map((language) => ({
      language,
      reason:
        "no parser is installed in this engine; symbol, type and call resolution would be name-based, which this engine does not ship",
    })),
  };
}
