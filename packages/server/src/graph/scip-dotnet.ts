import { accessSync, constants as fsConstants, existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { findOnPath, parseCommandOverride, type ToolCommand } from "./toolchain.js";

/**
 * scip-dotnet is a .NET global tool we cannot bundle. Resolution order:
 * SCIP_DOTNET_CMD override, `scip-dotnet` on PATH, then the default global
 * tool location `~/.dotnet/tools`. Null = unavailable; callers degrade C#
 * jobs with a visible warning, never silently.
 */
export const SCIP_DOTNET_INSTALL_HINT =
  "install it with 'dotnet tool install --global scip-dotnet' (needs the .NET SDK 8 or newer), or set SCIP_DOTNET_CMD";

export function resolveScipDotnetCommand(env: NodeJS.ProcessEnv = process.env): ToolCommand | null {
  const override = parseCommandOverride(env.SCIP_DOTNET_CMD);
  if (override) return override;
  if (findOnPath("scip-dotnet", env)) return { argv0: "scip-dotnet", args: [] };
  const home = env.DOTNET_CLI_HOME ?? env.HOME;
  if (!home) return null;
  const tool = join(home, ".dotnet", "tools", "scip-dotnet");
  try {
    accessSync(tool, fsConstants.X_OK);
    return { argv0: tool, args: [] };
  } catch {
    return null;
  }
}

const SOLUTION_EXTS = [".slnx", ".sln", ".csproj"];

/**
 * The one file scip-dotnet indexes for a root: SCIP_DOTNET_SOLUTION when set,
 * else the single `.slnx`, else the single `.sln`, else the single `.csproj`.
 * A `.csproj` indexes only that project, so solutions win. Ambiguity is an
 * error the user resolves with SCIP_DOTNET_SOLUTION.
 */
export function pickSolutionFile(absRoot: string, override?: string): string {
  const chosen = override?.trim();
  if (chosen) {
    const path = isAbsolute(chosen) ? chosen : join(absRoot, chosen);
    if (!existsSync(path)) {
      throw new Error(`SCIP_DOTNET_SOLUTION points at '${chosen}', which does not exist under '${absRoot}'`);
    }
    return path;
  }
  const names = readdirSync(absRoot, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  for (const ext of SOLUTION_EXTS) {
    const found = names.filter((n) => n.endsWith(ext));
    if (found.length === 1) return join(absRoot, found[0]!);
    if (found.length > 1) {
      throw new Error(
        `multiple ${ext} files in '${absRoot}' (${found.join(", ")}); set SCIP_DOTNET_SOLUTION to choose one`,
      );
    }
  }
  throw new Error(`no .slnx, .sln or .csproj file in '${absRoot}'`);
}

/** scip-dotnet runs `dotnet restore` itself; generated sources under obj/ and bin/ are excluded. */
export function scipDotnetIndexArgs(solution: string, absRoot: string, indexPath: string): string[] {
  return [
    "index",
    solution,
    "--working-directory",
    absRoot,
    "--output",
    indexPath,
    "--exclude",
    "**/obj/**",
    "--exclude",
    "**/bin/**",
  ];
}
