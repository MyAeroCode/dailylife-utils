#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
const ROOT_DIR = process.cwd();

function main() {
  const stagedFiles = getStagedFiles();
  const appNames = collectChangedApps(stagedFiles);

  if (appNames.length === 0) {
    process.exit(0);
  }

  const failures = [];

  for (const appName of appNames) {
    const appRoot = `apps/${appName}`;
    const packagePath = `${appRoot}/package.json`;
    const appFiles = stagedFiles.filter((filePath) => filePath.startsWith(`${appRoot}/`));
    const packageIsStaged = appFiles.includes(packagePath);

    if (!packageIsStaged) {
      failures.push(`${appName}: app files changed but ${packagePath} was not staged`);
      continue;
    }

    const stagedPackage = parsePackageJson(readGitBlob(`:${packagePath}`), packagePath);
    const nextVersion = stagedPackage.version;

    if (!isValidSemver(nextVersion)) {
      failures.push(`${appName}: version must be valid semver, got "${nextVersion}"`);
      continue;
    }

    const previousRaw = readGitBlobOptional(`HEAD:${packagePath}`);
    if (!previousRaw) {
      continue;
    }

    const previousPackage = parsePackageJson(previousRaw, packagePath);
    const previousVersion = previousPackage.version;

    if (!isValidSemver(previousVersion)) {
      failures.push(`${appName}: previous version is not valid semver, got "${previousVersion}"`);
      continue;
    }

    if (compareSemver(nextVersion, previousVersion) <= 0) {
      failures.push(`${appName}: version must increase (${previousVersion} -> ${nextVersion})`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write("App version check failed.\n");
    for (const failure of failures) {
      process.stderr.write(`- ${failure}\n`);
    }
    process.stderr.write("Bump the version in each changed app's package.json before committing.\n");
    process.exit(1);
  }
}

function getStagedFiles() {
  const output = execGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

function collectChangedApps(files) {
  const appNames = new Set();

  for (const filePath of files) {
    const match = filePath.match(/^apps\/([^/]+)\//);
    if (match) {
      appNames.add(match[1]);
    }
  }

  return Array.from(appNames).sort();
}

function parsePackageJson(raw, filePath) {
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON (${error.message})`);
  }

  if (!parsed || typeof parsed.version !== "string") {
    throw new Error(`${filePath}: missing string "version" field`);
  }

  return parsed;
}

function isValidSemver(version) {
  return SEMVER_PATTERN.test(version);
}

function compareSemver(left, right) {
  const [leftCore] = left.split("-");
  const [rightCore] = right.split("-");
  const leftParts = leftCore.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = rightCore.split(".").map((part) => Number.parseInt(part, 10));

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }

  if (left === right) {
    return 0;
  }

  if (!left.includes("-") && right.includes("-")) {
    return 1;
  }

  if (left.includes("-") && !right.includes("-")) {
    return -1;
  }

  return left.localeCompare(right);
}

function readGitBlob(spec) {
  return execGit(["show", spec]);
}

function readGitBlobOptional(spec) {
  try {
    return execGit(["show", spec]);
  } catch {
    return "";
  }
}

function execGit(args) {
  return execFileSync("git", args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

main();
