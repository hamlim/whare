import { exec as execRegular } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

let exec = promisify(execRegular);

type Command = "init" | "update" | "help"; // | "add" | "remove";

interface CommandOptions {
  path: string;
  dry: boolean;
  verbose: boolean;
}

export class Logger {
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
  if (["init", "add", "remove", "update", "help"].includes(possibleCommand)) {
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
      `git ls-remote https://github.com/hamlim/monorepo-shell-template.git`,
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
      `cd ${clonePath} && git clone https://github.com/hamlim/monorepo-shell-template.git .`,
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
  tempDir: string,
): Promise<DiffEntry[]> {
  try {
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

// Add these new types after the existing types
interface WorkspaceInfo {
  path: string;
  packageName: string;
}

async function getWorkspaceInfo(
  workspacePath: string,
): Promise<WorkspaceInfo | null> {
  try {
    let pkgJsonPath = path.join(workspacePath, "package.json");
    if (!existsSync(pkgJsonPath)) {
      return null;
    }
    let pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
    return {
      path: workspacePath,
      packageName: pkgJson.name,
    };
  } catch (error) {
    return null;
  }
}

async function findMatchingTemplateWorkspace(
  workspace: WorkspaceInfo,
  tempDir: string,
): Promise<string | null> {
  let workspaceName = path.basename(workspace.path);
  let possiblePaths = [
    path.join(tempDir, "packages", workspaceName),
    path.join(tempDir, "apps", workspaceName),
  ];

  for (let possiblePath of possiblePaths) {
    let templateWorkspace = await getWorkspaceInfo(possiblePath);
    if (templateWorkspace?.packageName === workspace.packageName) {
      return possiblePath;
    }
  }

  return null;
}

// Update the findWorkspaces function to handle a direct path
async function findWorkspaces(projectPath: string): Promise<string[]> {
  let workspaces: string[] = [];

  try {
    let entries = await readdir(projectPath, { withFileTypes: true });
    for (let entry of entries) {
      if (entry.isDirectory()) {
        workspaces.push(path.join(projectPath, entry.name));
      }
    }
  } catch (error) {
    // Directory might not exist, return empty array
  }

  return workspaces;
}

// Add these new types and handlers before the updateProject function
interface SpecialFileHandler {
  shouldHandle: (filePath: string) => boolean;
  merge: (current: string, incoming: string, logger: Logger) => Promise<string>;
}

// Fields that should never be overwritten from the template
const PACKAGE_JSON_PROTECTED_FIELDS = new Set([
  "name",
  "version",
  "private",
  "description",
  "author",
  "license",
  "repository",
  "bugs",
  "homepage",
]);

// Fields that should be merged (rather than replaced) from the template
const PACKAGE_JSON_MERGE_FIELDS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "scripts",
]);

// Add helper to detect value differences
export function hasValueChanged(current: unknown, incoming: unknown): boolean {
  return JSON.stringify(current) !== JSON.stringify(incoming);
}

// Add these types and helpers for the new conflict marking approach
interface ConflictMarker {
  start: string;
  mid: string;
  end: string;
  template: string;
  current: string;
}

export function createConflictMarkers(
  counter: number,
  originalKey: string,
): ConflictMarker {
  const id = counter.toString().padStart(2, "0");
  return {
    start: `conf-start::${id}`,
    mid: `conf-mid::${id}`,
    end: `conf-end::${id}`,
    template: `tmpl::${originalKey}`,
    current: `curr::${originalKey}`,
  };
}

export function transformToGitConflicts(jsonString: string): string {
  // Split into lines for easier processing
  let lines = jsonString.split("\n");
  let result: string[] = [];
  let inConflict = false;

  // Helper to find the next non-conflict line
  function findNextNonConflictLine(startIndex: number): string | null {
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (
        line &&
        // as long as the next line isn't an end of conflict marker
        !line.startsWith('"conf-end') &&
        !line.startsWith('"conf-mid') &&
        // and the next line isn't a template or current marker
        !line.startsWith('"tmpl::') &&
        !line.startsWith('"curr::')
      ) {
        return line;
      }
    }
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    if (line.includes('"conf-start::')) {
      inConflict = true;
      result.push("<<<<<<< Local Package");
      continue;
    }
    if (line.includes('"conf-mid::')) {
      result.push("=======");
      continue;
    }
    if (line.includes('"conf-end::')) {
      result.push(">>>>>>> Template");
      inConflict = false;
      continue;
    }

    // Transform template and current markers into their values
    if (inConflict) {
      if (trimmedLine.startsWith('"tmpl::')) {
        // Find the next real line to determine if we need a comma
        const nextNonConflictLine = findNextNonConflictLine(i + 1);
        const needsComma = nextNonConflictLine?.startsWith('"') ?? false;

        // Keep the original quotes but replace the marker
        const processedLine = line
          .replace(/"tmpl::([^"]+)"/, '"$1"') // Replace marker but keep quotes
          .replace(/,(?!.*,)/, ""); // Remove last comma if present

        result.push(
          `${processedLine}${needsComma ? "," : ""} // From template`,
        );
        continue;
      }
      if (trimmedLine.startsWith('"curr::')) {
        // Find the next real line to determine if we need a comma
        const nextNonConflictLine = findNextNonConflictLine(i + 1);
        const needsComma = nextNonConflictLine?.startsWith('"') ?? false;

        // Keep the original quotes but replace the marker
        const processedLine = line
          .replace(/"curr::([^"]+)"/, '"$1"') // Replace marker but keep quotes
          .replace(/,(?!.*,)/, ""); // Remove last comma if present

        result.push(`${processedLine}${needsComma ? "," : ""}`);
        continue;
      }
    }

    result.push(line);
  }

  return result.join("\n");
}

