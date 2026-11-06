import { FastRunner, SlowRunner, AdminService, Runner } from "./runners.js";
import { QuickRunner } from "./reexport.js";

export function useFast(): string {
  const a = new FastRunner();
  return a.run();
}

export function useSlow(): string {
  const b = new SlowRunner();
  return b.run();
}

export function useAlias(): string {
  const c = new QuickRunner();
  return c.run();
}

export function useInterface(r: Runner): string {
  return r.run();
}

export function login(token: string): boolean {
  const svc = new AdminService();
  return svc.authenticate(token);
}

export function dynamic(target: Record<string, () => string>, key: string): string {
  return target[key]!();
}

export function reflective(obj: FastRunner): string {
  return obj.run.call(obj);
}
