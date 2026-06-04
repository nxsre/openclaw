import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const parsed = JSON.parse(fs.readFileSync(0, "utf8"));
const roots = Array.isArray(parsed) ? parsed : [parsed];
const specs = new Set();

// Per-platform optional deps in the lockfile (e.g. @anthropic-ai/claude-agent-sdk-win32-x64,
// @lancedb/lancedb-darwin-arm64, @openai/codex-*-darwin-*) should not be pre-fetched into the
// store on a single-arch Docker build — `pnpm store add` would time out hitting the mirror for
// tarballs we will never need. The lockfile records explicit `os` / `cpu` / `libc` constraints
// on those entries; skip any that don't match this build host.
const TARGET_OS = process.env.OPENCLAW_STORE_TARGET_OS?.trim() || process.platform; // e.g. "linux"
const TARGET_CPU = process.env.OPENCLAW_STORE_TARGET_CPU?.trim() || process.arch; // e.g. "x64" | "arm64"
const TARGET_LIBC = process.env.OPENCLAW_STORE_TARGET_LIBC?.trim() || "glibc";

function constraintMatches(field, target) {
  if (field === undefined || field === null) {
    return true;
  }
  const list = Array.isArray(field) ? field : [field];
  if (list.length === 0) {
    return true;
  }
  return list.some((value) => {
    if (typeof value !== "string") {
      return false;
    }
    if (value === "current" || value === target) {
      return true;
    }
    // Lockfiles can express negation like "!win32" (npm convention). Treat any
    // non-matching negation as a positive signal.
    return value.startsWith("!") && value.slice(1) !== target;
  });
}

function packageMatchesBuildPlatform(pkg) {
  if (!pkg || typeof pkg !== "object") {
    return true;
  }
  return (
    constraintMatches(pkg.os, TARGET_OS) &&
    constraintMatches(pkg.cpu, TARGET_CPU) &&
    constraintMatches(pkg.libc, TARGET_LIBC)
  );
}

function packageSpec(name, version) {
  if (!name || !version || typeof version !== "string") {
    return undefined;
  }
  const normalizedVersion = version.replace(/\(.+\)$/, "");
  if (
    normalizedVersion.startsWith("file:") ||
    normalizedVersion.startsWith("link:") ||
    normalizedVersion.startsWith("workspace:")
  ) {
    return undefined;
  }
  return `${name}@${normalizedVersion}`;
}

function packageSpecFromLockfileKey(key) {
  if (typeof key !== "string") {
    return undefined;
  }
  const normalizedKey = (key.startsWith("/") ? key.slice(1) : key).replace(/\(.+\)$/, "");
  const separator = normalizedKey.lastIndexOf("@");
  if (separator <= 0) {
    return undefined;
  }
  return packageSpec(normalizedKey.slice(0, separator), normalizedKey.slice(separator + 1));
}

function visitListNode(node) {
  for (const dep of Object.values(node.dependencies ?? {})) {
    const name = dep.from || dep.name;
    const spec = packageSpec(name, dep.version);
    if (spec && dep.resolved?.startsWith("https://registry.npmjs.org/")) {
      specs.add(spec);
    }
    visitListNode(dep);
  }
}

function readLockfile() {
  const lockfilePath = path.join(process.cwd(), "pnpm-lock.yaml");
  if (!fs.existsSync(lockfilePath)) {
    return undefined;
  }
  return parse(fs.readFileSync(lockfilePath, "utf8"));
}

function addLockfilePackages(lockfile) {
  const packages = lockfile?.packages ?? {};
  for (const [key, pkg] of Object.entries(packages)) {
    const spec = packageSpecFromLockfileKey(key);
    if (!spec) {
      continue;
    }
    if (!packageMatchesBuildPlatform(pkg)) {
      continue;
    }
    specs.add(spec);
  }
}

function addSnapshotClosure(lockfile) {
  const snapshots = lockfile?.snapshots;
  const packages = lockfile?.packages;
  if (!snapshots || !packages) {
    return;
  }
  const pending = [...specs];
  const visited = new Set();
  while (pending.length > 0) {
    const spec = pending.pop();
    if (!spec || visited.has(spec)) {
      continue;
    }
    visited.add(spec);
    const snapshot = snapshots[spec];
    if (!snapshot) {
      continue;
    }
    for (const [name, version] of Object.entries(snapshot.dependencies ?? {})) {
      const depSpec = packageSpec(name, typeof version === "string" ? version : version?.version);
      if (!depSpec || !packages[depSpec] || specs.has(depSpec)) {
        continue;
      }
      if (!packageMatchesBuildPlatform(packages[depSpec])) {
        continue;
      }
      specs.add(depSpec);
      pending.push(depSpec);
    }
  }
}

for (const root of roots) {
  visitListNode(root);
}
const lockfile = readLockfile();
addSnapshotClosure(lockfile);
addLockfilePackages(lockfile);

process.stdout.write([...specs].toSorted((a, b) => a.localeCompare(b)).join("\n"));
