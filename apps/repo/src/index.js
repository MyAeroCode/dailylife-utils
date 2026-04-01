#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const APP_NAME = "repo";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG_PATH = path.join(APP_DIR, "config", "repo-paths.json");
const SELECTION_FILE_ENV = "REPO_SELECTED_PATH_FILE";
const DELETE_WORKER_COMMAND = "delete-worker";
const DISPLAY_PATH_PREFIXES = [
  path.join(os.homedir(), "projects") + path.sep,
];
const HANGUL_COMMAND_KEY_ALIASES = {
  "ㅂ": "q",
  "ㅃ": "Q",
  "ㅇ": "d",
  "ㅏ": "k",
  "ㅓ": "j",
  "ㅐ": "o",
  "ㅒ": "O",
  "ㅍ": "v",
  "ㅎ": "g",
};
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  fgMuted: "\x1b[38;5;245m",
  fgAccent: "\x1b[38;5;117m",
  fgFocus: "\x1b[38;5;231m",
  fgInput: "\x1b[38;5;255m",
  fgChip: "\x1b[38;5;255m",
  fgDanger: "\x1b[38;5;224m",
  fgSelection: "\x1b[38;5;255m",
  bgFocus: "\x1b[48;5;31m",
  bgInput: "\x1b[48;5;236m",
  bgInputActive: "\x1b[48;5;24m",
  bgChip: "\x1b[48;5;25m",
  bgJump: "\x1b[48;5;52m",
  bgDanger: "\x1b[48;5;88m",
  bgSelection: "\x1b[48;5;60m",
};
const HELP_TEXT = `repo

Usage:
  repo [select] [--plain|--json] [--query <text>] [--index <n>] [--config <path>]
  repo list [--plain|--json] [--config <path>]
  repo shell-init <zsh|bash>
  repo help

Commands:
  select     Interactive selector by default. Prints the selected path with --plain/--json.
  list       Lists discovered GitHub repositories.
  shell-init Prints a shell wrapper so the current shell can cd into the selected repository.

Flags:
  --config <path>  Override config file path. Default: ${DEFAULT_CONFIG_PATH}
  --json           Emit JSON for AI/non-interactive usage.
  --plain          Emit only the selected path or a plain text list.
  --query <text>   Filter repositories by name/path/origin.
  --index <n>      Pick the nth result after filtering (1-based).
`;

function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === DELETE_WORKER_COMMAND) {
    runDeleteWorker(parsed.flags.input);
    return;
  }

  if (parsed.flags.help || parsed.command === "help") {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  if (parsed.command === "shell-init") {
    const shell = parsed.positionals[0] || "zsh";
    process.stdout.write(buildShellInit(shell));
    return;
  }

  const configPath = parsed.flags.config ? resolvePath(parsed.flags.config) : DEFAULT_CONFIG_PATH;
  const config = loadConfig(configPath);
  const repos = discoverRepos(config.paths);
  const filtered = filterRepos(repos, parsed.flags.query);

  if (parsed.command === "list") {
    renderList(filtered, parsed.flags);
    return;
  }

  if (parsed.flags.index != null || parsed.flags.json || parsed.flags.plain || !process.stdout.isTTY || !process.stdin.isTTY) {
    const selected = pickRepo(filtered, parsed.flags.index);
    renderSelection(selected, parsed.flags);
    process.exit(selected ? 0 : 1);
  }

  runInteractiveSelector(repos, parsed.flags.query, config.ide)
    .then((selected) => {
      if (!selected) {
        process.exit(1);
      }

      finalizeSelection(selected, { suppressStdout: Boolean(process.env[SELECTION_FILE_ENV]) });
    })
    .catch((error) => {
      logError(error.message);
      process.exit(1);
    });
}

