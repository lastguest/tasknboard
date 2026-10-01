import { render } from "ink";
import { connect } from "../server/client.mjs";
import { schemas } from "../server/domain.mjs";
import { App } from "./App.tsx";

const usage = `TasknBoard command line

Usage:
  tasknboard                    Open the interactive board
  tasknboard <command> [json]   Run one workspace command and print JSON
  tasknboard help               Show this help

Commands: ${Object.keys(schemas).join(", ")}

Example:
  tasknboard list_boards
  tasknboard create_board '{"name":"Engineering","prefix":"ENG"}'
  tasknboard create_task '{"boardId":"BOARD-1","title":"Ship it"}'
  tasknboard list_tasks '{"boardId":"BOARD-1","role":"in_review"}'

The local SQLite file is TASKNBOARD_DB (default data/tasknboard.sqlite).
Set TASKNBOARD_SERVER_URL and TASKNBOARD_TOKEN to use a shared server.`;

function connectCli() {
  const id = process.env.TASKNBOARD_AGENT_ID;
  return connect(id ? { actor: { id, kind: "agent" } } : undefined);
}

async function once(name: string, json = "{}") {
  let args;
  try {
    args = JSON.parse(json);
  } catch {
    throw Object.assign(new Error("Arguments must be one JSON object."), {
      code: "USAGE",
    });
  }
  const client = connectCli();
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
  const client = connectCli();
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

const [name, json, ...extra] = process.argv.slice(2);
try {
  if (["help", "--help", "-h"].includes(name)) console.log(usage);
  else if (!name) await interactive();
  else if (!(name in schemas) || extra.length) {
    console.error(`Unknown command or extra arguments.\n\n${usage}`);
    process.exitCode = 2;
  } else await once(name, json);
} catch (e) {
  const error = e as Error & { code?: string };
  console.error(
    JSON.stringify({ code: error.code ?? "ERROR", message: error.message }),
  );
  process.exitCode = 1;
}
