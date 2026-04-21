import fs from "node:fs";
import path from "node:path";

const ENV_FILENAMES = [
  ".env.local",
  ".env.development.local",
  ".env.development",
  ".env",
];

let cachedEnvMap: Map<string, string> | null = null;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadLocalEnvMap(): Map<string, string> {
  if (cachedEnvMap) {
    return cachedEnvMap;
  }

  const envMap = new Map<string, string>();

  for (const filename of ENV_FILENAMES) {
    const filePath = path.join(process.cwd(), filename);
    if (!fs.existsSync(filePath)) continue;

    const raw = fs.readFileSync(filePath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) continue;

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = unquote(trimmed.slice(separatorIndex + 1));
      if (!key || envMap.has(key)) continue;
      envMap.set(key, value);
    }
  }

  cachedEnvMap = envMap;
  return envMap;
}

export function getEnvValue(name: string): string | undefined {
  const runtimeValue = process.env[name]?.trim();
  if (runtimeValue) return runtimeValue;

  const fileValue = loadLocalEnvMap().get(name)?.trim();
  return fileValue || undefined;
}
