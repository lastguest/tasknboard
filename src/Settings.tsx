import { useEffect, useId, useRef, useState } from "react";
import { isEmbedded } from "./embedded";
import { command, downloadText, errorOf, nativeWorkspace, token } from "./api";
import { CodexConnection } from "./CodexConnection";
import { Label } from "./Board";
import { AppVersion, AppUpdates, desktopApp } from "./AppUpdates";
import { describeError, Dialog, shortcuts, type RefreshResult } from "./Dialogs";
import { Avatar, PeopleContext, usePeople } from "./People";
import { CliHelper } from "./CliHelper";
import { GitHubSettings } from "./GitHubSettings";
import { Icon } from "./Icons";
import { epicPalette, type Actor } from "./types";

export default function Settings({
  actor,
  connected,
  initialPage,
  onClose,
  onReconnect,
}: {
  actor: Actor;
  connected: boolean;
  initialPage?: SettingsPage;
  onClose: () => void;
  onReconnect: () => Promise<RefreshResult>;
}) {
  const profileActor = { ...(usePeople().get(actor.id) ?? {}), ...actor };
  const [page, setPage] = useState<SettingsPage>(
    connected ? (initialPage ?? "profile") : "connection-data",
  );
  const [search, setSearch] = useState("");
  const tokenId = useId();
  const [value, setValue] = useState(token.get());
  const [stored, setStored] = useState(Boolean(token.get()));
  const [connection, setConnection] = useState<null | {
    ok: boolean;
    text: string;
  }>(null);
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exported, setExported] = useState<null | {
    ok: boolean;
    text: string;
  }>(null);

  async function saveConnection(next: string) {
    setSaving(true);
    setConnection(null);
    token.set(next.trim());
    setStored(Boolean(next.trim()));
    if (!next.trim()) setValue("");
    const result = await onReconnect();
    setSaving(false);
    setConnection(
      result.ok
        ? { ok: true, text: "Connection saved. The workspace is refreshed." }
        : {
            ok: false,
            text:
              result.error.code === "UNAUTHORIZED"
                ? "Authentication failed. The workspace rejected this token."
                : `Couldn't connect: ${result.error.message}`,
          },
    );
  }

  async function exportWorkspace() {
    setExporting(true);
    setExported(null);
    try {
      const data = await command<{ tasks: unknown[]; events: unknown[] }>(
        "export_workspace",
      );
      const name = `tasknboard-export-${new Date().toISOString().slice(0, 10)}.json`;
      await downloadText(name, "application/json", JSON.stringify(data, null, 2));
      setExported({
        ok: true,
        text: `Export requested: ${data.tasks.length} tasks and ${data.events.length} activity events. Check your downloads or save dialog for ${name}.`,
      });
    } catch (e) {
      setExported({ ok: false, text: `Export failed: ${errorOf(e).message}` });
    } finally {
      setExporting(false);
    }
  }

  const pages: {
    id: SettingsPage;
    label: string;
    icon: string;
    group: string;
    keywords: string;
  }[] = [
    {
      id: "profile",
      label: "Profile",
      icon: "user",
      group: "Account",
      keywords: "name display picture photo avatar image me",
    },
    {
      id: "connection-data",
      label: "Connection & data",
      icon: "plug",
      group: "Workspace",
      keywords:
        "token access auth server sign in status workspace export import download json backup archive activity",
    },
    {
      id: "labels",
      label: "Labels",
      icon: "hash",
      group: "Workspace",
      keywords: "label tag rename remove delete merge",
    },
    {
      id: "github",
      label: "GitHub",
      icon: "github",
      group: "Integrations",
      keywords: "github pull request pr review code diff token integration",
    },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      icon: "keyboard",
      group: "App",
      keywords: shortcuts.flat().join(" "),
    },
    {
      id: "cli",
      label: "Command line",
      icon: "screen",
      group: "App",
      keywords: "cli terminal helper command install tasknboard desktop",
    },
  ];
  if (desktopApp()) {
    pages.push({
      id: "updates",
      label: "Updates",
      icon: "screen",
      group: "App",
      keywords: "version release check download install update",
    });
  }
  const q = search.trim().toLowerCase();
  const visible = pages.filter(
    (p) => !q || `${p.label} ${p.keywords}`.toLowerCase().includes(q),
  );
  const groups = [...new Set(visible.map((p) => p.group))];
  const title = pages.find((p) => p.id === page)!.label;

  return (
    <Dialog
      title="Settings"
      onClose={onClose}
      dismissOnBackdrop
      className="settings-dialog"
    >
      <div className="settings-layout">
        <aside className="settings-nav">
          <label className="settings-search">
            <Icon name="search" size={15} />
            <span className="sr-only">Search settings</span>
            <input
              type="search"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <nav aria-label="Settings sections">
            {groups.map((group) => (
              <div key={group} className="settings-nav-group">
                <span className="settings-nav-heading">{group}</span>
                {visible
                  .filter((p) => p.group === group)
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="settings-nav-item"
                      aria-current={p.id === page ? "page" : undefined}
                      onClick={() => setPage(p.id)}
                    >
                      <Icon name={p.icon} size={16} />
                      <span>{p.label}</span>
                    </button>
                  ))}
              </div>
            ))}
            {!visible.length && (
              <p className="small settings-nav-empty">No matching settings</p>
            )}
          </nav>
          <AppVersion />
        </aside>
        <div className="settings-main">
          <div className="settings-page">
            <h3 className="settings-title">{title}</h3>
            {page === "profile" && (
              <ProfileSettings
                actor={profileActor}
                connected={connected}
                onSaved={onReconnect}
              />
            )}
            {page === "connection-data" && (
              <>
                {(isEmbedded() || desktopApp()) && <CodexConnection />}
                <SettingsGroup title="Status">
                  <SettingsRow
                    title="Workspace"
                    hint={
                      connected
                        ? `Signed in as ${actor.id} (${actor.kind}).`
                        : "Not connected to the workspace service."
                    }
                  >
                    <span
                      className={`settings-pill ${connected ? "on" : "off"}`}
                    >
                      {connected ? "Connected" : "Offline"}
                    </span>
                  </SettingsRow>
                  {window.tasknboardShell && (
                    <SettingsRow
                      title="Server"
                      hint={`Server: ${location.origin}`}
                    >
                      <button
                        type="button"
                        className="secondary small-button"
                        onClick={() => window.tasknboardShell?.changeServer()}
                      >
                        Change server
                      </button>
                    </SettingsRow>
                  )}
                </SettingsGroup>
                {!isEmbedded() && !nativeWorkspace() && <SettingsGroup title="Authentication">
                  <form
                    className="settings-row settings-row-stack"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveConnection(value);
                    }}
                  >
                    <div className="settings-row-text">
                      <label className="settings-row-title" htmlFor={tokenId}>
                        Workspace access token
                      </label>
                      <span className="settings-row-hint">
                        Needed only for a shared server. Kept for this browser
                        session only and never shown again.
                      </span>
                    </div>
                    <div className="settings-token">
                      <input
                        id={tokenId}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={
                          stored
                            ? "A token is stored for this session"
                            : "Not needed for local mode"
                        }
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                      />
                      {stored && (
                        <button
                          type="button"
                          className="secondary small-button"
                          disabled={saving}
                          onClick={() => saveConnection("")}
                        >
                          Remove token
                        </button>
                      )}
                      <button
                        className="primary small-button"
                        disabled={saving}
                      >
                        {saving ? "Connecting…" : "Save connection"}
                      </button>
                    </div>
                    {connection && (
                      <p
                        className={
                          connection.ok ? "small ok" : "inline-error"
                        }
                        role={connection.ok ? "status" : "alert"}
                      >
                        {connection.text}
                      </p>
                    )}
                  </form>
                </SettingsGroup>}
                <SettingsGroup title="Backup">
                  <SettingsRow
                    title="Export workspace"
                    hint="Download all tasks, archived work, and the full activity log as JSON."
                  >
                    <button
                      type="button"
                      className="secondary small-button"
                      onClick={exportWorkspace}
                      disabled={exporting}
                    >
                      <Icon name="download" size={14} />
                      {exporting ? "Exporting…" : "Export workspace"}
                    </button>
                  </SettingsRow>
                  <SettingsRow
                    title="Import"
                    hint="Restoring from an export file is not available."
                  >
                    <span className="settings-pill off">Unavailable</span>
                  </SettingsRow>
                  {exported && (
                    <p
                      className={`settings-row-note ${exported.ok ? "small ok" : "inline-error"}`}
                      role={exported.ok ? "status" : "alert"}
                    >
                      {exported.text}
                    </p>
                  )}
                </SettingsGroup>
              </>
            )}
            {page === "labels" && (
              <LabelSettings connected={connected} onChanged={onReconnect} />
            )}
            {page === "github" && (
              <GitHubSettings
                canManage={connected && actor.kind === "human"}
                Group={SettingsGroup}
                Row={SettingsRow}
              />
            )}
            {page === "shortcuts" && (
              <SettingsGroup
                title="Shortcuts"
                note="Shortcuts are ignored while you type in a field. Each card's Status menu moves it without dragging."
              >
                {shortcuts.map(([key, label]) => (
                  <SettingsRow key={key} title={label}>
                    <kbd>{key}</kbd>
                  </SettingsRow>
                ))}
              </SettingsGroup>
            )}
            {page === "updates" && (
              <SettingsGroup title="App updates">
                <AppUpdates />
              </SettingsGroup>
            )}
            {page === "cli" && (
              <SettingsGroup
                title="CLI helper"
                note="Install and verify the command line helper for this desktop app."
              >
                <CliHelper />
              </SettingsGroup>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export type SettingsPage =
  | "profile"
  | "connection-data"
  | "labels"
  | "github"
  | "shortcuts"
  | "cli"
  | "updates";

const AVATAR_PIXELS = 128;

/** Crop to a centred square and re-encode small enough for one API request. */
async function avatarFromFile(file: File) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
    throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  if (file.size > 10 * 1024 * 1024)
    throw new Error("Choose an image smaller than 10 MB.");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("This image couldn't be read.");
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_PIXELS;
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_PIXELS,
    AVATAR_PIXELS,
  );
  bitmap.close();
  for (const quality of [0.86, 0.7, 0.5]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= 48000) return url;
  }
  throw new Error("This image is too detailed to store. Try another one.");
}

