# GitHub integration contract

The workspace connects to one GitHub account. The **Pull requests** section
reads pull requests through that account. TasknBoard never writes to GitHub.

## Connection

The token is stored on the server in the `settings` table (migration 8). No
command returns it, and `export_workspace` leaves it out. The table is
internal, so `schemaVersion` does not change.

The service operator registers a GitHub OAuth app with **Device Flow** enabled
and sets `TASKNBOARD_GITHUB_CLIENT_ID`. No client secret is required.
The button opens GitHub's verification page. The user enters the displayed code
and approves access. The service polls GitHub and saves the token after it
verifies the account with `GET /user`. Settings starts polling as soon as the
code is shown, so approval is detected however the page was opened.

The OAuth app requests `repo` scope for private pull requests. GitHub includes
write permissions in this scope; TasknBoard only performs reads.
Authorization uses GitHub.com. `TASKNBOARD_GITHUB_API` and
`TASKNBOARD_GITHUB_OAUTH_URL` override provider endpoints for tests.
The browser verification link always points to `https://github.com/login/device`.

Pending authorization stays in server memory and belongs to the initiating human.
The service enforces the polling interval and expiry. Restarting the service
requires a new authorization attempt. Disconnect cancels pending authorization
and deletes the saved token. It does not revoke the grant on GitHub.

## Commands

All GitHub commands are for humans only (`FORBIDDEN` for agents). They are
available over HTTP. MCP, WebMCP and the CLI do not expose them.

- `github_status({})` returns `configured` plus `{ connected: false, source: "" }`,
  or `{ connected: true, source: "settings", account: { login, name, avatarUrl } }`.
- `connect_github({})` starts authorization and returns
  `{ userCode, verificationUri, expiresIn, interval }`. It never returns the device code.
- `poll_github_authorization({})` returns `{ pending: true, interval }` while waiting,
  or the connected status after approval. Rejected or expired requests return an error.
- `cancel_github_authorization({})` cancels the initiating human's pending attempt
  and returns the status. It keeps the saved connection.
- `disconnect_github({})` deletes the saved token and returns the new status.
- `list_pull_requests({ filter?, state?, query? })` searches pull requests
  that involve the account. `filter` is `all` (`involves:@me`), `reviewing`
  (`review-requested:@me`) or `authored` (`author:@me`). `state` is `open`
  (the default), `closed` or `all`. The result is the 50 most recently updated
  matches, as `{ total, pullRequests }`.
- `get_pull_request({ owner, repo, number })` returns a summary plus `body`,
  `checks`, `reviewers`, `commentCount`, `commitCount`, and the last 60
  timeline events as `activity`.
- `get_pull_request_files({ owner, repo, number })` returns up to 300 files
  with GitHub's unified `patch`. `patch` is `null` for binary or very large
  files.

Errors: `GITHUB_NOT_CONNECTED` (409), `NOT_FOUND` (404),
`GITHUB_UNAUTHORIZED`, `GITHUB_RATE_LIMITED`, `GITHUB_UNREACHABLE` and
`GITHUB_ERROR` (502).

## Links

The app opens a pull request from `#pulls/<owner>/<repo>/<number>`. It also
accepts a GitHub URL after `#`: replace `https://` in a pull request URL with
the app's address and `#`, like Linear's `linear.review` links. A GitHub pull
request URL pasted into the main search, or typed there and followed by Enter,
opens the pull request. A task links to a pull request when its review artifact
URL or description contains the pull request URL. Tasks with a pull request
artifact show **Review pull request**.
Avatars load from `avatars.githubusercontent.com`, which the content security
policy allows. Other remote images in pull request text remain links.
