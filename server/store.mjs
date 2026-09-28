import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { schemas, fail } from "./domain.mjs";

export function createStore(path, { clock = Date.now } = {}) {
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
  );
  db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS tasks(number INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS actors(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('human','agent')));
 CREATE INDEX IF NOT EXISTS events_by_task ON events(task_id, sequence);
 INSERT OR IGNORE INTO migrations VALUES(1);
 INSERT OR IGNORE INTO migrations VALUES(2); COMMIT;`);
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  // Upgrade stored records once so every execution path uses the same contract.
  transaction(() => {
    if (!db.prepare("SELECT version FROM migrations WHERE version=3").get()) {
      const rows = db.prepare("SELECT number, data FROM tasks").all();
      const update = db.prepare("UPDATE tasks SET data=? WHERE number=?");
      for (const row of rows) {
        const task = JSON.parse(row.data);
        task.labels = task.label?.trim() ? [task.label.trim()] : [];
        delete task.label;
        update.run(JSON.stringify(task), row.number);
      }
      db.prepare("INSERT INTO migrations VALUES(3)").run();
    }
  });
  const readTransaction = (fn) => {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const all = () =>
    db
      .prepare("SELECT data FROM tasks ORDER BY number DESC")
      .all()
      .map((r) => JSON.parse(r.data));
  const get = (id) => {
    const row = db
      .prepare("SELECT data FROM tasks WHERE number=?")
      .get(Number(id.slice(4)));
    if (!row) fail("NOT_FOUND", "Task not found", 404);
    return JSON.parse(row.data);
  };
  const save = (t) =>
    db
      .prepare("UPDATE tasks SET data=? WHERE number=?")
      .run(JSON.stringify(t), Number(t.id.slice(4)));
  const actorRoster = () =>
    db
      .prepare("SELECT id, kind FROM actors ORDER BY id")
      .all()
      .map(({ id, kind }) => ({ id, kind }));
  const addActor = (actor) => {
    const existing = db
      .prepare("SELECT kind FROM actors WHERE id=?")
      .get(actor.id);
    if (existing && existing.kind !== actor.kind)
      fail(
        "ACTOR_KIND_CONFLICT",
        `Actor ${actor.id} is already registered as ${existing.kind}`,
      );
    if (!existing)
      db.prepare("INSERT INTO actors(id,kind) VALUES(?,?)").run(
        actor.id,
        actor.kind,
      );
  };
  const validActor = (actor) => {
    if (
      typeof actor?.id !== "string" ||
      actor.id.length === 0 ||
      !["human", "agent"].includes(actor.kind)
    )
      fail("UNAUTHORIZED", "Valid actor required", 401);
    return { id: actor.id, kind: actor.kind };
  };
  const registerActors = (actors) => {
    const identities = actors.map(validActor);
    let needsWrite = false;
    for (const identity of identities) {
      const existing = db
        .prepare("SELECT kind FROM actors WHERE id=?")
        .get(identity.id);
      if (existing && existing.kind !== identity.kind)
        fail(
          "ACTOR_KIND_CONFLICT",
          `Actor ${identity.id} is already registered as ${existing.kind}`,
        );
      if (!existing) needsWrite = true;
    }
    if (!needsWrite) return;
    transaction(() => {
      for (const identity of identities) addActor(identity);
    });
  };
  const commentCounts = (ids) => {
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT task_id, COUNT(*) AS count FROM events WHERE kind='add_comment' AND task_id IN (${placeholders}) GROUP BY task_id`,
      )
      .all(...ids);
    return new Map(rows.map((row) => [row.task_id, Number(row.count)]));
  };
  const withCommentCount = (t, count) => ({ ...t, commentCount: count });
  const event = (id, actor, kind, body = "") =>
    db
      .prepare(
        "INSERT INTO events(task_id,actor,kind,body,created_at) VALUES(?,?,?,?,?)",
      )
      .run(id, actor.id, kind, body, new Date(clock()).toISOString());
  const detail = (t) => {
    const events = db
      .prepare(
        "SELECT sequence, actor, kind, body, created_at AS createdAt FROM events WHERE task_id=? ORDER BY sequence",
      )
      .all(t.id);
    return {
      ...withCommentCount(
        t,
        events.filter((event) => event.kind === "add_comment").length,
      ),
      events,
    };
  };
  const active = (t) => t.lease && t.lease.expiresAt > clock();
  function execute(command, input, actor) {
    const identity = validActor(actor);
    registerActors([identity]);
    const schema = schemas[command];
    if (!schema) fail("UNKNOWN_COMMAND", "Unknown command", 404);
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      fail(
        "VALIDATION",
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
        400,
      );
    const p = parsed.data;
    if (command === "workspace_info")
      return {
        name: "Studio",
        actor: identity,
        actors: actorRoster(),
        leaseSeconds: 900,
        schemaVersion: 3,
      };
    if (command === "list_tasks") {
      return readTransaction(() => {
        const q = p.query?.toLowerCase();
        const rows = all().filter(
          (t) =>
            !t.archived &&
            (!q ||
              `${t.id} ${t.title} ${t.description}`
                .toLowerCase()
                .includes(q)) &&
            (!p.status || t.status === p.status) &&
            (!p.assignee || t.assignee === p.assignee),
        );
        const page = rows.slice(p.offset, p.offset + p.limit);
        const counts = commentCounts(page.map((t) => t.id));
        return {
          tasks: page.map((t) => withCommentCount(t, counts.get(t.id) ?? 0)),
          total: rows.length,
        };
      });
    }
    if (command === "get_task")
      return readTransaction(() => detail(get(p.id)));
    if (command === "export_workspace") {
      if (identity.kind !== "human")
        fail("FORBIDDEN", "Human access required", 403);
      return transaction(() => ({
        schemaVersion: 3,
        exportedAt: new Date(clock()).toISOString(),
        actors: actorRoster(),
        tasks: all(),
        events: db.prepare("SELECT * FROM events ORDER BY sequence").all(),
      }));
    }
    return transaction(() => {
      if (command === "create_task") {
        const result = db.prepare("INSERT INTO tasks(data) VALUES('{}')").run();
        const now = new Date(clock()).toISOString();
        const t = {
          ...p,
          id: `TNB-${String(result.lastInsertRowid).padStart(3, "0")}`,
          status: "backlog",
          version: 1,
          createdAt: now,
          updatedAt: now,
          lease: null,
          archived: false,
        };
        save(t);
        event(t.id, identity, "created");
        return detail(t);
      }
      const t = get(p.id);
      if (t.archived) fail("ARCHIVED", "Task is archived");
      if (t.version !== p.expectedVersion)
        fail(
          "VERSION_CONFLICT",
          `Task changed. Read it again. Current version: ${t.version}`,
        );
      if (command === "set_standup_notes" && identity.kind === "human") {
        // Presentation annotations do not change execution ownership or status.
        // They still advance the version so concurrent edits cannot be lost.
        t.standup = { highlight: p.highlight, blocker: p.blocker };
      } else if (command === "claim_task") {
        if (active(t))
          fail("LEASE_CONFLICT", `Task is claimed by ${t.lease.actor}`);
        if (!["backlog", "in_progress"].includes(t.status))
          fail(
            "INVALID_TRANSITION",
            "Only backlog or in-progress tasks can be claimed",
          );
        t.lease = { actor: identity.id, expiresAt: clock() + 900000 };
        t.assignee = identity.id;
        t.status = "in_progress";
      } else {
        if (active(t) && t.lease.actor !== identity.id)
          fail("LEASE_CONFLICT", `Task is claimed by ${t.lease.actor}`);
        if (
          identity.kind === "agent" &&
          (!active(t) || t.lease.actor !== identity.id)
        )
          fail("LEASE_REQUIRED", "Claim this task before changing it");
        if (command === "heartbeat" || command === "release_task") {
          if (!active(t) || t.lease.actor !== identity.id)
            fail("LEASE_REQUIRED", "An active owned claim is required");
          if (command === "heartbeat") t.lease.expiresAt = clock() + 900000;
          else t.lease = null;
        }
        if (command === "update_task") {
          if (
            identity.kind === "agent" &&
            (p.patch.assignee !== undefined ||
              (p.patch.status !== undefined &&
                p.patch.status !== "in_progress"))
          )
            fail(
              "FORBIDDEN",
              "Agents use submit_review; reassignment and completion require a human",
              403,
            );
          if (p.patch.status === "done" && t.status !== "in_review")
            fail(
              "INVALID_TRANSITION",
              "Tasks must be reviewed before completion",
            );
          Object.assign(t, p.patch);
          if (["in_review", "done"].includes(t.status)) t.lease = null;
        }
        if (command === "set_standup_notes") {
          t.standup = { highlight: p.highlight, blocker: p.blocker };
        }
        if (command === "submit_review") {
          if (t.status !== "in_progress")
            fail(
              "INVALID_TRANSITION",
              "Only in-progress tasks can be submitted",
            );
          t.status = "in_review";
          t.lease = null;
          t.review = {
            summary: p.summary,
            artifactUrl: p.artifactUrl,
            actor: identity.id,
          };
        }
        if (command === "archive_task") {
          if (identity.kind !== "human")
            fail("FORBIDDEN", "Only humans may archive", 403);
          t.archived = true;
        }
      }
      t.version++;
      t.updatedAt = new Date(clock()).toISOString();
      save(t);
      event(
        t.id,
        identity,
        command,
        p.body ??
          (command === "submit_review"
            ? JSON.stringify(t.review)
            : command === "set_standup_notes"
              ? JSON.stringify(t.standup)
              : command === "update_task"
                ? JSON.stringify(p.patch)
                : ""),
      );
      return detail(t);
    });
  }
  return { execute, registerActors, close: () => db.close() };
}