function parseArgs(argv) {
  const flags = {
    config: undefined,
    help: false,
    index: undefined,
    json: false,
    plain: false,
    query: "",
  };

  const positionals = [];
  let command = "select";

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--config") {
      flags.config = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--query") {
      flags.query = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (value === "--index") {
      const raw = argv[index + 1];
      flags.index = raw == null ? undefined : Number.parseInt(raw, 10);
      index += 1;
      continue;
    }

    if (value === "--input") {
      flags.input = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--json") {
      flags.json = true;
      continue;
    }

    if (value === "--plain") {
      flags.plain = true;
      continue;
    }

    if (value === "--help" || value === "-h") {
      flags.help = true;
      continue;
    }

    if (value.startsWith("--")) {
      throw new Error(`unknown flag: ${value}`);
    }

    positionals.push(value);
  }

  if (positionals[0] && ["list", "select", "shell-init", "help", DELETE_WORKER_COMMAND].includes(positionals[0])) {
    command = positionals.shift();
  }

  return { command, flags, positionals };
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`config not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || !Array.isArray(parsed.paths)) {
    throw new Error(`config must contain a "paths" array: ${configPath}`);
  }

  return {
    ide: normalizeIdeConfig(parsed.ide),
    path: configPath,
    paths: parsed.paths.map((entry) => resolvePath(String(entry))),
  };
}

function normalizeIdeConfig(ide) {
  if (ide == null) {
    return { command: "code", args: ["-r"] };
  }

  if (typeof ide === "string") {
    const command = ide.trim();
    return command ? { command, args: [] } : null;
  }

  if (typeof ide === "object" && !Array.isArray(ide)) {
    const command = typeof ide.command === "string" ? ide.command.trim() : "";
    if (!command) {
      throw new Error('config "ide.command" must be a non-empty string');
    }

    const args = Array.isArray(ide.args) ? ide.args.map((value) => String(value)) : [];
    return { command, args };
  }

  throw new Error('config "ide" must be a string or an object');
}

function discoverRepos(rootPaths) {
  const repos = new Map();

  for (const rootPath of rootPaths) {
    if (!fs.existsSync(rootPath)) {
      logWarning(`configured path does not exist: ${rootPath}`);
      continue;
    }

    const stat = fs.statSync(rootPath, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
      logWarning(`configured path is not a directory: ${rootPath}`);
      continue;
    }

    walkForRepos(rootPath, repos);
  }

  return Array.from(repos.values()).sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    return byPath !== 0 ? byPath : left.name.localeCompare(right.name);
  });
}

function walkForRepos(currentPath, repos) {
  let entries = [];

  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch (error) {
    logWarning(`failed to read directory: ${currentPath} (${error.message})`);
    return;
  }

  const gitEntry = entries.find((entry) => entry.name === ".git");
  if (gitEntry) {
    const repo = inspectRepo(currentPath);
    if (repo) {
      repos.set(repo.path, repo);
    }
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    walkForRepos(path.join(currentPath, entry.name), repos);
  }
}

function inspectRepo(repoPath) {
  const gitPaths = resolveRepoGitPaths(repoPath);
  if (!gitPaths) {
    return null;
  }

  const origin = readGitOrigin(gitPaths.commonDir);
  if (!isGitHubOrigin(origin)) {
    return null;
  }

  return {
    branch: readGitBranch(gitPaths.gitDir),
    displayPath: shortenDisplayPath(repoPath),
    gitCommonDir: gitPaths.commonDir,
    gitDir: gitPaths.gitDir,
    name: path.basename(repoPath),
    origin,
    path: repoPath,
    slug: extractGitHubSlug(origin),
  };
}

function isGitHubOrigin(origin) {
  return /github\.com[:/]/i.test(origin);
}

function extractGitHubSlug(origin) {
  const normalized = origin.replace(/\.git$/i, "");
  const match = normalized.match(/github\.com[:/](.+\/.+)$/i);
  return match ? match[1] : normalized;
}

function resolveRepoGitPaths(repoPath) {
  const dotGitPath = path.join(repoPath, ".git");
  const stat = fs.statSync(dotGitPath, { throwIfNoEntry: false });
  if (!stat) {
    return null;
  }

  if (stat.isDirectory()) {
    return {
      commonDir: dotGitPath,
      gitDir: dotGitPath,
    };
  }

  if (!stat.isFile()) {
    return null;
  }

  const gitFile = safeReadFile(dotGitPath);
  const match = gitFile.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match) {
    return null;
  }

  const gitDir = path.resolve(repoPath, match[1]);
  const commonDirFile = path.join(gitDir, "commondir");
  const commonDirRaw = safeReadFile(commonDirFile).trim();
  const commonDir = commonDirRaw ? path.resolve(gitDir, commonDirRaw) : gitDir;

  return {
    commonDir,
    gitDir,
  };
}

function readGitOrigin(commonDir) {
  const config = safeReadFile(path.join(commonDir, "config"));
  if (!config) {
    return "";
  }

  const remoteBlock = config.match(/\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/);
  if (!remoteBlock) {
    return "";
  }

  const urlMatch = remoteBlock[1].match(/^\s*url\s*=\s*(.+)\s*$/m);
  return urlMatch ? urlMatch[1].trim() : "";
}

function readGitBranch(gitDir) {
  const head = safeReadFile(path.join(gitDir, "HEAD")).trim();
  const refMatch = head.match(/^ref:\s+refs\/heads\/(.+)$/);
  return refMatch ? refMatch[1] : "(detached)";
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function filterRepos(repos, query) {
  if (!query) {
    return repos;
  }

  const normalized = query.trim().toLowerCase();

  return repos
    .map((repo) => {
      const haystacks = [
        repo.name,
        repo.displayPath,
        repo.path,
        repo.slug,
        repo.branch,
        getRepoTypeLabel(repo),
        getRepoInfo(repo),
        getCommonRepoName(repo),
      ].filter(Boolean);
      const score = scoreRepoMatch(haystacks, normalized);

      return { repo, score };
    })
    .filter((entry) => entry.score > Number.NEGATIVE_INFINITY)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }

      const byPath = left.repo.path.localeCompare(right.repo.path);
      return byPath !== 0 ? byPath : left.repo.name.localeCompare(right.repo.name);
    })
    .map((entry) => entry.repo);
}

function pickRepo(repos, index) {
  if (repos.length === 0) {
    return null;
  }

  if (index == null || Number.isNaN(index)) {
    return repos[0];
  }

  return repos[index - 1] || null;
}

function renderList(repos, flags) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(repos, null, 2)}\n`);
    return;
  }

  if (flags.plain) {
    process.stdout.write(`${repos.map((repo) => repo.path).join("\n")}${repos.length ? "\n" : ""}`);
    return;
  }

  if (repos.length === 0) {
    process.stdout.write("No GitHub repositories found.\n");
    return;
  }

  const nameWidth = repos.reduce((max, repo) => Math.max(max, stringDisplayWidth(repo.name)), 4);
  const typeWidth = repos.reduce((max, repo) => Math.max(max, stringDisplayWidth(getRepoTypeLabel(repo))), 4);
  const refWidth = repos.reduce((max, repo) => Math.max(max, stringDisplayWidth(getRepoRefLabel(repo))), 3);
  const branchWidth = repos.reduce((max, repo) => Math.max(max, stringDisplayWidth(repo.branch)), 6);
  const lines = repos.map((repo, index) => {
    return `${String(index + 1).padStart(3, " ")} ${padCell(repo.name, nameWidth)}    ${padCell(getRepoTypeLabel(repo), typeWidth)}    ${padCell(getRepoRefLabel(repo), refWidth)}    ${padCell(repo.branch, branchWidth)}`;
  });
  process.stdout.write(`${lines.join("\n")}\n`);
}

