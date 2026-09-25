import type { FinnskModule } from "./types";

/**
 * Built-in modules. Content types use core Collections — no fixed blog module.
 * Add packages under packages/modules/* and register here.
 */
export const MODULE_REGISTRY: FinnskModule[] = [];

export function getModule(id: string): FinnskModule | undefined {
  return MODULE_REGISTRY.find((m) => m.id === id);
}

export function listRegisteredModules(): FinnskModule[] {
  return MODULE_REGISTRY.slice();
}
