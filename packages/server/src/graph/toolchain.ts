import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";

/** An external indexer launcher: argv0 may be a bare name re-resolved on PATH at spawn time. */
export interface ToolCommand {
  argv0: string;
  args: string[];
}

/** `SCIP_*_CMD` overrides are whitespace-split and used verbatim; unset/blank → undefined. */
export function parseCommandOverride(raw: string | undefined): ToolCommand | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  // A trimmed non-empty string splits into a non-empty first element.
  const [argv0, ...args] = trimmed.split(/\s+/) as [string, ...string[]];
  return { argv0, args };
}

export function findOnPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), fsConstants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}