function renderSelection(selected, flags) {
  if (!selected) {
    if (flags.json) {
      process.stdout.write("null\n");
    }
    return;
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(selected, null, 2)}\n`);
    return;
  }

  finalizeSelection(selected, { suppressStdout: Boolean(process.env[SELECTION_FILE_ENV]) });
}

async function runInteractiveSelector(initialRepos, initialQuery = "", ideConfig = null) {
  if (initialRepos.length === 0) {
    throw new Error("no GitHub repositories found");
  }

  let allRepos = [...initialRepos];
  let query = initialQuery;
  let commandQuery = "";
  let repos = filterRepos(allRepos, query);
  let cursor = 0;
  let searchMode = Boolean(initialQuery);
  let commandMode = false;
  let confirmDelete = null;
  let pendingKey = "";
  let visualAnchor = null;
  let statusMessage = "";
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const updateFilteredRepos = () => {
    repos = filterRepos(allRepos, query);
    cursor = Math.min(cursor, Math.max(0, repos.length - 1));
  };

  const redraw = () => {
    const rows = process.stdout.rows || 20;
    const visibleCount = Math.max(5, rows - 7);
    const start = Math.max(0, Math.min(cursor - Math.floor(visibleCount / 2), Math.max(0, repos.length - visibleCount)));
    const visible = repos.slice(start, start + visibleCount);
    const header = [
      `${ANSI.bold}Select a repository${ANSI.reset}`,
      `${ANSI.fgMuted}Vim keys:${ANSI.reset} ${ANSI.bold}j${ANSI.reset}/${ANSI.bold}k${ANSI.reset} ${ANSI.fgMuted}move,${ANSI.reset} ${ANSI.bold}gg${ANSI.reset}/${ANSI.bold}G${ANSI.reset} ${ANSI.fgMuted}top/bottom,${ANSI.reset} ${ANSI.bold}o${ANSI.reset} ${ANSI.fgMuted}open IDE,${ANSI.reset} ${ANSI.bold}:V${ANSI.reset} ${ANSI.fgMuted}visual range,${ANSI.reset} ${ANSI.bold}:d${ANSI.reset} ${ANSI.fgMuted}remove,${ANSI.reset} ${ANSI.bold}:q${ANSI.reset} ${ANSI.fgMuted}quit,${ANSI.reset} ${ANSI.bold}Esc${ANSI.reset} ${ANSI.fgMuted}cancel only.${ANSI.reset}`,
      renderControlLine(query, searchMode, repos.length, commandQuery, commandMode, process.stdout.columns || 120),
      renderStatusLine(repos, cursor, visualAnchor, confirmDelete, statusMessage, process.stdout.columns || 120),
      "",
    ];
    const body = repos.length === 0
      ? [`${ANSI.fgMuted}  No matching repositories.${ANSI.reset}`]
      : renderInteractiveRows(allRepos, visible, start, cursor, visualAnchor, process.stdout.columns || 120);

    process.stdout.write("\x1Bc");
    process.stdout.write(`${header.concat(body).join("\n")}\n`);
  };

  updateFilteredRepos();
  redraw();

  return await new Promise((resolve) => {
    const onKeypress = (input, key) => {
      const normalizedInput = normalizeCommandInput(input);

      if (confirmDelete) {
        if (key.name === "escape") {
          confirmDelete = null;
          statusMessage = "";
          redraw();
          return;
        }

        if (key.name === "backspace" || key.name === "return") {
          const targets = confirmDelete.targets;
          confirmDelete = null;
          statusMessage = "";

          if (targets.length === 0) {
            redraw();
            return;
          }

          try {
            scheduleRepoRemoval(targets);
            const removedPaths = new Set(targets.map((repo) => repo.path));
            allRepos = allRepos.filter((repo) => !removedPaths.has(repo.path));
            updateFilteredRepos();
            visualAnchor = null;
            statusMessage = `Removing ${targets.length} item${targets.length === 1 ? "" : "s"} in background`;
          } catch (error) {
            statusMessage = error.message;
          }

          redraw();
        }
        return;
      }

      if (commandMode) {
        if (key.name === "escape") {
          commandMode = false;
          commandQuery = "";
          redraw();
          return;
        }

        if (key.name === "backspace") {
          commandQuery = commandQuery.slice(0, -1);
          redraw();
          return;
        }

        if (key.name === "return") {
          const action = applyCommand();
          if (action === "quit") {
            cleanup();
            resolve(null);
            return;
          }
          if (action === "delete" || action === "visual") {
            commandMode = false;
            commandQuery = "";
            redraw();
            return;
          }

          commandMode = false;
          commandQuery = "";
          redraw();
          return;
        }

        if (normalizedInput && !key.ctrl && !key.meta && /^[0-9,doqv]$/i.test(normalizedInput)) {
          commandQuery += normalizedInput.toLowerCase();
          if (commandQuery === "v") {
            const action = applyCommand();
            if (action === "visual") {
              commandMode = false;
              commandQuery = "";
            }
          }
          redraw();
        }
        return;
      }

      if (input === ":") {
        commandMode = true;
        searchMode = false;
        commandQuery = "";
        statusMessage = "";
        pendingKey = "";
        redraw();
        return;
      }

      if (searchMode) {
        if (key.name === "up") {
          if (repos.length === 0) {
            return;
          }
          cursor = cursor === 0 ? repos.length - 1 : cursor - 1;
          redraw();
          return;
        }

        if (key.name === "down") {
          if (repos.length === 0) {
            return;
          }
          cursor = cursor === repos.length - 1 ? 0 : cursor + 1;
          redraw();
          return;
        }

        if (key.name === "escape") {
          searchMode = false;
          pendingKey = "";
          redraw();
          return;
        }

        if (key.name === "return") {
          searchMode = false;
          pendingKey = "";
          redraw();
          return;
        }

        if (key.name === "backspace") {
          query = query.slice(0, -1);
          updateFilteredRepos();
          redraw();
          return;
        }

        if (key.ctrl && key.name === "u") {
          query = "";
          updateFilteredRepos();
          redraw();
          return;
        }

        if (input && !key.ctrl && !key.meta && input >= " ") {
          query += input;
          updateFilteredRepos();
          redraw();
        }
        return;
      }

      if (input === "/") {
        searchMode = true;
        statusMessage = "";
        pendingKey = "";
        redraw();
        return;
      }

      if (visualAnchor != null && normalizedInput === "d") {
        const targets = getSelectedRepos(repos, cursor, visualAnchor);
        if (targets.length > 0) {
          confirmDelete = { targets };
          statusMessage = "";
          redraw();
        }
        return;
      }

      if (normalizedInput === "j" || key.name === "down") {
        if (repos.length === 0) {
          return;
        }
        cursor = cursor === repos.length - 1 ? 0 : cursor + 1;
        pendingKey = "";
        redraw();
        return;
      }

      if (normalizedInput === "k" || key.name === "up") {
        if (repos.length === 0) {
          return;
        }
        cursor = cursor === 0 ? repos.length - 1 : cursor - 1;
        pendingKey = "";
        redraw();
        return;
      }

      if (normalizedInput === "g") {
        if (pendingKey === "g") {
          cursor = 0;
          pendingKey = "";
          redraw();
          return;
        }

        pendingKey = "g";
        return;
      }

      if (normalizedInput === "o") {
        const target = repos[cursor];
        if (!target) {
          return;
        }

        try {
          openRepoInIde(target, ideConfig);
          statusMessage = ideConfig
            ? `Opened ${target.name} in ${ideConfig.command}`
            : "IDE is not configured";
        } catch (error) {
          statusMessage = error.message;
        }
        pendingKey = "";
        redraw();
        return;
      }

      if (input === "G") {
        if (repos.length > 0) {
          cursor = repos.length - 1;
        }
        pendingKey = "";
        redraw();
        return;
      }

      if (key.name === "escape") {
        if (visualAnchor != null) {
          visualAnchor = null;
          redraw();
          return;
        }
        pendingKey = "";
        statusMessage = "";
        redraw();
        return;
      }

      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve(null);
        return;
      }

      if (visualAnchor != null) {
        return;
      }

      if (input && !key.ctrl && !key.meta && input >= " ") {
        searchMode = true;
        query += input;
        updateFilteredRepos();
        statusMessage = "";
        pendingKey = "";
        redraw();
        return;
      }

      if (key.name === "return") {
        cleanup();
        resolve(repos[cursor]);
        return;
      }

      pendingKey = "";
    };

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdout.write("\x1Bc");
    };

    const applyCommand = () => {
      if (!commandQuery) {
        return "none";
      }

      if (commandQuery === "q") {
        return "quit";
      }

      if (commandQuery === "v") {
        if (repos.length === 0) {
          return "none";
        }
        visualAnchor = cursor;
        statusMessage = "";
        return "visual";
      }

      const parsedCommand = parseCommand(commandQuery, repos, cursor, visualAnchor);
      if (!parsedCommand) {
        return "none";
      }

      if (parsedCommand.type === "open") {
        try {
          openRepoInIde(parsedCommand.target, ideConfig);
          statusMessage = ideConfig
            ? `Opened ${parsedCommand.target.name} in ${ideConfig.command}`
            : "IDE is not configured";
        } catch (error) {
          statusMessage = error.message;
        }
        return "open";
      }

      if (parsedCommand.type === "delete") {
        confirmDelete = {
          targets: parsedCommand.targets,
        };
        searchMode = false;
        statusMessage = "";
        return "delete";
      }

      if (parsedCommand.type === "jump") {
        cursor = parsedCommand.index;
        return "jump";
      }

      return "none";
    };

    process.stdin.on("keypress", onKeypress);
  });
}

function renderControlLine(query, searchMode, resultCount, commandQuery, commandMode, terminalWidth) {
  const lineWidth = Math.max(72, terminalWidth - 4);
  const label = `${ANSI.bgChip}${ANSI.fgChip}${ANSI.bold} SEARCH ${ANSI.reset}`;
  const meta = `${ANSI.fgMuted}${resultCount} result${resultCount === 1 ? "" : "s"}${ANSI.reset}`;
  const jumpLabel = `${ANSI.bgJump}${ANSI.fgChip}${ANSI.bold} CMD ${ANSI.reset}`;
  const metaText = `${resultCount} result${resultCount === 1 ? "" : "s"}`;
  const searchFieldWidth = Math.max(16, Math.floor(lineWidth * 0.42));
  const jumpFieldWidth = Math.max(14, lineWidth - searchFieldWidth - stripAnsi(metaText).length - 36);
  const rawValue = query || "type to fuzzy-search";
  const searchValue = padCell(rawValue, searchFieldWidth);
  const searchFieldStyle = searchMode ? `${ANSI.bgInputActive}${ANSI.fgInput}` : `${ANSI.bgInput}${ANSI.fgMuted}`;
  const searchField = `${searchFieldStyle} ${searchValue} ${ANSI.reset}`;

  const jumpHint = commandQuery || "12 | d | 2,5d | V | q";
  const jumpValue = padCell(jumpHint, jumpFieldWidth);
  const jumpFieldStyle = commandMode ? `${ANSI.bgInputActive}${ANSI.fgInput}` : `${ANSI.bgInput}${ANSI.fgMuted}`;
  const jumpField = `${jumpFieldStyle} ${jumpValue} ${ANSI.reset}`;

  return `  ${label} ${searchField}  ${jumpLabel} ${jumpField}  ${meta}`;
}

function renderStatusLine(repos, cursor, visualAnchor, confirmDelete, statusMessage, terminalWidth) {
  const lineWidth = Math.max(72, terminalWidth - 4);

  if (confirmDelete && confirmDelete.targets.length > 0) {
    const label = formatDeleteTargetLabel(confirmDelete.targets);
    const text = truncateText(`Remove ${label}? Backspace or Enter to confirm, Esc to cancel.`, lineWidth);
    return `  ${ANSI.bgDanger}${ANSI.fgDanger}${ANSI.bold} ${text.padEnd(lineWidth, " ")} ${ANSI.reset}`;
  }

  if (visualAnchor != null) {
    const selectedCount = getSelectedRepos(repos, cursor, visualAnchor).length;
    const text = truncateText(`VISUAL LINE ${selectedCount} selected. Move with j/k or arrows, d to delete, Esc to cancel.`, lineWidth);
    return `  ${ANSI.bgSelection}${ANSI.fgSelection}${ANSI.bold} ${text.padEnd(lineWidth, " ")} ${ANSI.reset}`;
  }

  if (statusMessage) {
    const text = truncateText(statusMessage, lineWidth);
    return `  ${ANSI.fgMuted}${text}${ANSI.reset}`;
  }

  return "";
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function getSelectedRepos(repos, cursor, visualAnchor) {
  if (visualAnchor == null || repos.length === 0) {
    return [];
  }

  const from = Math.min(cursor, visualAnchor);
  const to = Math.max(cursor, visualAnchor);
  return repos.slice(from, to + 1);
}

function isSelectedIndex(index, cursor, visualAnchor) {
  if (visualAnchor == null) {
    return false;
  }

  const from = Math.min(cursor, visualAnchor);
  const to = Math.max(cursor, visualAnchor);
  return index >= from && index <= to;
}

function formatDeleteTargetLabel(targets) {
  if (targets.length === 1) {
    const target = targets[0];
    const typeLabel = isWorktreeRepo(target) ? "worktree" : "repository";
    return `${typeLabel} ${target.displayPath}`;
  }

  return `${targets.length} items`;
}

function parseCommand(commandQuery, repos, cursor, visualAnchor) {
  if (commandQuery === "o") {
    const target = repos[cursor];
    return target ? { type: "open", target } : null;
  }

  if (commandQuery === "d") {
    const targets = visualAnchor != null
      ? getSelectedRepos(repos, cursor, visualAnchor)
      : (repos[cursor] ? [repos[cursor]] : []);
    return targets.length > 0 ? { type: "delete", targets } : null;
  }

  const jumpMatch = commandQuery.match(/^(\d+)$/);
  if (jumpMatch) {
    const index = Number.parseInt(jumpMatch[1], 10) - 1;
    if (index < 0 || index >= repos.length) {
      return null;
    }

    return { type: "jump", index };
  }

  const singleDeleteMatch = commandQuery.match(/^(\d+)d$/);
  if (singleDeleteMatch) {
    const index = Number.parseInt(singleDeleteMatch[1], 10) - 1;
    if (index < 0 || index >= repos.length) {
      return null;
    }

    return { type: "delete", targets: [repos[index]] };
  }

  const rangeDeleteMatch = commandQuery.match(/^(\d+),(\d+)d$/);
  if (rangeDeleteMatch) {
    const start = Number.parseInt(rangeDeleteMatch[1], 10) - 1;
    const end = Number.parseInt(rangeDeleteMatch[2], 10) - 1;
    if (start < 0 || end < 0 || start >= repos.length || end >= repos.length) {
      return null;
    }

    const from = Math.min(start, end);
    const to = Math.max(start, end);
    return { type: "delete", targets: repos.slice(from, to + 1) };
  }

  return null;
}

function renderInteractiveRows(allRepos, repos, start, cursor, visualAnchor, terminalWidth) {
  const contentWidth = Math.max(40, terminalWidth);
  const indexWidth = 4;
  const minNameWidth = 12;
  const minRefWidth = 3;
  const minBranchWidth = 10;
  const leftPadding = 2;
  const gapAfterIndex = 1;
  const primaryGap = 4;
  const secondaryGap = 4;
  const tertiaryGap = 4;
  const fullNameWidth = allRepos.reduce((max, repo) => Math.max(max, stringDisplayWidth(repo.name)), 4);
  const fullRefWidth = allRepos.reduce((max, repo) => Math.max(max, stringDisplayWidth(getRepoRefLabel(repo))), 3);
  const fullBranchWidth = allRepos.reduce((max, repo) => Math.max(max, stringDisplayWidth(repo.branch)), 6);
  const typeWidth = Math.max(8, allRepos.reduce((max, repo) => Math.max(max, stringDisplayWidth(getRepoTypeLabel(repo))), 4));
  const refWidth = Math.max(minRefWidth, fullRefWidth);
  const reservedWidth = leftPadding + indexWidth + gapAfterIndex + primaryGap + secondaryGap + tertiaryGap + typeWidth + refWidth;
  const availableWidth = Math.max(minNameWidth + minBranchWidth, contentWidth - reservedWidth);
  const preferredNameWidth = Math.min(fullNameWidth, Math.max(minNameWidth, availableWidth - minBranchWidth));
  const branchWidth = Math.max(minBranchWidth, availableWidth - preferredNameWidth);
  const nameWidth = Math.max(minNameWidth, availableWidth - branchWidth);
  const headerRow = `${ANSI.dim}  ${padCell("#", indexWidth, "left")} ${padCell("NAME", nameWidth)}${" ".repeat(primaryGap)}${padCell("TYPE", typeWidth)}${" ".repeat(secondaryGap)}${padCell("REF", refWidth)}${" ".repeat(tertiaryGap)}${padCell("BRANCH", branchWidth)}${ANSI.reset}`;
  const bodyRows = repos.map((repo, index) => {
    const actualIndex = start + index;
    const focused = actualIndex === cursor;
    const selected = isSelectedIndex(actualIndex, cursor, visualAnchor);
    const stylePrefix = focused
      ? `${ANSI.bgFocus}${ANSI.fgFocus}`
      : selected
        ? `${ANSI.bgSelection}${ANSI.fgSelection}`
        : "";
    const styleSuffix = stylePrefix ? ANSI.reset : "";
    const indexCell = padCell(String(actualIndex + 1), indexWidth, "left");
    const nameCell = padCell(repo.name, nameWidth);
    const typeCell = padCell(getRepoTypeLabel(repo), typeWidth);
    const refCell = padCell(getRepoRefLabel(repo), refWidth);
    const branchCell = padCell(repo.branch, branchWidth);
    const row = `  ${indexCell} ${nameCell}${" ".repeat(primaryGap)}${typeCell}${" ".repeat(secondaryGap)}${refCell}${" ".repeat(tertiaryGap)}${branchCell}`;

    return `${stylePrefix}${row}${styleSuffix}`;
  });

  return [headerRow, ...bodyRows];
}

function getRepoTypeLabel(repo) {
  return isWorktreeRepo(repo) ? "worktree" : "repo";
}

function getRepoInfo(repo) {
  if (isWorktreeRepo(repo)) {
    return `${repo.branch} <- ${getCommonRepoName(repo)}`;
  }

  return repo.slug;
}

function getRepoRefLabel(repo) {
  return isWorktreeRepo(repo) ? getCommonRepoName(repo) : "";
}

function openRepoInIde(repo, ideConfig) {
  if (!ideConfig?.command) {
    throw new Error("configure ide in repo-paths.json first");
  }

  const hasPathPlaceholder = ideConfig.args.some((arg) => arg.includes("{path}"));
  const args = ideConfig.args.map((arg) => arg.replaceAll("{path}", repo.path));
  if (!hasPathPlaceholder) {
    args.push(repo.path);
  }

  const check = spawnSync(ideConfig.command, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  if (check.error) {
    throw new Error(`failed to start IDE command: ${ideConfig.command}`);
  }

  const child = spawn(ideConfig.command, args, {
    detached: true,
    stdio: "ignore",
  });

  child.unref();
}

function scoreRepoMatch(haystacks, query) {
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const haystack of haystacks) {
    const score = fuzzyScore(String(haystack).toLowerCase(), query);
    if (score > bestScore) {
      bestScore = score;
    }
  }

  return bestScore;
}

function fuzzyScore(haystack, needle) {
  if (!needle) {
    return 0;
  }

  const exactIndex = haystack.indexOf(needle);
  if (exactIndex >= 0) {
    const prefixBonus = exactIndex === 0 ? 120 : Math.max(0, 40 - exactIndex);
    return 500 + prefixBonus - Math.max(0, haystack.length - needle.length);
  }

  let score = 0;
  let lastIndex = -1;
  let consecutive = 0;

  for (const char of needle) {
    const nextIndex = haystack.indexOf(char, lastIndex + 1);
    if (nextIndex === -1) {
      return Number.NEGATIVE_INFINITY;
    }

    if (nextIndex === lastIndex + 1) {
      consecutive += 1;
      score += 20 + consecutive * 6;
    } else {
      consecutive = 0;
      score += 8 - Math.min(7, nextIndex - lastIndex - 1);
    }

    if (nextIndex === 0 || isWordBoundary(haystack, nextIndex - 1)) {
      score += 14;
    }

    lastIndex = nextIndex;
  }

  return score - Math.max(0, haystack.length - needle.length);
}

function isWordBoundary(value, index) {
  if (index < 0) {
    return true;
  }

  return /[\/._\-\s]/.test(value[index]);
}

function isWorktreeRepo(repo) {
  return Boolean(repo.gitDir && repo.gitCommonDir && repo.gitDir !== repo.gitCommonDir);
}

function getCommonRepoName(repo) {
  return path.basename(path.dirname(repo.gitCommonDir || repo.path));
}

function normalizeCommandInput(input) {
  if (!input) {
    return input;
  }

  return HANGUL_COMMAND_KEY_ALIASES[input] || input;
}

function padCell(value, width, align = "right") {
  const truncated = truncateText(value, width);
  const displayWidth = stringDisplayWidth(truncated);
  if (displayWidth >= width) {
    return truncated;
  }

  const padding = " ".repeat(width - displayWidth);
  return align === "left"
    ? `${padding}${truncated}`
    : `${truncated}${padding}`;
}

function truncateText(value, width) {
  if (width <= 1) {
    return "…";
  }

  if (stringDisplayWidth(value) <= width) {
    return value;
  }

  let result = "";
  let currentWidth = 0;

  for (const char of value) {
    const nextWidth = charDisplayWidth(char);
    if (currentWidth + nextWidth > width - 1) {
      break;
    }

    result += char;
    currentWidth += nextWidth;
  }

  return `${result}…`;
}

function stringDisplayWidth(value) {
  let width = 0;

  for (const char of value) {
    width += charDisplayWidth(char);
  }

  return width;
}

function charDisplayWidth(char) {
  const codePoint = char.codePointAt(0);
  if (codePoint == null) {
    return 0;
  }

  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) {
    return 2;
  }

  return 1;
}

function shortenDisplayPath(repoPath) {
  for (const prefix of DISPLAY_PATH_PREFIXES) {
    if (repoPath.startsWith(prefix)) {
      return repoPath.slice(prefix.length);
    }
  }

  return repoPath.replace(`${os.homedir()}${path.sep}`, "~/");
}

function removeRepoFromDisk(repo) {
  if (repo.path === ROOT_DIR) {
    throw new Error("cannot remove dailylife-utils while it is running");
  }

  if (isWorktreeRepo(repo)) {
    removeWorktree(repo);
    return;
  }

  fs.rmSync(repo.path, { recursive: true, force: false });
}

function removeReposFromDisk(repos) {
  const ordered = [...repos].sort((left, right) => {
    const worktreeBias = Number(isWorktreeRepo(right)) - Number(isWorktreeRepo(left));
    if (worktreeBias !== 0) {
      return worktreeBias;
    }

    return right.path.length - left.path.length;
  });

  for (const repo of ordered) {
    removeRepoFromDisk(repo);
  }
}

function scheduleRepoRemoval(repos) {
  const payloadPath = path.join(
    os.tmpdir(),
    `repo-delete-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  const payload = {
    repos: repos.map((repo) => ({
      branch: repo.branch,
      displayPath: repo.displayPath,
      gitCommonDir: repo.gitCommonDir,
      gitDir: repo.gitDir,
      path: repo.path,
    })),
  };

  fs.writeFileSync(payloadPath, JSON.stringify(payload), "utf8");

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), DELETE_WORKER_COMMAND, "--input", payloadPath], {
    detached: true,
    stdio: "ignore",
  });

  child.unref();
}