export const packageJsonHandler: SpecialFileHandler = {
  shouldHandle: (filePath: string) =>
    path.basename(filePath) === "package.json",
  merge: async (current: string, incoming: string, logger: Logger) => {
    try {
      let currentJson = JSON.parse(current);
      let incomingJson = JSON.parse(incoming);
      let result = { ...currentJson };
      let conflictCounter = 0;

      // Iterate through all incoming fields
      for (let [key, incomingValue] of Object.entries(incomingJson)) {
        if (PACKAGE_JSON_PROTECTED_FIELDS.has(key)) {
          // Skip protected fields, leaving the current value
          result[key] = currentJson[key];
        } else if (
          PACKAGE_JSON_MERGE_FIELDS.has(key) &&
          typeof incomingValue === "object" &&
          incomingValue !== null
        ) {
          // For merge fields, we need to:
          // 1. Start with current values
          // 2. Add any new keys from template
          // 3. Add conflict markers for differing values
          let mergedObject: Record<string, unknown> = { ...currentJson[key] };

          // Process each key in the incoming object
          for (let [subKey, subValue] of Object.entries(incomingValue)) {
            if (!(subKey in mergedObject)) {
              // New key from template, add it
              mergedObject[subKey] = subValue;
            } else if (hasValueChanged(mergedObject[subKey], subValue)) {
              // Key exists but values differ, add conflict markers
              const markers = createConflictMarkers(conflictCounter++, subKey);
              const originalValue = mergedObject[subKey];

              // Delete the original key as we'll represent it in the conflict
              delete mergedObject[subKey];

              // Add our conflict markers and values in reverse order (current first, then template)
              mergedObject[markers.start] = "";
              mergedObject[markers.current] = originalValue;
              mergedObject[markers.mid] = "";
              mergedObject[markers.template] = subValue;
              mergedObject[markers.end] = "";
            }
            // If key exists and values are same, keep current value
          }

          result[key] = mergedObject;
        } else {
          // For all other fields, take the incoming value
          result[key] = incomingValue;
        }
      }

      // First stringify to JSON with standard formatting
      let jsonString = JSON.stringify(result, null, 2);

      // Then transform our markers into git-style conflicts
      return transformToGitConflicts(jsonString);
    } catch (error) {
      logger.log(
        `Warning: Failed to merge package.json, using current version: ${error}`,
      );
      return current;
    }
  },
};

const SPECIAL_FILE_HANDLERS: SpecialFileHandler[] = [packageJsonHandler];

// Add this function to handle special file merging
async function handleSpecialFile(
  filePath: string,
  currentContent: string | null,
  incomingContent: string,
  logger: Logger,
): Promise<string> {
  for (let handler of SPECIAL_FILE_HANDLERS) {
    if (handler.shouldHandle(filePath)) {
      if (!currentContent) {
        // If there's no current content, just use the incoming content
        return incomingContent;
      }
      return handler.merge(currentContent, incomingContent, logger);
    }
  }
  return incomingContent;
}

