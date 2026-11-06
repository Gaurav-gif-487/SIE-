import { execFileSync } from "node:child_process";
import { EvidenceStatus, Resolution, entityId } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { Counters } from "../cost/measure.js";

/**
 * Forge (GitHub / GitLab) ingestion.
 *
 * This adapter performs real HTTP requests against the forge API using a token
 * from the environment. There is no fixture, no cached sample payload and no
 * offline mode: without a remote, without credentials or without network the
 * result is an explicit unavailable state that the planner and the report
 * propagate as `source unavailable`.
 */

export type ForgeUnavailableReason =
  | "no-git-remote"
  | "unsupported-host"
  | "no-credentials"
  | "network-error"
  | "http-error";

export interface ForgeTarget {
  host: "github" | "gitlab";
  owner: string;
  repo: string;
  apiBase: string;
  tokenEnv: string;
}

export function detectForgeTarget(root: string): ForgeTarget | { unavailable: ForgeUnavailableReason } {
  let remote: string;
  try {
    remote = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return { unavailable: "no-git-remote" };
  }
  const match = /(?:https?:\/\/|git@)([^/:]+)[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  if (!match) return { unavailable: "no-git-remote" };
  const [, host, owner, repo] = match as unknown as [string, string, string, string];
  if (host.includes("github")) {
    return { host: "github", owner, repo, apiBase: "https://api.github.com", tokenEnv: "GITHUB_TOKEN" };
  }
  if (host.includes("gitlab")) {
    return { host: "gitlab", owner, repo, apiBase: `https://${host}/api/v4`, tokenEnv: "GITLAB_TOKEN" };
  }
  return { unavailable: "unsupported-host" };
}

export interface ForgeResult {
  available: boolean;
  reason?: ForgeUnavailableReason;
  host?: "github" | "gitlab";
  pullRequests: number;
  issues: number;
  linkedCommits: number;
}

interface ForgeItem {
  number: number;
  title: string;
  state: string;
  url: string;
  updatedAt: string;
  isPullRequest: boolean;
  mergeCommitSha?: string | null;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

/**
 * Ingests recent pull/merge requests and issues. Items are linked to Commit
 * entities when the forge reports a merge commit that this repository actually
 * contains; otherwise the item is stored without an edge rather than guessed.
 */
export async function acquireForgeData(
  root: string,
  store: KnowledgeStore,
  counters: Counters,
  options: { limit?: number } = {},
): Promise<ForgeResult> {
  const limit = options.limit ?? 50;
  const target = detectForgeTarget(root);
  if ("unavailable" in target) {
    store.addUnknown({
      kind: "no-forge-data",
      location: null,
      detail: `forge data unavailable: ${target.unavailable}`,
    });
    return { available: false, reason: target.unavailable, pullRequests: 0, issues: 0, linkedCommits: 0 };
  }
  const token = process.env[target.tokenEnv];
  if (!token) {
    store.addUnknown({
      kind: "no-forge-data",
      location: null,
      detail: `forge data unavailable: ${target.tokenEnv} is not set; PR/issue evidence is UNKNOWN`,
    });
    return { available: false, reason: "no-credentials", host: target.host, pullRequests: 0, issues: 0, linkedCommits: 0 };
  }

  const items: ForgeItem[] = [];
  try {
    if (target.host === "github") {
      const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
      const prs = (await fetchJson(
        `${target.apiBase}/repos/${target.owner}/${target.repo}/pulls?state=all&per_page=${limit}`,
        headers,
      )) as Array<Record<string, unknown>>;
      for (const pr of prs) {
        items.push({
          number: Number(pr.number),
          title: String(pr.title ?? ""),
          state: String(pr.state ?? ""),
          url: String(pr.html_url ?? ""),
          updatedAt: String(pr.updated_at ?? ""),
          isPullRequest: true,
          mergeCommitSha: (pr.merge_commit_sha as string | null) ?? null,
        });
      }
      const issues = (await fetchJson(
        `${target.apiBase}/repos/${target.owner}/${target.repo}/issues?state=all&per_page=${limit}`,
        headers,
      )) as Array<Record<string, unknown>>;
      for (const issue of issues) {
        if (issue.pull_request) continue;
        items.push({
          number: Number(issue.number),
          title: String(issue.title ?? ""),
          state: String(issue.state ?? ""),
          url: String(issue.html_url ?? ""),
          updatedAt: String(issue.updated_at ?? ""),
          isPullRequest: false,
        });
      }
    } else {
      const headers = { "PRIVATE-TOKEN": token };
      const project = encodeURIComponent(`${target.owner}/${target.repo}`);
      const mrs = (await fetchJson(
        `${target.apiBase}/projects/${project}/merge_requests?per_page=${limit}`,
        headers,
      )) as Array<Record<string, unknown>>;
      for (const mr of mrs) {
        items.push({
          number: Number(mr.iid),
          title: String(mr.title ?? ""),
          state: String(mr.state ?? ""),
          url: String(mr.web_url ?? ""),
          updatedAt: String(mr.updated_at ?? ""),
          isPullRequest: true,
          mergeCommitSha: (mr.merge_commit_sha as string | null) ?? null,
        });
      }
      const issues = (await fetchJson(
        `${target.apiBase}/projects/${project}/issues?per_page=${limit}`,
        headers,
      )) as Array<Record<string, unknown>>;
      for (const issue of issues) {
        items.push({
          number: Number(issue.iid),
          title: String(issue.title ?? ""),
          state: String(issue.state ?? ""),
          url: String(issue.web_url ?? ""),
          updatedAt: String(issue.updated_at ?? ""),
          isPullRequest: false,
        });
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason: ForgeUnavailableReason = /HTTP \d+/.test(detail) ? "http-error" : "network-error";
    store.addUnknown({ kind: "no-forge-data", location: null, detail: `forge request failed: ${detail}` });
    return { available: false, reason, host: target.host, pullRequests: 0, issues: 0, linkedCommits: 0 };
  }

  let linkedCommits = 0;
  for (const item of items) {
    const id = entityId(item.isPullRequest ? "PullRequest" : "Issue", `${target.host}#${item.number}`);
    store.putEntity({
      id,
      kind: item.isPullRequest ? "PullRequest" : "Issue",
      name: `#${item.number} ${item.title}`,
      attributes: { state: item.state, url: item.url, updatedAt: item.updatedAt, host: target.host },
    });
    store.addEvidence({
      fact: `${target.host} ${item.isPullRequest ? "pull request" : "issue"} #${item.number} "${item.title}" is ${item.state}`,
      source: item.url,
      sourceType: "forge",
      location: null,
      revision: store.revision,
      derivation: "forge-api",
      status: EvidenceStatus.RESOLVED,
      producedBy: "IngestForgeData",
      supports: [id],
    });
    counters.symbolsProcessed += 1;
    const sha = item.mergeCommitSha;
    if (sha) {
      const commitId = entityId("Commit", sha);
      if (store.hasEntity(commitId)) {
        store.putRelation({
          kind: "CHANGED_BY",
          from: id,
          to: commitId,
          resolution: Resolution.EXACT,
          attributes: { via: "merge_commit_sha" },
        });
        linkedCommits += 1;
      }
    }
  }

  return {
    available: true,
    host: target.host,
    pullRequests: items.filter((i) => i.isPullRequest).length,
    issues: items.filter((i) => !i.isPullRequest).length,
    linkedCommits,
  };
}
