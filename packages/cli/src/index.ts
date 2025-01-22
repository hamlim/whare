import { exec as execRegular } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import degit from "degit";

let exec = promisify(execRegular);

type Command = "init" | "add" | "remove" | "update";

interface CommandOptions {
  path: string;
  dry: boolean;
}

function parseArgs(): { command: Command; options: CommandOptions } | null {
  let args = process.argv.slice(2);

  // Default return value
  let result = {
    command: null as Command | null,
    options: {
      path: ".", // Default to current directory
      dry: false,
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
    } else if (!arg.startsWith("--")) {
      // Assume it's a path if it's not a flag
      result.options.path = arg;
    }
  }

  return result as { command: Command; options: CommandOptions };
}

async function getCurrentTemplateHash(): Promise<string> {
  try {
    const { stdout } = await exec(
      `git ls-remote https://github.com/hamlim/template-monorepo.git`,
    );

    return stdout.split("\t")[0];
  } catch (error) {
    console.error("Failed to get current template hash", error);
    process.exit(1);
  }
}

export async function run(): Promise<void> {
  let parsedArgs = parseArgs();

  if (!parsedArgs) {
    console.error("No arguments provided");
    process.exit(1);
  }

  let { command, options } = parsedArgs;

  switch (command) {
    case "init": {
      let hash = await getCurrentTemplateHash();
      if (options.dry) {
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

      let emitter = degit("hamlim/template-monorepo", {
        cache: true,
        verbose: true,
      });

      emitter.on("info", (info): void => {
        console.log(info.message);
      });

      await emitter.clone(options.path);
      console.log("Successfully initialized project!");

      let rootPackageJson = await readFile(
        path.join(options.path, "package.json"),
        "utf8",
      );

      let rootPackageJsonObject = JSON.parse(rootPackageJson);

      rootPackageJsonObject.whare.version = hash;

      await writeFile(
        path.join(options.path, "package.json"),
        JSON.stringify(rootPackageJsonObject, null, 2),
      );

      break;
    }
    case "update": {
      if (options.dry) {
        console.log(`[Dry Run] Would update project at: ${options.path}`);
        break;
      }
      // @TODO: Implement update logic
      console.log(`Updating project at ${options.path}`);
      break;
    }
    case "add": {
      if (options.dry) {
        console.log(
          `[Dry Run] Would add components to project at: ${options.path}`,
        );
        break;
      }
      // @TODO: Implement add logic
      break;
    }
    case "remove": {
      if (options.dry) {
        console.log(
          `[Dry Run] Would remove components from project at: ${options.path}`,
        );
        break;
      }
      // @TODO: Implement remove logic
      break;
    }
    default: {
      console.error(
        "Invalid command. Available commands: init, add, remove, update",
      );
      process.exit(1);
    }
  }
}
