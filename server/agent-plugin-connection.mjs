import { isAbsolute, join } from "node:path";

export function agentPluginConnection({
  runtimeFile,
  credentialHelper,
  resources,
  nodeExecutable = process.execPath,
  identity,
}) {
  const bridgeEntry = resources && join(resources, "mcp-bridge.mjs");
  if (
    ![runtimeFile, credentialHelper, nodeExecutable, bridgeEntry].every(
      (path) => typeof path === "string" && isAbsolute(path),
    )
  )
    return null;
  return {
    command: nodeExecutable,
    args: [
      "--disable-warning=ExperimentalWarning",
      bridgeEntry,
      "--agent",
      identity,
    ],
    env: {
      TASKNBOARD_RUNTIME_FILE: runtimeFile,
      TASKNBOARD_CREDENTIAL_HELPER: credentialHelper,
    },
  };
}
