import { exec as execRegular } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

let exec = promisify(execRegular);

type Command = "init" | "update"; // | "add" | "remove";

interface CommandOptions {
  path: string;
  dry: boolean;
  verbose: boolean;
}

class Logger {
  private logs: string[] = [];
  private verbose: boolean;

  constructor(verbose: boolean) {
    this.verbose = verbose;
  }

  log(message: string): void {
    if (this.verbose) {
      console.log(message);
    } else {
      this.logs.push(message);
    }
  }

  async writeLogs(): Promise<void> {
    if (!this.verbose && this.logs.length > 0) {
      let tempFile = path.join(os.tmpdir(), `whare-logs-${Date.now()}.txt`);
      await writeFile(tempFile, this.logs.join("\n"), "utf8");
      console.log(`Logs written to: ${tempFile}`);
    }
  }
}

function parseArgs(): { command: Command; options: CommandOptions } | null {
  let args = process.argv.slice(2);

  // Default return value
  let result = {
    command: null as Command | null,
    options: {
      path: ".", // Default to current directory
      dry: false,
      verbose: false,
    },
  };

  // No arguments provided
  if (args.length === 0) {
    return null;
  }

  // First argument should be the command
  let possibleCommand = args[0];
  if (["init", "add", "remove", "update"].includes(possibleCommand)) {
    result.command = possibleCommand as Command;
  }

  // Parse remaining arguments
  for (let i = 1; i < args.length; i++) {
    let arg = args[i];
    if (arg === "--dry") {
      result.options.dry = true;
    } else if (arg === "--verbose") {
      result.options.verbose = true;
    } else if (!arg.startsWith("--")) {
      // Assume it's a path if it's not a flag
      result.options.path = arg;
    }
  }

  return result as { command: Command; options: CommandOptions };
}

async function getCurrentTemplateHash(logger: Logger): Promise<string> {
  try {
    let { stdout } = await exec(
      `git ls-remote https://github.com/hamlim/template-monorepo.git`,
    );

    return stdout.split("\t")[0];
  } catch (error) {
    logger.log(`Error: Failed to get current template hash: ${error}`);
    process.exit(1);
  }
}

async function cloneTemplate(clonePath: string, logger: Logger): Promise<void> {
  try {
    await exec(
      `cd ${clonePath} && git clone https://github.com/hamlim/template-monorepo.git .`,
    );
  } catch (error) {
    logger.log(`Error: Failed to clone template: ${error}`);
  }
}

type DiffEntryWithContent = {
  type: "add" | "modify";
  path: string;
  content: string;
};

type DiffEntry =
  | DiffEntryWithContent
  | {
      type: "delete";
      path: string;
    };

async function getRepoDiffs(
  fromHash: string,
  toHash: string,
  logger: Logger,
): Promise<DiffEntry[]> {
  try {
    // Create a temp directory to clone the repo
    let tempDir = path.join(os.tmpdir(), `whare-template-${Date.now()}`);

    await mkdir(tempDir, { recursive: true });

    // Clone the repo
    await cloneTemplate(tempDir, logger);

    // Get the diff between versions
    let { stdout } = await exec(
      `cd ${tempDir} && git diff ${fromHash}..${toHash} --name-status`,
    );

    let diffs: DiffEntry[] = [];
    let lines = stdout.split("\n").filter(Boolean);

    for (let line of lines) {
      let [status, filePath] = line.split("\t");
      let entry: Partial<DiffEntry> = {
        type: status === "A" ? "add" : status === "D" ? "delete" : "modify",
        path: filePath,
      };

      // Get file content for added or modified files
      if (entry.type !== "delete") {
        let { stdout: content } = await exec(
          `cd ${tempDir} && git show ${toHash}:${filePath}`,
        );
        (entry as DiffEntryWithContent).content = content;
      }

      diffs.push(entry as DiffEntry);
    }

    return diffs;
  } catch (error) {
    logger.log(`Error: Failed to get repo diffs: ${error}`);
    process.exit(1);
  }
}

