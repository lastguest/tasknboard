# Automatic local Codex connection

## Goal

Run the full TasknBoard interface inside Codex on the same computer.
Install the TasknBoard plugin once. Later Codex sessions connect automatically.
Users do not enter keys, tunnel IDs, plugin connection IDs, or server addresses.
The local connection requires no registered domain, hosted gateway, or OAuth provider.

The operating system user owns the workspace and credentials.
Codex account sign-in does not provision this local integration or select another account's cloud workspace.
The user installs the plugin through TasknBoard Settings before using it in Codex.

## Subsystems and contracts

The native supervisor runs one resident Node service for each operating system user.
The resident service owns SQLite, the domain rules, the HTTP API, and the MCP endpoint.
The CLI and desktop continue to call that service.

The local plugin declares a stdio MCP connection to the bundled bridge.
It uses Codex's supported `.codex-plugin/plugin.json` and `.mcp.json` package format.
This format accepts the absolute executable path of the bundled Node runtime.
The manifest stores only the bridge path, runtime descriptor path, and native helper path.
It contains no credential, server port, remote connection reference, or database path.

The bridge calls the native helper with `--service-attach`.
The helper starts the resident service if necessary and waits for its runtime descriptor.
The bridge reads the current loopback URL and obtains a signed app credential through the native helper.
The operating system credential store retains the service secret.

The bridge relays original MCP messages between SDK stdio and Streamable HTTP transports.
It does not create an MCP server, open SQLite, or duplicate domain rules.
The resident service exposes the interface through `resources/read` and application tools.
The board tool declares global and conversation entrypoints.
The installed Codex desktop source discovers these entrypoints from local MCP tools.

## First connection

1. Install and start the TasknBoard desktop app.
2. Open Settings and select Connect to Codex.
3. Open TasknBoard from the Codex sidebar.
4. Restart Codex if the installed plugin does not appear.

The connection uses the local workspace of the current operating system user.
Any required native credential prompt remains part of the operating system authorization flow.
The user never copies the credential into Codex.

## Later connections

Codex starts the bridge when it loads the installed plugin.
The bridge attaches the resident service and resolves its current port and credential again.
Closing Codex closes its MCP session. The resident service remains available to the desktop and CLI.
A service restart changes the descriptor. The bridge resolves that change before the next request.
It restores the MCP session with the original initialization capabilities.
A failed request reports an error. The bridge reconnects for subsequent requests without replaying the failed request.

## Security boundary

The integration uses the local operating system account, not a TasknBoard cloud account.
Switching Codex accounts within that operating system account does not change the local workspace.
Separate operating system users have separate service registrations, credentials, and application data.

Interface tools act as the local human user.
Model writes require a task-specific work session, current version, and owned lease.
The bridge accepts only a loopback HTTP endpoint and never forwards native credentials to a remote server.
Startup and transport diagnostics do not print secrets.

## Acceptance criteria

- A user installs the local plugin without an OpenAI Platform account or technical identifiers.
- Codex discovers the global board tool and reads the production interface resource.
- The interface creates and edits a task through the bridge and resident service.
- The same bridge resolves a changed port and reconnects after a service restart.
- Closing the bridge leaves the resident service running.
- Failed writes produce an explicit error and are never retried.
- Model requests cannot use interface privileges or write outside an authorized task work session.
- The CLI, desktop, and Codex interface use the same resident database and domain rules.
- A live installed Codex test verifies the sidebar and full interface when UI access is available.

## Public distribution

The local plugin is separate from a public directory submission.
OpenAI's public submission flow requires a stable HTTPS MCP endpoint and domain verification.
If public distribution becomes a requirement, define its hosting and OAuth contracts separately.
Do not add that infrastructure to the local connection.

Sources:

- [Plugin packaging and local marketplaces](https://developers.openai.com/plugins/build/plugins)
- [Plugin extensions](https://developers.openai.com/plugins/build/extensions)
- [Public plugin submission](https://developers.openai.com/plugins/deploy/submission)

## Validation status

See [verification evidence](../VERIFICATION.md) for protocol, browser, packaging, and installed-host results.
Static support in the installed host does not prove live sidebar availability for an account.
