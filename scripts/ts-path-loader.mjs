import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(projectRoot, "src");
const extensions = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"];

function resolveAliasPath(specifier) {
  if (!specifier.startsWith("@/")) return null;
  const target = path.join(srcRoot, specifier.slice(2));
  const directFile = fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;
  if (directFile) return directFile;

  for (const extension of extensions) {
    const candidate = `${target}${extension}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  for (const extension of extensions) {
    const candidate = path.join(target, `index${extension}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return target;
}

export async function resolve(specifier, context, defaultResolve) {
  const resolvedPath = resolveAliasPath(specifier);
  if (resolvedPath) {
    return {
      shortCircuit: true,
      url: pathToFileURL(resolvedPath).href,
    };
  }

  return defaultResolve(specifier, context, defaultResolve);
}
