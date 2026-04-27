import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(projectRoot, "src");
const extensions = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"];

function resolveAliasPath(specifier) {
  if (!specifier.startsWith("@/")) return null;
  const target = path.join(srcRoot, specifier.slice(2));
  return resolveCandidatePath(target);
}

function resolveCandidatePath(target) {
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

function resolveRelativePath(specifier, parentURL) {
  if (!parentURL) return null;
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  if (!parentURL.startsWith("file://")) return null;
  const parentPath = fileURLToPath(parentURL);
  if (!parentPath.startsWith(projectRoot)) return null;
  const target = path.resolve(path.dirname(parentPath), specifier);
  return resolveCandidatePath(target);
}

export async function resolve(specifier, context, defaultResolve) {
  const resolvedPath = resolveAliasPath(specifier);
  if (resolvedPath) {
    return {
      shortCircuit: true,
      url: pathToFileURL(resolvedPath).href,
    };
  }

  const resolvedRelativePath = resolveRelativePath(specifier, context.parentURL);
  if (resolvedRelativePath) {
    return {
      shortCircuit: true,
      url: pathToFileURL(resolvedRelativePath).href,
    };
  }

  return defaultResolve(specifier, context, defaultResolve);
}