async function findWorkspaces(projectPath: string): Promise<string[]> {
  let workspaces: string[] = [];
  let entries = await readdir(path.join(projectPath, "packages"), {
    withFileTypes: true,
  });

  for (let entry of entries) {
    if (entry.isDirectory()) {
      workspaces.push(path.join("packages", entry.name));
    }
  }

  let appsEntries = await readdir(path.join(projectPath, "apps"), {
    withFileTypes: true,
  });
  for (let entry of appsEntries) {
    if (entry.isDirectory()) {
      workspaces.push(path.join("apps", entry.name));
    }
  }

  return workspaces;
}

async function applyDiff(projectPath: string, diff: DiffEntry): Promise<void> {
  let targetPath = path.join(projectPath, diff.path);

  switch (diff.type) {
    case "add":
    case "modify":
      // Ensure directory exists
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, diff.content, "utf8");
      break;
    case "delete":
      try {
        await unlink(targetPath);
      } catch (error) {
        // Ignore if file doesn't exist
      }
      break;
  }
}

// Add these new constants and types
let DEFAULT_IGNORED_FILES = new Set(["bun.lockb"]);

interface UpdateOptions {
  ignoredFiles?: Set<string>;
  branchName?: string;
}

// Update the updateProject function
async function updateProject(
  projectPath: string,
  fromVersion: string,
  logger: Logger,
  isDry: boolean,
  options: UpdateOptions = {},
): Promise<void> {
  let currentHash = await getCurrentTemplateHash(logger);
  let ignoredFiles = new Set([
    ...DEFAULT_IGNORED_FILES,
    ...(options.ignoredFiles || []),
  ]);
  let branchName = options.branchName || `whare-update-${Date.now()}`;

  let pkgJsonPath = path.join(projectPath, "package.json");

  // Get diffs from template
  let diffs = await getRepoDiffs(fromVersion, currentHash, logger);

  // bail if there are no diffs
  if (diffs.length === 0) {
    logger.log("No changes found in template");
    return;
  }

  // Filter out ignored files
  let filteredDiffs = diffs.filter(
    (diff) => !ignoredFiles.has(path.basename(diff.path)),
  );

  // Find all workspaces
  let workspaces = await findWorkspaces(projectPath);

  if (isDry) {
    logger.log(
      `Would update project from version ${fromVersion} to ${currentHash}`,
    );
    logger.log(`Found ${filteredDiffs.length} changes in template`);
    logger.log(`Found ${workspaces.length} workspaces to potentially update`);
    logger.log(`Ignored files: ${[...ignoredFiles].join(", ")}`);
    return;
  }

  // Create and checkout new branch for changes
  try {
    await exec(`cd ${projectPath} && git checkout -b ${branchName}`);
    logger.log(`Created new branch: ${branchName}`);
  } catch (error) {
    console.error("Failed to create git branch. Is this a git repository?");
    process.exit(1);
  }

  try {
    // Apply root-level changes
    for (let diff of filteredDiffs) {
      if (
        diff.path.startsWith("packages/template-") ||
        diff.path.startsWith("apps/template-")
      ) {
        continue;
      }

      await applyDiff(projectPath, diff);
    }

    // Handle template workspace changes
    let templateLibraryDiffs = filteredDiffs.filter((d) =>
      d.path.startsWith("packages/template-library"),
    );
    let templateAppDiffs = filteredDiffs.filter((d) =>
      d.path.startsWith("apps/template-app"),
    );

    // Apply template changes to each matching workspace
    for (let workspace of workspaces) {
      let templateDiffs = workspace.startsWith("packages/")
        ? templateLibraryDiffs
        : templateAppDiffs;

      for (let diff of templateDiffs) {
        let relativePath = diff.path.replace(
          workspace.startsWith("packages/")
            ? "packages/template-library"
            : "apps/template-app",
          workspace,
        );

        await applyDiff(projectPath, {
          ...diff,
          path: relativePath,
        });
      }
    }

    // Update version in package.json
    let pkgJsonContents = await readFile(pkgJsonPath, "utf8");
    let pkgJson = JSON.parse(pkgJsonContents);
    pkgJson.whare = {
      ...(pkgJson.whare || {}),
      version: currentHash,
    };
    await writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2));

    // Stage all changes
    await exec(`cd ${projectPath} && git add .`);

    // Show status and instructions
    logger.log("\nUpdate completed! Review the changes:");
    logger.log(`1. Check 'git status' to see modified files`);
    logger.log(`2. Review changes with 'git diff --cached'`);
    logger.log(
      `3. Commit changes with 'git commit -m "feat: update template"'`,
    );
    logger.log(
      `4. Merge to main branch: 'git checkout main && git merge ${branchName}'`,
    );
    logger.log("\nOr to discard changes:");
    logger.log(`1. git checkout main`);
    logger.log(`2. git branch -D ${branchName}`);
  } catch (error) {
    // If anything fails, try to cleanup
    try {
      await exec(
        `cd ${projectPath} && git checkout main && git branch -D ${branchName}`,
      );
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

export async function run(): Promise<void> {
  let parsedArgs = parseArgs();

  if (!parsedArgs) {
    console.error("No arguments provided");
    process.exit(1);
  }

  let { command, options } = parsedArgs;
  let logger = new Logger(options.verbose);

  try {
    switch (command) {
      case "init": {
        let hash = await getCurrentTemplateHash(logger);
        if (options.dry) {
          // dry mode always logs to the console
          console.log(
            `[Dry Run] Would initialize new project at: ${options.path}`,
          );
          console.log(
            `[Dry Run] Would clone template from: hamlim/template-monorepo`,
          );
          console.log(
            `[Dry Run] Would update package.json with template version hash: ${hash}`,
          );
          break;
        }

        if (!existsSync(options.path)) {
          await mkdir(options.path, { recursive: true });
        }

        await cloneTemplate(options.path, logger);

        await exec(`cd ${options.path} && rm -rf .git`);

        logger.log("Successfully initialized project!");

        let rootPackageJson = await readFile(
          path.join(options.path, "package.json"),
          "utf8",
        );

        let rootPackageJsonObject = JSON.parse(rootPackageJson);

        rootPackageJsonObject.whare = {
          version: hash,
        };

        await writeFile(
          path.join(options.path, "package.json"),
          JSON.stringify(rootPackageJsonObject, null, 2),
        );

        await exec(
          `cd ${options.path} && git init && git add . && git commit -m "Init"`,
        );

        break;
      }
      case "update": {
        // Read current version from package.json
        let pkgJsonPath = path.join(options.path, "package.json");
        let pkgJson: any;
        try {
          pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
        } catch (error) {
          console.error(
            "Failed to read package.json. Check the path that you provided!",
          );
          process.exit(1);
        }

        if (!pkgJson.whare?.version) {
          console.error(
            "No whare version found in package.json. Is this a whare project?",
          );
          process.exit(1);
        }

        // Check if directory is a git repository
        try {
          await exec(
            `cd ${options.path} && git rev-parse --is-inside-work-tree`,
          );
        } catch (error) {
          console.error(
            "Directory must be a git repository to perform updates",
          );
          process.exit(1);
        }

        // Check for uncommitted changes
        try {
          let { stdout } = await exec(
            `cd ${options.path} && git status --porcelain`,
          );
          if (stdout.trim()) {
            console.error("Working directory must be clean to perform updates");
            console.error("Please commit or stash your changes first");
            process.exit(1);
          }
        } catch (error) {
          console.error("Failed to check git status");
          process.exit(1);
        }

        await updateProject(
          options.path,
          pkgJson.whare.version,
          logger,
          options.dry,
          {
            branchName: `whare-update-${Date.now()}`,
          },
        );

        if (!options.dry) {
          logger.log("Successfully staged update changes!");
        }
        break;
      }
      default: {
        console.error(
          "Invalid command. Available commands: init, add, remove, update",
        );
        process.exit(1);
      }
    }
  } finally {
    // Write logs to file if not in verbose mode
    await logger.writeLogs();
  }
}