// Update the applyDiff function to handle special files
async function applyDiff(
  projectPath: string,
  diff: DiffEntry,
  logger: Logger,
): Promise<void> {
  let targetPath = path.join(projectPath, diff.path);

  switch (diff.type) {
    case "add":
    case "modify": {
      // Ensure directory exists
      await mkdir(path.dirname(targetPath), { recursive: true });

      let currentContent: string | null = null;
      if (existsSync(targetPath)) {
        currentContent = await readFile(targetPath, "utf8");
      }

      let finalContent = await handleSpecialFile(
        diff.path,
        currentContent,
        diff.content,
        logger,
      );

      await writeFile(targetPath, finalContent, "utf8");
      break;
    }
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
let DEFAULT_IGNORED_FILES = new Set(["bun.lockb", "bun.lock"]);

// Helper to normalize workspace paths
function normalizeWorkspacePath(basePath: string, inputPath: string): string {
  // Remove ./ prefix if present
  let normalizedPath = inputPath.replace(/^\.\//, "");
  return path.join(basePath, normalizedPath);
}

// Add this helper function before updateProject
async function getTemplateWorkspaces(tempDir: string): Promise<{
  templateLibrary: string | null;
  templateApp: string | null;
}> {
  let templateLibraryPath = path.join(tempDir, "packages/template-library");
  let templateAppPath = path.join(tempDir, "apps/template-app");

  return {
    templateLibrary: existsSync(templateLibraryPath)
      ? templateLibraryPath
      : null,
    templateApp: existsSync(templateAppPath) ? templateAppPath : null,
  };
}

// Update the updateProject function
async function updateProject(
  projectPath: string,
  fromVersion: string,
  logger: Logger,
  isDry: boolean,
): Promise<void> {
  let currentHash = await getCurrentTemplateHash(logger);
  let ignoredFiles = DEFAULT_IGNORED_FILES;

  let pkgJsonPath = path.join(projectPath, "package.json");
  let pkgJsonContents = await readFile(pkgJsonPath, "utf8");
  let pkgJson = JSON.parse(pkgJsonContents);

  let previousWhareVersion = pkgJson.whare?.version;

  // biome-ignore lint/performance/noDelete: <explanation>
  delete pkgJson.whare?.version;

  // temporarily replace whare.version with a placeholder
  // that we can use to update the version after we apply our diffs below!
  await writeFile(
    pkgJsonPath,
    JSON.stringify(
      {
        ...pkgJson,
        whare: {
          ...pkgJson.whare,
          whareVersionPlaceholderDONOTUSE: `<${previousWhareVersion}>`,
        },
      },
      null,
      2,
    ),
  );

  // Get ignored workspaces from package.json
  let ignoredWorkspaces = new Set(
    ((pkgJson.whare?.ignoredWorkspaces || []) as string[]).map((workspace) =>
      normalizeWorkspacePath(projectPath, workspace),
    ),
  );

  // Create a temp directory to clone the repo
  let tempDir = path.join(os.tmpdir(), `whare-template-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  // Get diffs from template
  let diffs = await getRepoDiffs(fromVersion, currentHash, logger, tempDir);

  // bail if there are no diffs
  if (diffs.length === 0) {
    logger.log("No changes found in template");
    return;
  }

  // Filter out ignored files
  let filteredDiffs = diffs.filter(
    (diff) => !ignoredFiles.has(path.basename(diff.path)),
  );

  // Find all workspaces in the project
  let projectWorkspaces = [
    ...(await findWorkspaces(path.join(projectPath, "packages"))),
    ...(await findWorkspaces(path.join(projectPath, "apps"))),
  ].filter((workspace) => !ignoredWorkspaces.has(workspace));

  if (isDry) {
    logger.log(
      `Would update project from version ${fromVersion} to ${currentHash}`,
    );
    logger.log(`Found ${filteredDiffs.length} changes in template`);
    logger.log(
      `Found ${projectWorkspaces.length} workspaces to potentially update`,
    );
    if (ignoredWorkspaces.size > 0) {
      logger.log(
        `Ignoring workspaces: ${[...ignoredWorkspaces].map((w) => path.relative(projectPath, w)).join(", ")}`,
      );
    }
    logger.log(`Ignored files: ${[...ignoredFiles].join(", ")}`);
    return;
  }

  // Apply root-level changes (excluding workspace changes)
  let rootDiffs = filteredDiffs.filter(
    (diff) =>
      !diff.path.startsWith("packages/") && !diff.path.startsWith("apps/"),
  );
  for (let diff of rootDiffs) {
    await applyDiff(projectPath, diff, logger);
  }

  // Process each workspace
  let { templateLibrary, templateApp } = await getTemplateWorkspaces(tempDir);

  for (let workspacePath of projectWorkspaces) {
    let workspaceInfo = await getWorkspaceInfo(workspacePath);
    if (!workspaceInfo) {
      logger.log(
        `Warning: Could not read package.json for workspace: ${workspacePath}`,
      );
      continue;
    }

    // Find matching workspace in template
    let templateWorkspacePath = await findMatchingTemplateWorkspace(
      workspaceInfo,
      tempDir,
    );

    if (templateWorkspacePath) {
      // Get relative path from template root to template workspace
      let templateRelativePath = path.relative(tempDir, templateWorkspacePath);

      // Find diffs for this template workspace
      let workspaceDiffs = filteredDiffs.filter((d) =>
        d.path.startsWith(templateRelativePath + path.sep),
      );

      // Apply diffs to the project workspace
      for (let diff of workspaceDiffs) {
        let relativePath = diff.path.replace(
          templateRelativePath,
          workspacePath,
        );

        await applyDiff(
          projectPath,
          {
            ...diff,
            path: relativePath,
          },
          logger,
        );
      }
    } else {
      // No matching workspace found in template, apply template-library or template-app changes
      let isLibrary = workspacePath.startsWith(
        path.join(projectPath, "packages"),
      );
      let templatePath = isLibrary ? templateLibrary : templateApp;

      if (templatePath) {
        let templateRelativePath = path.relative(tempDir, templatePath);

        // Find diffs for the template workspace
        let workspaceDiffs = filteredDiffs.filter((d) =>
          d.path.startsWith(templateRelativePath + path.sep),
        );

        if (workspaceDiffs.length > 0) {
          logger.log(
            `Applying ${isLibrary ? "template-library" : "template-app"} changes to ${workspaceInfo.packageName}`,
          );

          // Apply diffs to the project workspace
          for (let diff of workspaceDiffs) {
            let relativePath = diff.path.replace(
              templateRelativePath,
              workspacePath,
            );

            await applyDiff(
              projectPath,
              {
                ...diff,
                path: relativePath,
              },
              logger,
            );
          }
        }
      } else {
        logger.log(
          `Note: No matching template workspace found for ${workspaceInfo.packageName} at ${workspacePath} and no template ${
            isLibrary ? "library" : "app"
          } available`,
        );
      }
    }
  }

  // Update version in package.json
  let fileContents = await readFile(pkgJsonPath, "utf8");
  // Replace <version> placeholder with currentHash and whareVersionPlaceholderDONOTUSE with version
  let updatedContents = fileContents.replace(
    /"whareVersionPlaceholderDONOTUSE":\s*"<[^>]+>"/,
    `"version": "${currentHash}"`,
  );
  await writeFile(pkgJsonPath, updatedContents);

  // Show status and instructions
  logger.log("\nUpdate completed! Review the changes:");
  logger.log(`1. Check 'git status' to see modified files`);
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
            `[Dry Run] Would clone template from: hamlim/monorepo-shell-template`,
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
        );

        if (!options.dry) {
          logger.log("Successfully staged update changes!");
        }
        break;
      }
      case "help": {
        console.log(
          "\nwhare - A CLI tool for creating and managing monorepos\n",
        );
        console.log("Description:");
        console.log(
          "  whare helps you create and maintain monorepo projects with best practices",
        );
        console.log(
          "  and standardized structure. It provides tools for initializing new monorepos",
        );
        console.log(
          "  and keeping them up to date with the latest template changes.\n",
        );
        console.log("Usage: whare [command] [options]\n");
        console.log("Commands:");
        console.log(
          "  init      Initialize a new whare monorepo project from the template",
        );
        console.log(
          "  update    Update an existing whare project with the latest template changes",
        );
        console.log("  help      Show this help message\n");
        console.log("Options:");
        console.log(
          "  --path    Specify the project path (default: current directory)",
        );
        console.log(
          "  --dry     Run the command in dry mode (shows what would happen without making changes)",
        );
        console.log(
          "  --verbose Show detailed output during command execution\n",
        );
        console.log("Examples:");
        console.log("  whare init my-monorepo");
        console.log("  whare update --dry");
        console.log("  whare update --verbose\n");
        process.exit(0);
        break;
      }
      default: {
        console.error(
          "Invalid command. Available commands: init, update, help",
        );
        process.exit(1);
      }
    }
  } finally {
    // Write logs to file if not in verbose mode
    await logger.writeLogs();
  }
}
