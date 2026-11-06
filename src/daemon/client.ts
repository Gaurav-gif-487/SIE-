import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonRequest, DaemonResponse, pidFile, socketPath } from "./protocol.js";

let nextId = 1;

function sendOnce(req: DaemonRequest, timeoutMs = 4000): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const sock = socketPath();
    const conn = net.createConnection(sock);
    let buffer = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("daemon request timed out"));
    }, timeoutMs);
    conn.on("connect", () => conn.write(`${JSON.stringify(req)}\n`));
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        clearTimeout(timer);
        conn.end();
        try {
          resolve(JSON.parse(buffer.slice(0, idx)) as DaemonResponse);
        } catch (err) {
          reject(err);
        }
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** True if a daemon is listening and responds to ping within a short timeout. */
export async function isDaemonRunning(): Promise<boolean> {
  if (!fs.existsSync(socketPath())) return false;
  try {
    const res = await sendOnce({ id: nextId++, kind: "ping" }, 800);
    return res.ok;
  } catch {
    return false;
  }
}

export async function daemonStatus(): Promise<DaemonResponse | null> {
  try {
    return await sendOnce({ id: nextId++, kind: "ping" }, 800);
  } catch {
    return null;
  }
}

/** Invoke an Engine method through the daemon. Throws if the daemon isn't reachable — callers should fall back to a local Engine. */
export async function callDaemon(
  root: string,
  method: string,
  args: unknown[],
  engineOptions?: Record<string, unknown>,
): Promise<unknown> {
  const res = await sendOnce({ id: nextId++, kind: "call", root, method, args, engineOptions });
  if (!res.ok) throw new Error(res.error ?? "daemon call failed");
  return res.result;
}

export async function stopDaemon(): Promise<boolean> {
  try {
    const res = await sendOnce({ id: nextId++, kind: "shutdown" }, 800);
    return res.ok;
  } catch {
    return false;
  }
}

function findPackageRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

/** Build the spawn command for the daemon server, matching how this process itself was launched (compiled JS vs. tsx-run TypeScript source). */
function daemonSpawnCommand(here: string): { cmd: string; args: string[] } {
  const compiled = path.join(here, "server.js");
  if (fs.existsSync(compiled)) return { cmd: process.execPath, args: [compiled] };

  const source = path.join(here, "server.ts");
  const root = findPackageRoot(here);
  const tsx = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (fs.existsSync(tsx)) return { cmd: tsx, args: [source] };

  throw new Error(
    "cannot locate a daemon entry point to spawn (looked for server.js next to server.ts, and tsx in node_modules/.bin). " +
      "Run `npx tsx src/daemon/server.ts` manually instead, or build the project first.",
  );
}

/** Spawn the daemon as a detached background process. Returns once it's accepting connections, or throws after a timeout. */
export async function startDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { cmd, args } = daemonSpawnCommand(here);
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await isDaemonRunning()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not start in time (pid file: ${pidFile()})`);
}
