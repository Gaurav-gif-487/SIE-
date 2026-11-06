/**
 * Secret redaction engine.
 *
 * Applied to all trajectory event payloads before recording.
 * Default patterns cover API keys, passwords, tokens, env vars, credentials.
 * Custom patterns can be added via RedactionConfig.
 */

import type { RedactionConfig, RedactionPattern } from "../types.js";

const DEFAULT_PATTERNS: RedactionPattern[] = [
  {
    name: "api_key_header",
    pattern: "(?i)(api[_-]?key|apikey)[\"'\\s:=]+[\"']?([a-zA-Z0-9_\\-]{16,})[\"']?",
    replacement: "$1=[REDACTED]",
  },
  {
    name: "bearer_token",
    pattern: "(?i)(bearer\\s+)([a-zA-Z0-9_\\-\\.]{16,})",
    replacement: "$1[REDACTED]",
  },
  {
    name: "authorization_header",
    pattern: "(?i)(authorization)[\"'\\s:=]+[\"']?([a-zA-Z0-9_\\-\\. ]{16,})[\"']?",
    replacement: "$1=[REDACTED]",
  },
  {
    name: "password_field",
    pattern: "(?i)(password|passwd|pwd)[\"'\\s:=]+[\"']?([^\"'\\s,}{]{4,})[\"']?",
    replacement: "$1=[REDACTED]",
  },
  {
    name: "token_field",
    pattern: "(?i)(token|secret|access_token|refresh_token|client_secret)[\"'\\s:=]+[\"']?([a-zA-Z0-9_\\-\\.]{8,})[\"']?",
    replacement: "$1=[REDACTED]",
  },
  {
    name: "aws_key",
    pattern: "(?:AKIA|ASIA)[A-Z0-9]{16}",
    replacement: "[REDACTED_AWS_KEY]",
  },
  {
    name: "private_key_block",
    pattern: "-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----",
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    name: "github_token",
    pattern: "(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}",
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    name: "generic_secret_assignment",
    pattern: "(?i)(secret|credential|cred)[\"'\\s:=]+[\"']?([^\"'\\s,}{]{8,})[\"']?",
    replacement: "$1=[REDACTED]",
  },
];

/**
 * Compiled redaction pattern with pre-built RegExp.
 */
interface CompiledPattern {
  name: string;
  regex: RegExp;
  replacement: string;
}

export class Redactor {
  private readonly patterns: CompiledPattern[];
  private readonly redactEnvVars: boolean;
  /** Environment variable names to always redact */
  private readonly envVarNames: Set<string>;

  constructor(config?: Partial<RedactionConfig>) {
    const patternDefs = config?.patterns ?? DEFAULT_PATTERNS;
    this.redactEnvVars = config?.redact_env_vars ?? true;
    this.patterns = [];

    for (const p of patternDefs) {
      try {
        // Node 20+ supports the 'v' flag; fall back to 'u' if not available.
        // The (?i) inline flag in the pattern string is not supported in JS
        // RegExp — strip it and use the 'i' flag on the RegExp itself.
        let source = p.pattern;
        let flags = "g";
        if (source.startsWith("(?i)")) {
          source = source.slice(4);
          flags = "gi";
        }
        this.patterns.push({ name: p.name, regex: new RegExp(source, flags), replacement: p.replacement });
      } catch {
        // Skip patterns that fail to compile (defensive)
      }
    }

    // Common env vars that are sensitive
    this.envVarNames = new Set([
      "API_KEY",
      "SECRET_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
      "DATABASE_URL",
      "DB_PASSWORD",
      "PRIVATE_KEY",
      "NPM_TOKEN",
    ]);
  }

  /**
   * Redact secrets from a string.
   */
  redactString(input: string): string {
    let result = input;
    for (const p of this.patterns) {
      // Reset lastIndex for global regexes
      p.regex.lastIndex = 0;
      result = result.replace(p.regex, p.replacement);
    }
    if (this.redactEnvVars) {
      result = this.redactEnvironmentVariables(result);
    }
    return result;
  }

  /**
   * Redact secrets from an arbitrary payload object (deep).
   * Returns a new object; the original is not mutated.
   */
  redactPayload<T>(payload: T): T {
    if (payload === null || payload === undefined) return payload;
    if (typeof payload === "string") return this.redactString(payload) as T;
    if (typeof payload === "number" || typeof payload === "boolean") return payload;
    if (Array.isArray(payload)) return payload.map((item) => this.redactPayload(item)) as T;
    if (typeof payload === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        // Redact the key name itself if it looks sensitive
        if (this.isSensitiveKey(key) && typeof value === "string") {
          result[key] = "[REDACTED]";
        } else {
          result[key] = this.redactPayload(value);
        }
      }
      return result as T;
    }
    return payload;
  }

  /**
   * Check if a key name suggests a sensitive value.
   */
  private isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase();
    return (
      lower.includes("password") ||
      lower.includes("passwd") ||
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("api_key") ||
      lower.includes("apikey") ||
      lower.includes("private_key") ||
      lower.includes("credential") ||
      lower.includes("auth")
    );
  }

  /**
   * Replace environment variable values that appear in the string.
   */
  private redactEnvironmentVariables(input: string): string {
    let result = input;
    for (const name of this.envVarNames) {
      const value = process.env[name];
      if (value && value.length >= 4) {
        // Only redact if the value actually appears in the string
        while (result.includes(value)) {
          result = result.replace(value, `[REDACTED_ENV:${name}]`);
        }
      }
    }
    return result;
  }
}
