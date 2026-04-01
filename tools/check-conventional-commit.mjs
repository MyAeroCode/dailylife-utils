#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

const COMMIT_MESSAGE_PATTERN = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: .+/;

function main() {
  const messagePath = process.argv[2];

  if (!messagePath) {
    process.stderr.write("commit message file path is required\n");
    process.exit(1);
  }

  const rawMessage = fs.readFileSync(messagePath, "utf8");
  const firstLine = rawMessage
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#")) || "";

  if (COMMIT_MESSAGE_PATTERN.test(firstLine)) {
    process.exit(0);
  }

  process.stderr.write("Conventional commit check failed.\n");
  process.stderr.write(`Invalid commit message: "${firstLine}"\n`);
  process.stderr.write("Expected format: type(scope): summary\n");
  process.stderr.write("Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert\n");
  process.exit(1);
}

main();