function ProfileSettings({
  actor,
  connected,
  onSaved,
}: {
  actor: Actor;
  connected: boolean;
  onSaved: () => Promise<RefreshResult>;
}) {
  const nameId = useId();
  const gravatarToggleId = useId();
  const gravatarEmailId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(actor.name ?? "");
  const [avatar, setAvatar] = useState(actor.avatar ?? "");
  const [useGravatar, setUseGravatar] = useState(
    Boolean(actor.useGravatar),
  );
  const [gravatarEmail, setGravatarEmail] = useState(
    actor.gravatarEmail ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<null | { ok: boolean; text: string }>(null);
  const dirty =
    name.trim() !== (actor.name ?? "") ||
    avatar !== (actor.avatar ?? "") ||
    useGravatar !== Boolean(actor.useGravatar) ||
    gravatarEmail.trim().toLowerCase() !== (actor.gravatarEmail ?? "");
  const preview = new Map([
    [actor.id, { ...actor, name: name.trim(), avatar, useGravatar }],
  ]);

  async function choose(file: File | undefined) {
    if (!file) return;
    setNote(null);
    try {
      setAvatar(await avatarFromFile(file));
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setNote(null);
    try {
      await command("update_profile", {
        name: name.trim(),
        avatar,
        useGravatar,
        gravatarEmail: gravatarEmail.trim(),
      });
      setGravatarEmail(gravatarEmail.trim().toLowerCase());
      await onSaved();
      setNote({ ok: true, text: "Profile saved. Everyone sees it on their next refresh." });
    } catch (err) {
      setNote({ ok: false, text: describeError(errorOf(err)) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save}>
      <SettingsGroup
        title="How others see you"
        note={`Your workspace ID stays “${actor.id}”. Assignments, claims, and history keep using it.`}
      >
        <div className="settings-row profile-row">
          <PeopleContext.Provider value={preview}>
            <Avatar
              name={actor.id}
              agent={actor.kind === "agent"}
              size="large"
            />
          </PeopleContext.Provider>
          <div className="settings-row-text">
            <span className="settings-row-title">Profile picture</span>
            <span className="settings-row-hint">
              Square crop, resized to {AVATAR_PIXELS}px. Without a picture,
              your initials are shown.
            </span>
          </div>
          <div className="settings-row-control profile-picture-actions">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              tabIndex={-1}
              aria-label="Profile picture file"
              onChange={(e) => void choose(e.target.files?.[0])}
            />
            <button
              type="button"
              className="secondary small-button"
              onClick={() => fileInput.current?.click()}
            >
              {avatar ? "Change picture" : "Upload picture"}
            </button>
            {avatar && (
              <button
                type="button"
                className="quiet small-button"
                onClick={() => setAvatar("")}
              >
                Remove
              </button>
            )}
          </div>
        </div>
        <div className="settings-row settings-row-stack">
          <div className="settings-row-text">
            <label className="settings-row-title" htmlFor={nameId}>
              Display name
            </label>
            <span className="settings-row-hint">
              Shown on cards, in activity, and in the assignee picker. Leave
              empty to show your ID.
            </span>
          </div>
          <input
            id={nameId}
            type="text"
            maxLength={80}
            autoComplete="name"
            placeholder={actor.id}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="settings-row settings-row-stack gravatar-row">
          <div className="settings-row-text">
            <label className="settings-row-title" htmlFor={gravatarToggleId}>
              Use Gravatar
            </label>
            <span className="settings-row-hint">
              Use your Gravatar picture. Your uploaded picture stays saved.
            </span>
          </div>
          <input
            id={gravatarToggleId}
            type="checkbox"
            checked={useGravatar}
            onChange={(e) => setUseGravatar(e.target.checked)}
          />
        </div>
        {(useGravatar || Boolean(actor.gravatarEmail)) && (
          <div className="settings-row settings-row-stack">
            <div className="settings-row-text">
              <label className="settings-row-title" htmlFor={gravatarEmailId}>
                Gravatar email
              </label>
              <span className="settings-row-hint">
                {useGravatar
                  ? "Only you can see this address. Changes show after you save."
                  : "Only you can see this address. Clear it to remove it from your profile."}
              </span>
            </div>
            <input
              id={gravatarEmailId}
              type="email"
              autoComplete="email"
              maxLength={254}
              required={useGravatar}
              value={gravatarEmail}
              onChange={(e) => setGravatarEmail(e.target.value)}
            />
          </div>
        )}
      </SettingsGroup>
      <div className="form-actions">
        {note && (
          <p
            className={note.ok ? "small ok" : "inline-error"}
            role={note.ok ? "status" : "alert"}
          >
            {note.text}
          </p>
        )}
        <span className="spacer" />
        <button
          className="primary small-button"
          disabled={!dirty || saving || !connected}
        >
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}

type LabelUse = { name: string; tasks: number; color?: string };

/** Rename, merge or remove a label on every active task in the workspace. */
function LabelSettings({
  connected,
  onChanged,
}: {
  connected: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [labels, setLabels] = useState<LabelUse[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<null | {
    from: string;
    mode: "rename" | "remove";
    to: string;
  }>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<null | { ok: boolean; text: string }>(null);
  const inputId = useId();

  async function load() {
    try {
      const result = await command<{ labels: LabelUse[] }>("list_labels");
      setLabels(result.labels);
      setLoadError("");
    } catch (e) {
      setLoadError(errorOf(e).message);
    }
  }
  useEffect(() => {
    if (connected) void load();
  }, [connected]);

  async function apply(from: string, to: string) {
    setBusy(true);
    setNote(null);
    try {
      const result = await command<{ tasks: number; views: number }>(
        "rename_label",
        { from, to },
      );
      const count = `${result.tasks} ${result.tasks === 1 ? "task" : "tasks"}`;
      const views = result.views
        ? ` and ${result.views} saved ${result.views === 1 ? "view" : "views"}`
        : "";
      setNote({
        ok: true,
        text: to
          ? `Renamed “${from}” to “${to}” on ${count}${views}.`
          : `Removed “${from}” from ${count}.`,
      });
      setEditing(null);
      await Promise.all([load(), onChanged()]);
    } catch (e) {
      setNote({ ok: false, text: errorOf(e).message });
    } finally {
      setBusy(false);
    }
  }

  async function setColor(label: string, color: string) {
    setBusy(true);
    setNote(null);
    try {
      await command("set_label_color", { label, color });
      await Promise.all([load(), onChanged()]);
      setNote({ ok: true, text: `Updated the color of “${label}”.` });
    } catch (error) {
      setNote({ ok: false, text: errorOf(error).message });
    } finally { setBusy(false); }
  }

  if (!connected)
    return (
      <p className="small">Connect to the workspace to manage its labels.</p>
    );
  return (
    <SettingsGroup
      title="Labels"
      note="Changes apply to every active task, including claimed ones. Renaming to a label that already exists merges the two. Archived tasks keep their labels."
    >
      {loadError && (
        <p className="settings-row-note inline-error" role="alert">
          Couldn't load labels: {loadError}
        </p>
      )}
      {labels && !labels.length && (
        <p className="settings-row-note small">No task uses a label yet.</p>
      )}
      {labels?.map((label) =>
        editing?.from === label.name ? (
          <form
            key={label.name}
            className="settings-row settings-row-stack"
            onSubmit={(e) => {
              e.preventDefault();
              const to = editing.mode === "rename" ? editing.to.trim() : "";
              if (editing.mode === "rename" && (!to || to === label.name))
                return setEditing(null);
              void apply(label.name, to);
            }}
          >
            {editing.mode === "rename" ? (
              <>
                <label className="settings-row-title" htmlFor={inputId}>
                  Rename “{label.name}”
                </label>
                <div className="settings-token">
                  <input
                    id={inputId}
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    maxLength={40}
                    autoComplete="off"
                    value={editing.to}
                    onChange={(e) =>
                      setEditing({ ...editing, to: e.target.value })
                    }
                  />
                  <button
                    type="button"
                    className="secondary small-button"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                  <button className="primary small-button" disabled={busy}>
                    {busy ? "Saving…" : "Rename"}
                  </button>
                </div>
              </>
            ) : (
              <div className="settings-token">
                <span className="settings-row-title">
                  Remove “{label.name}” from {label.tasks}{" "}
                  {label.tasks === 1 ? "task" : "tasks"}?
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="secondary small-button"
                  disabled={busy}
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
                <button className="danger-button small-button" disabled={busy}>
                  {busy ? "Removing…" : "Remove"}
                </button>
              </div>
            )}
          </form>
        ) : (
          <div key={label.name} className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-title">
                <Label label={label.name} color={label.color} />
              </span>
              <span className="settings-row-hint">
                {label.tasks} {label.tasks === 1 ? "task" : "tasks"}
              </span>
            </div>
            <div className="settings-row-control">
              <select aria-label={`Color of ${label.name}`} value={label.color ?? "aurora"} disabled={busy}
                onChange={(event) => void setColor(label.name, event.target.value)}>
                {epicPalette.map((swatch) => <option key={swatch.id} value={swatch.id}>{swatch.name}</option>)}
                {label.color?.startsWith("#") && <option value={label.color}>Custom {label.color}</option>}
              </select>
              <button
                type="button"
                className="secondary small-button"
                aria-label={`Rename ${label.name}`}
                disabled={busy}
                onClick={() =>
                  setEditing({ from: label.name, mode: "rename", to: label.name })
                }
              >
                Rename
              </button>
              <button
                type="button"
                className="secondary small-button"
                aria-label={`Remove ${label.name}`}
                disabled={busy}
                onClick={() =>
                  setEditing({ from: label.name, mode: "remove", to: "" })
                }
              >
                Remove
              </button>
            </div>
          </div>
        ),
      )}
      {note && (
        <p
          className={`settings-row-note ${note.ok ? "small ok" : "inline-error"}`}
          role={note.ok ? "status" : "alert"}
        >
          {note.text}
        </p>
      )}
    </SettingsGroup>
  );
}

function SettingsGroup({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-group">
      <h4>{title}</h4>
      <div className="settings-card">{children}</div>
      {note && <p className="small settings-group-note">{note}</p>}
    </section>
  );
}

function SettingsRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}
