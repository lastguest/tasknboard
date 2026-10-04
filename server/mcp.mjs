import { startSupervisor } from "./mcp-supervisor.mjs";

startSupervisor({ worker: new URL("./mcp-worker.mjs", import.meta.url) });