function runDeleteWorker(inputPath) {
  if (!inputPath) {
    throw new Error("delete-worker requires --input <path>");
  }

  try {
    const raw = fs.readFileSync(inputPath, "utf8");
    const payload = JSON.parse(raw);
    const repos = Array.isArray(payload?.repos) ? payload.repos : [];
    removeReposFromDisk(repos);
  } finally {
    fs.rmSync(inputPath, { force: true });
  }
}

function removeWorktree(repo) {
  const baseRepoPath = path.dirname(repo.gitCommonDir);

  try {
    execFileSync("git", ["-C", baseRepoPath, "worktree", "remove", "--force", repo.path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error.stderr?.toString().trim();
    throw new Error(stderr || `failed to remove worktree: ${repo.displayPath}`);
  }
}

function buildShellInit(shell) {
  if (!["zsh", "bash"].includes(shell)) {
    throw new Error(`unsupported shell: ${shell}`);
  }

  const entry = path.join(ROOT_DIR, "apps", "repo", "src", "index.js");
  return `unalias repo 2>/dev/null
repo() {
  if [ "$1" = "list" ] || [ "$1" = "help" ] || [ "$1" = "shell-init" ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    node "${entry}" "$@"
    return $?
  fi

  for arg in "$@"; do
    if [ "$arg" = "--json" ] || [ "$arg" = "--plain" ]; then
      node "${entry}" "$@"
      return $?
    fi
  done

  local tmp_file
  local target
  local exit_code
  tmp_file="$(mktemp -t repo-select.XXXXXX)" || return 1
  REPO_SELECTED_PATH_FILE="$tmp_file" node "${entry}" "$@"
  exit_code=$?

  if [ $exit_code -ne 0 ]; then
    rm -f "$tmp_file"
    return $exit_code
  fi

  target="$(cat "$tmp_file")"
  rm -f "$tmp_file"

  if [ -n "$target" ] && [ -d "$target" ]; then
    cd "$target"
  elif [ -n "$target" ]; then
    printf '%s\\n' "$target"
  fi
}
`;
}

function finalizeSelection(selected, options = {}) {
  const selectionFile = process.env[SELECTION_FILE_ENV];
  if (selectionFile) {
    fs.writeFileSync(selectionFile, `${selected.path}\n`, "utf8");
  }

  if (!options.suppressStdout) {
    process.stdout.write(`${selected.path}\n`);
  }
}

function resolvePath(inputPath) {
  if (inputPath.startsWith("~")) {
    return path.join(os.homedir(), inputPath.slice(1));
  }

  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  return path.resolve(ROOT_DIR, inputPath);
}

function logWarning(message) {
  process.stderr.write(`[${APP_NAME}] warning: ${message}\n`);
}

function logError(message) {
  process.stderr.write(`[${APP_NAME}] error: ${message}\n`);
}

try {
  main();
} catch (error) {
  logError(error.message);
  process.exit(1);
}
