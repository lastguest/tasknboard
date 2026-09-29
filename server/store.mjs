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
    if (!db.prepare("SELECT version FROM migrations WHERE version=7").get()) {
      // Boards own task numbering. Existing tasks and epics join board TNB,
      // which keeps their IDs, versions and activity.
      db.exec(`CREATE TABLE boards(number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, next_task INTEGER NOT NULL, data TEXT NOT NULL);
 ALTER TABLE tasks ADD COLUMN id TEXT;
 CREATE UNIQUE INDEX tasks_by_id ON tasks(id);
 ALTER TABLE epics ADD COLUMN id TEXT;
 CREATE UNIQUE INDEX epics_by_id ON epics(id);`);
      for (const table of ["tasks", "epics"]) {
        const update = db.prepare(`UPDATE ${table} SET id=?, data=? WHERE number=?`);
        for (const row of db.prepare(`SELECT number, data FROM ${table}`).all()) {
          const record = JSON.parse(row.data);
          record.board = "TNB";
          update.run(record.id, JSON.stringify(record), row.number);
        }
      }
      const now = new Date(clock()).toISOString();
      db.prepare(
        "INSERT INTO boards(id, next_task, data) VALUES('TNB', (SELECT COALESCE(MAX(number), 0) FROM tasks), ?)",
      ).run(
        JSON.stringify({
          id: "TNB",
          title: "Studio",
          showInSidebar: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        }),
      );
      db.prepare("INSERT INTO migrations VALUES(7)").run();
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=8").get()) {
      // A renamed board's old ID keeps resolving until a board takes it again.
      db.exec(`CREATE TABLE board_redirects(from_id TEXT PRIMARY KEY, to_id TEXT NOT NULL);
 INSERT INTO migrations VALUES(8);`);
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
  /** The current ID of a board, following a redirect from a former ID. */
  const boardOf = (id) =>
    db.prepare("SELECT to_id FROM board_redirects WHERE from_id=?").get(id)
      ?.to_id ?? id;
  /** Task IDs under a former board ID resolve to the renamed task. */
  const taskOf = (id) => {
    const split = id.lastIndexOf("-");
    return `${boardOf(id.slice(0, split))}${id.slice(split)}`;
  };
  const get = (id) => {
    const row = db.prepare("SELECT data FROM tasks WHERE id=?").get(taskOf(id));
    if (!row) fail("NOT_FOUND", "Task not found", 404);
    return JSON.parse(row.data);
  };
  const save = (t) =>
    db
      .prepare("UPDATE tasks SET data=? WHERE id=?")
      .run(JSON.stringify(t), t.id);
  const allBoards = () =>
    db
      .prepare("SELECT data FROM boards ORDER BY number")
      .all()
      .map((r) => JSON.parse(r.data));
  /** Adds `formerIds`: the old IDs that still redirect to each board. */
  const withFormerIds = (boards) => {
    const rows = db
      .prepare("SELECT from_id, to_id FROM board_redirects ORDER BY from_id")
      .all();
    return boards.map((b) => ({
      ...b,
      formerIds: rows.filter((r) => r.to_id === b.id).map((r) => r.from_id),
    }));
  };
  const getBoard = (id) => {
    const row = db.prepare("SELECT data FROM boards WHERE id=?").get(boardOf(id));
    if (!row) fail("NOT_FOUND", `Board ${id} not found`, 404);
    return JSON.parse(row.data);
  };
  const saveBoard = (b) =>
    db
      .prepare("UPDATE boards SET data=? WHERE id=?")
      .run(JSON.stringify(b), b.id);
  const allEpics = () =>
    db
      .prepare("SELECT data FROM epics ORDER BY number")
      .all()
      .map((r) => JSON.parse(r.data));
  const getEpic = (id) => {
    const row = db.prepare("SELECT data FROM epics WHERE id=?").get(id);
    if (!row) fail("NOT_FOUND", "Epic not found", 404);
    return JSON.parse(row.data);
  };
  const saveEpic = (e) =>
    db
      .prepare("UPDATE epics SET data=? WHERE id=?")
      .run(JSON.stringify(e), e.id);
  /**
   * Status counts of non-archived tasks, grouped by a task field ("epic" or
   * "board"). Derived on every read.
   */
  const withCounts = (records, field) => {
    const counts = new Map(
      records.map((r) => [
        r.id,
        { backlog: 0, in_progress: 0, in_review: 0, done: 0 },
      ]),
    );
    for (const t of all())
      if (!t.archived && counts.has(t[field])) counts.get(t[field])[t.status]++;
    return records.map((r) => ({ ...r, counts: counts.get(r.id) }));
  };
  /** A task may join only an existing, active epic on its own board. */
  const assignableEpic = (id, board) => {
    if (!id) return;
    const epic = getEpic(id);
    if (epic.board !== board)
      fail("EPIC_BOARD_MISMATCH", `${id} belongs to board ${epic.board}`);
    if (epic.archived)
      fail("EPIC_ARCHIVED", `${id} is archived; choose another epic`);
  };
  const humanOnly = (identity, action, subject) => {
    if (identity.kind !== "human")
      fail("FORBIDDEN", `Only humans may ${action} ${subject}`, 403);
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
        schemaVersion: 8,
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
            (!p.board || t.board === boardOf(p.board)) &&
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
    if (command === "list_boards")
      return readTransaction(() => ({
        boards: withFormerIds(withCounts(allBoards(), "board")),
      }));
    if (command === "create_board")
      return transaction(() => {
        humanOnly(identity, "create", "boards");
        if (db.prepare("SELECT 1 FROM boards WHERE id=?").get(p.id))
          fail("BOARD_EXISTS", `Board ${p.id} already exists`);
        const now = new Date(clock()).toISOString();
        const board = {
          id: p.id,
          title: p.title,
          showInSidebar: p.showInSidebar,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        // Registering a former ID again ends its redirect.
        db.prepare("DELETE FROM board_redirects WHERE from_id=?").run(p.id);
        db.prepare("INSERT INTO boards(id, next_task, data) VALUES(?, 0, ?)").run(
          board.id,
          JSON.stringify(board),
        );
        event(board.id, identity, "create_board");
        return withFormerIds(withCounts([board], "board"))[0];
      });
    if (command === "update_board")
      return transaction(() => {
        humanOnly(identity, "edit", "boards");
        const board = getBoard(p.id);
        if (board.version !== p.expectedVersion)
          fail(
            "VERSION_CONFLICT",
            `Board changed. Read it again. Current version: ${board.version}`,
          );
        Object.assign(board, p.patch);
        board.version++;
        board.updatedAt = new Date(clock()).toISOString();
        saveBoard(board);
        event(board.id, identity, "update_board", JSON.stringify(p.patch));
        return withFormerIds(withCounts([board], "board"))[0];
      });
    if (command === "rename_board")
      return transaction(() => {
        humanOnly(identity, "rename", "boards");
        const board = getBoard(p.id);
        if (board.version !== p.expectedVersion)
          fail(
            "VERSION_CONFLICT",
            `Board changed. Read it again. Current version: ${board.version}`,
          );
        if (db.prepare("SELECT 1 FROM boards WHERE id=?").get(p.newId))
          fail("BOARD_EXISTS", `Board ${p.newId} already exists`);
        const tasks = all().filter((t) => t.board === board.id);
        // A claim names the old ID, so claimed work must be released first.
        const claimed = tasks.filter((t) => active(t)).map((t) => t.id);
        if (claimed.length)
          fail(
            "LEASE_CONFLICT",
            `Release the claims on ${claimed.join(", ")} before changing the board ID`,
          );
        const now = new Date(clock()).toISOString();
        const moveTask = db.prepare("UPDATE tasks SET id=?, data=? WHERE id=?");
        const moveEvents = db.prepare("UPDATE events SET task_id=? WHERE task_id=?");
        for (const t of tasks) {
          const from = t.id;
          t.id = `${p.newId}${from.slice(board.id.length)}`;
          t.board = p.newId;
          t.version++;
          t.updatedAt = now;
          moveTask.run(t.id, JSON.stringify(t), from);
          moveEvents.run(t.id, from);
          event(t.id, identity, "rename_board", JSON.stringify({ from, to: t.id }));
        }
        for (const e of allEpics().filter((e) => e.board === board.id)) {
          e.board = p.newId;
          saveEpic(e);
        }
        moveEvents.run(p.newId, board.id);
        db.prepare("UPDATE boards SET id=? WHERE id=?").run(p.newId, board.id);
        // The old ID redirects to the new one. A redirect to the old ID
        // follows it, and one from the new ID ends because a board holds it.
        db.prepare("DELETE FROM board_redirects WHERE from_id=?").run(p.newId);
        db.prepare("UPDATE board_redirects SET to_id=? WHERE to_id=?").run(
          p.newId,
          board.id,
        );
        db.prepare("INSERT INTO board_redirects(from_id, to_id) VALUES(?, ?)").run(
          board.id,
          p.newId,
        );
        const from = board.id;
        Object.assign(board, {
          id: p.newId,
          version: board.version + 1,
          updatedAt: now,
        });
        saveBoard(board);
        event(
          board.id,
          identity,
          "rename_board",
          JSON.stringify({ from, to: p.newId }),
        );
        return withFormerIds(withCounts([board], "board"))[0];
      });
    if (command === "list_epics")
      return readTransaction(() => ({
        epics: withCounts(
          allEpics().filter(
            (e) =>
              (p.includeArchived || !e.archived) &&
              (!p.board || e.board === boardOf(p.board)),
          ),
          "epic",
        ),
      }));
    if (command === "create_epic")
      return transaction(() => {
        humanOnly(identity, "create", "epics");
        const { id: board } = getBoard(p.board);
        if (p.id && db.prepare("SELECT 1 FROM epics WHERE id=?").get(p.id))
          fail("EPIC_EXISTS", `Epic ${p.id} already exists`);
        const result = db.prepare("INSERT INTO epics(data) VALUES('{}')").run();
        const now = new Date(clock()).toISOString();
        const epic = {
          id: p.id ?? `EPIC-${result.lastInsertRowid}`,
          board,
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
        db.prepare("UPDATE epics SET id=?, data=? WHERE number=?").run(
          epic.id,
          JSON.stringify(epic),
          result.lastInsertRowid,
        );
        event(epic.id, identity, "created");
        return withCounts([epic], "epic")[0];
      });
    if (command === "update_epic" || command === "archive_epic")
      return transaction(() => {
        humanOnly(
          identity,
          command === "archive_epic" ? "archive" : "edit",
          "epics",
        );
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
        return withCounts([epic], "epic")[0];
      });
    if (command === "export_workspace") {
      if (identity.kind !== "human")
        fail("FORBIDDEN", "Human access required", 403);
      return transaction(() => ({
        schemaVersion: 8,
        exportedAt: new Date(clock()).toISOString(),
        actors: actorRoster(),
        boards: allBoards(),
        boardRedirects: db
          .prepare("SELECT from_id AS fromId, to_id AS toId FROM board_redirects ORDER BY from_id")
          .all(),
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
        const { id: board } = getBoard(p.board);
        assignableEpic(p.epic, board);
        // Numbers are allocated per board and never reused.
        const { next_task: number } = db
          .prepare(
            "UPDATE boards SET next_task=next_task+1 WHERE id=? RETURNING next_task",
          )
          .get(board);
        const now = new Date(clock()).toISOString();
        const t = {
          ...p,
          board,
          id: `${board}-${String(number).padStart(3, "0")}`,
          status: "backlog",
          version: 1,
          createdAt: now,
          updatedAt: now,
          lease: null,
          archived: false,
        };
        db.prepare("INSERT INTO tasks(id, data) VALUES(?, ?)").run(
          t.id,
          JSON.stringify(t),
        );
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
            assignableEpic(p.patch.epic, t.board);
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
