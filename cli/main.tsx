import { render } from "ink";
import { connect } from "../server/client.mjs";
import { schemas } from "../server/domain.mjs";
import { App } from "./App.tsx";
import { cliActor } from "./identity.ts";
import { normalizeArguments, readCommandInput, requireExpectedVersion } from "./arguments.ts";
import { commandHelp } from "./help.ts";

const usage = `TasknBoard command line

Usage:
  tasknboard                    Open the interactive board
  tasknboard <command> --file <path>   Run a command with JSON from a UTF-8 file
  tasknboard <command> --stdin         Read JSON from standard input
${process.platform !== "win32" ? "  tasknboard <command> [json]          Run a command with direct JSON\n" : ""}  tasknboard <command>                Run a command without arguments
  tasknboard help               Show this help
  tasknboard help <command>     Show fields and a command example

Commands: ${Object.keys(schemas).filter(command => command !== "keep_alive").join(", ")}

Example:
  tasknboard list_boards
  tasknboard create_board --file board.json
  tasknboard create_task --file task.json
  tasknboard list_tasks --file filter.json

On Windows, use --file or --stdin for all JSON input.
Put the JSON object in args.json, then run tasknboard <command> --file args.json.
PowerShell: Get-Content -Raw -Encoding utf8 args.json | tasknboard <command> --stdin
Use one input mode per command.
Do not put JSON in tasknboard.cmd arguments. cmd.exe can interpret JSON text as shell commands.

The local SQLite file is TASKNBOARD_DB (default data/tasknboard.sqlite).
Set TASKNBOARD_AGENT_ID for agent commands. Non-interactive writes require it.
Set TASKNBOARD_AGENT_ROLE to worker or architect to select a local agent role.
If you omit the role, the CLI uses the stored role.
Set TASKNBOARD_SERVER_URL and TASKNBOARD_TOKEN to use a shared server.`;

function connectCli(command: string) {
  const actor = cliActor(command);
  return connect(actor ? { actor } : undefined);
}

async function once(name: string, json = "{}") {
  let args;
  try {
    args = normalizeArguments(name, JSON.parse(json));
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error;
    throw Object.assign(new Error("Arguments must be one JSON object."), {
      code: "USAGE",
    });
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw Object.assign(new Error("Arguments must be one JSON object."), { code: "USAGE" });
  requireExpectedVersion(name, args);
  const client = connectCli(name);
  try {
    console.log(JSON.stringify(await client.execute(name, args), null, 2));
  } finally {
    client.close();
  }
}

async function interactive() {
  if (process.env.TASKNBOARD_AGENT_ID) {
    console.error(
      "The interactive board is for human sessions; use one-shot commands as an agent.",
    );
    process.exitCode = 2;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "The interactive board needs a terminal. Run `tasknboard help` for scripting commands.",
    );
    process.exitCode = 2;
    return;
  }
  const client = connectCli("workspace_info");
  try {
    const app = render(<App client={client} />, {
      alternateScreen: true,
      exitOnCtrlC: false,
    });
    await app.waitUntilExit();
  } finally {
    client.close();
  }
}

const [name, ...inputArgs] = process.argv.slice(2);
try {
  if (["help", "--help", "-h"].includes(name)) {
    if (inputArgs.length > 1) throw Object.assign(new Error("Usage: tasknboard help [command]"), { code: "USAGE" });
    console.log(inputArgs[0] ? commandHelp(inputArgs[0]) : usage);
  }
  else if (!name) await interactive();
  else if (!(name in schemas) || name === "keep_alive") {
    console.error(`Unknown command.\n\n${usage}`);
    process.exitCode = 2;
  } else await once(name, await readCommandInput(inputArgs));
} catch (e) {
  const error = e as Error & { code?: string };
  const message = error.code === "VALIDATION" && Object.hasOwn(schemas, name)
    ? `${error.message} Run tasknboard help ${name} for fields and an example.`
    : error.message;
  console.error(
    JSON.stringify({ code: error.code ?? "ERROR", message }),
  );
  process.exitCode = 1;
}
