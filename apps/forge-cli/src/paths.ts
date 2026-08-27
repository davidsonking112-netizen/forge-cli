import os from "node:os";
import path from "node:path";

function envPath(
  names: string[],
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return names.map((name) => environment[name]).find(Boolean);
}

export function forgeConfigDirectory(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const override = envPath(
    ["FORGE_CONFIG_HOME", "XDG_CONFIG_HOME"],
    environment,
  );
  if (override) return path.join(override, "forge");
  if (platform === "win32")
    return path.join(
      environment.APPDATA ?? path.join(homeDirectory, "AppData", "Roaming"),
      "forge",
    );
  return path.join(homeDirectory, ".config", "forge");
}

export function forgeStateDirectory(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const override = envPath(["FORGE_STATE_HOME", "XDG_STATE_HOME"], environment);
  if (override) return path.join(override, "forge");
  if (platform === "win32")
    return path.join(
      environment.LOCALAPPDATA ??
        environment.APPDATA ??
        path.join(homeDirectory, "AppData", "Local"),
      "forge",
    );
  return path.join(homeDirectory, ".local", "state", "forge");
}
