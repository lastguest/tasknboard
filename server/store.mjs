import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { schemas, fail, epicColors } from "./domain.mjs";

// Decoded bytes must match the declared type; the data URL prefix alone is not trusted.
const imageSignatures = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString("latin1")),
  "image/webp": (b) =>
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP",
};

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
    if (!db.prepare("SELECT version FROM migrations WHERE version=4").get()) {
      db.exec(`ALTER TABLE actors ADD COLUMN name TEXT NOT NULL DEFAULT '';
 ALTER TABLE actors ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
 INSERT INTO migrations VALUES(4);`);
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=5").get()) {
      db.exec(`CREATE TABLE images(id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
 INSERT INTO migrations VALUES(5);`);
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=6").get()) {
      // Epics; existing tasks join no epic without a version change.
      db.exec(
        "CREATE TABLE epics(number INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)",
      );
      const rows = db.prepare("SELECT number, data FROM tasks").all();
      const update = db.prepare("UPDATE tasks SET data=? WHERE number=?");
      for (const row of rows) {
        const task = JSON.parse(row.data);
        task.epic ??= "";
        update.run(JSON.stringify(task), row.number);
      }
      db.prepare("INSERT INTO migrations VALUES(6)").run();
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
  const allEpics = () =>
    db
      .prepare("SELECT data FROM epics ORDER BY number")
      .all()
      .map((r) => JSON.parse(r.data));
  const getEpic = (id) => {
    const row = db
      .prepare("SELECT data FROM epics WHERE number=?")
      .get(Number(id.slice(5)));
    if (!row) fail("NOT_FOUND", "Epic not found", 404);
    return JSON.parse(row.data);
  };
  const saveEpic = (e) =>
    db
      .prepare("UPDATE epics SET data=? WHERE number=?")
      .run(JSON.stringify(e), Number(e.id.slice(5)));
  /** Status counts of non-archived tasks, per epic. Derived on every read. */
  const withCounts = (epics) => {
    const counts = new Map(
      epics.map((e) => [
        e.id,
        { backlog: 0, in_progress: 0, in_review: 0, done: 0 },
      ]),
    );
    for (const t of all())
      if (!t.archived && counts.has(t.epic)) counts.get(t.epic)[t.status]++;
    return epics.map((e) => ({ ...e, counts: counts.get(e.id) }));
  };
  /** A task may join only an existing, active epic. */
  const assignableEpic = (id) => {
    if (id && getEpic(id).archived)
      fail("EPIC_ARCHIVED", `${id} is archived; choose another epic`);
  };
  const humanOnly = (identity, action) => {
    if (identity.kind !== "human")
      fail("FORBIDDEN", `Only humans may ${action} epics`, 403);
  };
  const actorRoster = () =>
    db
      .prepare("SELECT id, kind, name, avatar FROM actors ORDER BY id")
      .all()
      .map(({ id, kind, name, avatar }) => ({ id, kind, name, avatar }));
  const profileOf = (id) =>
    actorRoster().find((candidate) => candidate.id === id);
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
        schemaVersion: 6,
      };
    if (command === "update_profile")
      return transaction(() => {
        // Every actor edits only its own profile; the ID never changes.
        if (p.name !== undefined)
          db.prepare("UPDATE actors SET name=? WHERE id=?").run(
            p.name,
            identity.id,
          );
        if (p.avatar !== undefined)
          db.prepare("UPDATE actors SET avatar=? WHERE id=?").run(
            p.avatar,
            identity.id,
          );
        return profileOf(identity.id);
      });
    if (command === "upload_image") {
      const [, mime, base64] = p.data.match(/^data:([^;]+);base64,(.*)$/);
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.length || !imageSignatures[mime](bytes))
        fail("VALIDATION", "data: image content does not match its type", 400);
      const id = randomBytes(16).toString("hex");
      transaction(() =>
        db
          .prepare(
            "INSERT INTO images(id,mime,data,actor,created_at) VALUES(?,?,?,?,?)",
          )
          .run(id, mime, bytes, identity.id, new Date(clock()).toISOString()),
      );
      return { id, url: `/files/${id}`, mime, bytes: bytes.length };
    }
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
            (!p.assignee || t.assignee === p.assignee) &&
            (!p.epic || (t.epic || "none") === p.epic),
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
    if (command === "list_epics")
      return readTransaction(() => ({
        epics: withCounts(
          allEpics().filter((e) => p.includeArchived || !e.archived),
        ),
      }));
    if (command === "create_epic")
      return transaction(() => {
        humanOnly(identity, "create");
        const result = db.prepare("INSERT INTO epics(data) VALUES('{}')").run();
        const now = new Date(clock()).toISOString();
        const epic = {
          id: `EPIC-${result.lastInsertRowid}`,
          title: p.title,
          description: p.description,
          // Unless chosen, rotate through the palette in creation order.
          color:
            p.color ??
            epicColors[(Number(result.lastInsertRowid) - 1) % epicColors.length],
          version: 1,
          archived: false,
          createdAt: now,
          updatedAt: now,
        };
        saveEpic(epic);
        event(epic.id, identity, "created");
        return withCounts([epic])[0];
      });
    if (command === "update_epic" || command === "archive_epic")
      return transaction(() => {
        humanOnly(identity, command === "archive_epic" ? "archive" : "edit");
        const epic = getEpic(p.id);
        if (epic.archived) fail("ARCHIVED", "Epic is archived");
        if (epic.version !== p.expectedVersion)
          fail(
            "VERSION_CONFLICT",
            `Epic changed. Read it again. Current version: ${epic.version}`,
          );
        if (command === "update_epic") Object.assign(epic, p.patch);
        else {
          const open = all().filter(
            (t) => !t.archived && t.epic === epic.id && t.status !== "done",
          ).length;
          if (open)
            fail(
              "EPIC_NOT_EMPTY",
              `${epic.id} still has ${open} open ${open === 1 ? "task" : "tasks"}. Finish, move or archive them first.`,
            );
          epic.archived = true;
        }
        epic.version++;
        epic.updatedAt = new Date(clock()).toISOString();
        saveEpic(epic);
        event(
          epic.id,
          identity,
          command,
          command === "update_epic" ? JSON.stringify(p.patch) : "",
        );
        return withCounts([epic])[0];
      });
    if (command === "export_workspace") {
      if (identity.kind !== "human")
        fail("FORBIDDEN", "Human access required", 403);
      return transaction(() => ({
        schemaVersion: 6,
        exportedAt: new Date(clock()).toISOString(),
        actors: actorRoster(),
        epics: allEpics(),
        tasks: all(),
        events: db.prepare("SELECT * FROM events ORDER BY sequence").all(),
        images: db
          .prepare(
            "SELECT id, mime, actor, created_at AS createdAt, data FROM images ORDER BY created_at, id",
          )
          .all()
          .map((image) => ({
            ...image,
            data: Buffer.from(image.data).toString("base64"),
          })),
      }));
    }
    return transaction(() => {
      if (command === "create_task") {
        assignableEpic(p.epic);
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
          if (p.patch.epic !== undefined && p.patch.epic !== (t.epic ?? ""))
            assignableEpic(p.patch.epic);
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
  /** Read one stored image for the file route. IDs are unguessable. */
  const image = (id) => {
    if (!/^[0-9a-f]{32}$/.test(id)) return null;
    const row = db.prepare("SELECT mime, data FROM images WHERE id=?").get(id);
    return row ? { mime: row.mime, data: Buffer.from(row.data) } : null;
  };
  return { execute, registerActors, image, close: () => db.close() };
}
