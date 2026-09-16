// Lists current-target production packages for Docker's offline prune store seed.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const specs = new Set();
const target = {
  cpu: process.arch,
  libc: detectLibc(),
  os: process.platform,
};

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
  if (normalizedVersion.startsWith("npm:")) {
    return normalizedVersion.slice("npm:".length);
  }
  if (normalizedVersion.startsWith("@")) {
    return normalizedVersion;
  }
  return `${name}@${normalizedVersion}`;
}

function detectLibc() {
  if (process.platform !== "linux") {
    return undefined;
  }
  const report = process.report?.getReport?.();
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function matchesTargetSelector(selector, value) {
  if (!Array.isArray(selector) || !value) {
    return true;
  }
  const blocked = selector.some((entry) => entry === `!${value}`);
  if (blocked) {
    return false;
  }
  const allowed = selector.filter((entry) => typeof entry === "string" && !entry.startsWith("!"));
  return allowed.length === 0 || allowed.includes(value);
}

function packageEntryForSpec(lockfile, spec) {
  return lockfile?.packages?.[spec] ?? lockfile?.packages?.[`/${spec}`];
}

function normalizeLockfilePackageKey(key) {
  if (typeof key !== "string") {
    return undefined;
  }
  return (key.startsWith("/") ? key.slice(1) : key).replace(/\(.+\)$/, "");
}

function packageSpecFromLockfileKey(key) {
  const normalizedKey = normalizeLockfilePackageKey(key);
  if (!normalizedKey) {
    return undefined;
  }
  const separator = normalizedKey.lastIndexOf("@");
  if (separator <= 0) {
    return undefined;
  }
  return packageSpec(normalizedKey.slice(0, separator), normalizedKey.slice(separator + 1));
}

function snapshotForSpec(lockfile, spec) {
  const snapshots = lockfile?.snapshots;
  if (!snapshots) {
    return undefined;
  }
  return (
    snapshots[spec] ??
    snapshots[`/${spec}`] ??
    Object.entries(snapshots).find(([key]) => normalizeLockfilePackageKey(key) === spec)?.[1]
  );
}

function packageSupportsTarget(lockfile, spec) {
  const entry = packageEntryForSpec(lockfile, spec);
  return (
    matchesTargetSelector(entry?.os, target.os) &&
    matchesTargetSelector(entry?.cpu, target.cpu) &&
    matchesTargetSelector(entry?.libc, target.libc)
  );
}

function addSpec(lockfile, spec) {
  if (spec && packageSupportsTarget(lockfile, spec)) {
    specs.add(spec);
  }
}

function parseListRoots() {
  const input = fs.readFileSync(0, "utf8").trim();
  if (!input) {
    return [];
  }
  const parsed = JSON.parse(input);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function visitListNode(lockfile, node) {
  for (const dep of Object.values(node.dependencies ?? {})) {
    const name = dep.from || dep.name;
    const spec = packageSpec(name, dep.version);
    if (spec && dep.resolved?.startsWith("https://registry.npmjs.org/")) {
      addSpec(lockfile, spec);
    }
    visitListNode(lockfile, dep);
  }
}

function addImporterRoots(lockfile) {
  for (const importer of Object.values(lockfile?.importers ?? {})) {
    for (const deps of [importer.dependencies, importer.optionalDependencies]) {
      for (const [name, dep] of Object.entries(deps ?? {})) {
        addSpec(lockfile, packageSpec(name, dep?.version));
      }
    }
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
    const snapshot = snapshotForSpec(lockfile, spec);
    if (!snapshot) {
      continue;
    }
    const addDependencySpec = (name, version) => {
      const depSpec = packageSpec(name, typeof version === "string" ? version : version?.version);
      if (
        !depSpec ||
        !packages[depSpec] ||
        specs.has(depSpec) ||
        !packageSupportsTarget(lockfile, depSpec)
      ) {
        return;
      }
      if (!packageMatchesBuildPlatform(packages[depSpec])) {
        return;
      }
      specs.add(depSpec);
      pending.push(depSpec);
    };
    for (const [name, version] of Object.entries(snapshot.dependencies ?? {})) {
      addDependencySpec(name, version);
    }
    for (const [name, version] of Object.entries(snapshot.optionalDependencies ?? {})) {
      addDependencySpec(name, version);
    }
  }
}

const lockfile = readLockfile();
for (const root of parseListRoots()) {
  visitListNode(lockfile, root);
}
addImporterRoots(lockfile);
addSnapshotClosure(lockfile);

process.stdout.write([...specs].toSorted((a, b) => a.localeCompare(b)).join("\n"));
