import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { schemas, fail, epicColors } from "./domain.mjs";
import { taskMatchesView } from "./views.mjs";

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
      // Saved views, and each actor's favourites among them.
      db.exec(`CREATE TABLE views(number INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
 CREATE TABLE view_favorites(actor TEXT NOT NULL, view_id TEXT NOT NULL, PRIMARY KEY(actor, view_id));
 INSERT INTO migrations VALUES(7);`);
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=8").get()) {
      // Server-side integration settings, such as the GitHub token. Never exported.
      db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
 INSERT INTO migrations VALUES(8);`);
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=9").get()) {
      // Workspace settings every client reads, such as the task and epic key prefixes.
      db.exec("CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
      db.prepare("INSERT INTO workspace VALUES(1, ?)").run(
        JSON.stringify({
          taskPrefix: "TNB",
          epicPrefix: "EPIC",
          formerTaskPrefixes: [],
          formerEpicPrefixes: [],
          version: 1,
        }),
      );
      db.prepare("INSERT INTO migrations VALUES(9)").run();
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=10").get()) {
      db.exec(`ALTER TABLE actors ADD COLUMN gravatar_email TEXT NOT NULL DEFAULT '';
 ALTER TABLE actors ADD COLUMN use_gravatar INTEGER NOT NULL DEFAULT 0;
 INSERT INTO migrations VALUES(10);`);
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=11").get()) {
      const previous = db.prepare("SELECT data FROM workspace WHERE id=1").get();
      const previousSettings = previous ? JSON.parse(previous.data) : {};
      const taskPrefix = previousSettings.taskPrefix ?? "TNB";
      db.exec(`CREATE TABLE boards(number INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
 CREATE TABLE board_prefixes(prefix TEXT PRIMARY KEY, board_id TEXT NOT NULL);`);
      const now = new Date(clock()).toISOString();
      const board = {
        id: "BOARD-1",
        name: "Default",
        prefix: taskPrefix,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.prepare("INSERT INTO boards(number, data) VALUES(1, ?)").run(
        JSON.stringify(board),
      );
      const reservePrefix = db.prepare(
        "INSERT INTO board_prefixes(prefix, board_id) VALUES(?, ?)",
      );
      for (const prefix of new Set([
        taskPrefix,
        ...(previousSettings.formerTaskPrefixes ?? []),
      ]))
        reservePrefix.run(prefix, board.id);
      const rows = db.prepare("SELECT number, data FROM tasks").all();
      const update = db.prepare("UPDATE tasks SET data=? WHERE number=?");
      for (const row of rows) {
        const task = JSON.parse(row.data);
        task.boardId = board.id;
        update.run(JSON.stringify(task), row.number);
      }
      db.exec("DROP TABLE IF EXISTS workspace");
      db.prepare("INSERT INTO migrations VALUES(11)").run();
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
  const allBoards = () =>
    db
      .prepare("SELECT data FROM boards ORDER BY number")
      .all()
      .map((row) => JSON.parse(row.data));
  const getBoard = (id) => {
    const number = Number(id.slice("BOARD-".length));
    const row = db.prepare("SELECT data FROM boards WHERE number=?").get(number);
    if (!row) fail("NOT_FOUND", "Board not found", 404);
    const board = JSON.parse(row.data);
    if (board.id !== id) fail("NOT_FOUND", "Board not found", 404);
    return board;
  };
  const saveBoard = (board) =>
    db
      .prepare("UPDATE boards SET data=? WHERE number=?")
      .run(JSON.stringify(board), Number(board.id.slice("BOARD-".length)));
  const reserveBoardPrefix = (prefix, boardId) => {
    const owner = db
      .prepare("SELECT board_id FROM board_prefixes WHERE prefix=?")
      .get(prefix);
    if (owner && owner.board_id !== boardId)
      fail("VALIDATION", `Prefix ${prefix} belongs to another board`, 400);
    if (!owner)
      db.prepare("INSERT INTO board_prefixes(prefix, board_id) VALUES(?, ?)").run(
        prefix,
        boardId,
      );
  };
  /** Adds `formerPrefixes`: the retired prefixes whose task keys still resolve on each board. */
  const withFormerPrefixes = (boards) => {
    const reservations = db
      .prepare("SELECT prefix, board_id FROM board_prefixes ORDER BY prefix")
      .all();
    return boards.map((board) => ({
      ...board,
      formerPrefixes: reservations
        .filter((r) => r.board_id === board.id && r.prefix !== board.prefix)
        .map((r) => r.prefix),
    }));
  };
  const taskKey = (board, n) => `${board.prefix}-${String(n).padStart(3, "0")}`;
  const all = () =>
    db
      .prepare("SELECT data FROM tasks ORDER BY number DESC")
      .all()
      .map((r) => JSON.parse(r.data));
  const nextTaskNumber = (boardId) =>
    all().reduce((max, task) => {
      if (task.boardId !== boardId) return max;
      return Math.max(max, Number(task.id.match(/-(\d+)$/)?.[1] ?? 0));
    }, 0) + 1;
  /** A key with a board's former prefix names that board's task with the same number. */
  const renamedTaskKey = (id) => {
    const [, prefix, number] = id.match(/^([A-Z][A-Z0-9]{0,9})-(\d+)$/) ?? [];
    const owner =
      prefix &&
      db.prepare("SELECT board_id FROM board_prefixes WHERE prefix=?").get(prefix);
    if (!owner) return "";
    const board = getBoard(owner.board_id);
    return board.prefix === prefix ? "" : `${board.prefix}-${number}`;
  };
  const findTask = (id) => {
    const row = db
      .prepare("SELECT data FROM tasks WHERE json_extract(data, '$.id')=?")
      .get(id);
    return row && JSON.parse(row.data);
  };
  const get = (id) =>
    findTask(id) ??
    findTask(renamedTaskKey(id)) ??
    fail("NOT_FOUND", "Task not found", 404);
  const save = (t) =>
    db
      .prepare("UPDATE tasks SET data=? WHERE json_extract(data, '$.id')=?")
      .run(JSON.stringify(t), t.id);
  const allEpics = () =>
    db
      .prepare("SELECT data FROM epics ORDER BY number")
      .all()
      .map((r) => JSON.parse(r.data));
  const findEpic = (id) => {
    const row = db
      .prepare("SELECT data FROM epics WHERE json_extract(data, '$.id')=?")
      .get(id);
    return row && JSON.parse(row.data);
  };
  const getEpic = (id) => findEpic(id) ?? fail("NOT_FOUND", "Epic not found", 404);
  const checkBoardPrefix = (prefix, exceptBoardId) => {
    const owner = db
      .prepare("SELECT board_id FROM board_prefixes WHERE prefix=?")
      .get(prefix);
    if (owner && owner.board_id !== exceptBoardId)
      fail("VALIDATION", `Prefix ${prefix} belongs to another board`, 400);
    if (
      allEpics().some(
        (epic) => epic.id.match(/^([A-Z][A-Z0-9]{0,9})-\d+$/)?.[1] === prefix,
      )
    )
      fail("VALIDATION", `Prefix ${prefix} is used by an epic`, 400);
  };
  const saveEpic = (e) =>
    db
      .prepare("UPDATE epics SET data=? WHERE json_extract(data, '$.id')=?")
      .run(JSON.stringify(e), e.id);
  const allViews = () =>
    db
      .prepare("SELECT data FROM views ORDER BY number")
      .all()
      .map((r) => JSON.parse(r.data));
  const saveView = (v) =>
    db
      .prepare("UPDATE views SET data=? WHERE number=?")
      .run(JSON.stringify(v), Number(v.id.slice(5)));
  /** Shared views are visible to everyone; personal ones only to their owner. */
  const canSee = (identity, v) => v.shared || v.owner === identity.id;
  const visibleView = (identity, id) => {
    const row = db
      .prepare("SELECT data FROM views WHERE number=?")
      .get(Number(id.slice(5)));
    const v = row && JSON.parse(row.data);
    // A personal view is not revealed to anyone else, not even by its ID.
    if (!v || !canSee(identity, v)) fail("NOT_FOUND", "View not found", 404);
    return v;
  };
  const withFavorite = (identity, views) => {
    const favorites = new Set(
      db
        .prepare("SELECT view_id FROM view_favorites WHERE actor=?")
        .all(identity.id)
        .map((r) => r.view_id),
    );
    return views.map((v) => ({ ...v, favorite: favorites.has(v.id) }));
  };
  /** Filters may name only existing epics; archived epics stay valid. */
  const checkFilterEpics = (filters) =>
    filters && {
      ...filters,
      conditions: filters.conditions.map((condition) =>
        condition.field === "epic"
          ? {
              ...condition,
              values: [
                ...new Set(
                  condition.values.map((value) => value && getEpic(value).id),
                ),
              ],
            }
          : condition,
      ),
    };
  /** Rewrite one board's task keys and event references in the current transaction. */
  const renameBoardTaskKeys = (board, prefix) => {
    const rewrites = [];
    const updateTask = db.prepare("UPDATE tasks SET data=? WHERE number=?");
    for (const row of db.prepare("SELECT number, data FROM tasks").all()) {
      const task = JSON.parse(row.data);
      if (task.boardId !== board.id) continue;
      const match = task.id.match(/^[A-Z][A-Z0-9]{0,9}-(\d+)$/);
      if (!match) fail("INVARIANT", `Invalid task key ${task.id}`);
      const previousId = task.id;
      const nextId = `${prefix}-${match[1]}`;
      if (previousId === nextId) continue;
      task.id = nextId;
      updateTask.run(JSON.stringify(task), row.number);
      rewrites.push([previousId, nextId]);
    }
    const updateEvent = db.prepare("UPDATE events SET task_id=? WHERE task_id=?");
    for (const [previousId, nextId] of rewrites)
      updateEvent.run(nextId, previousId);
  };
  /** Status counts of non-archived tasks, per epic. Derived on every read. */
  const withCounts = (epics, tasks = all()) => {
    const counts = new Map(
      epics.map((e) => [
        e.id,
        { backlog: 0, in_progress: 0, in_review: 0, done: 0 },
      ]),
    );
    for (const t of tasks)
      if (!t.archived && counts.has(t.epic)) counts.get(t.epic)[t.status]++;
    return epics.map((e) => ({ ...e, counts: counts.get(e.id) }));
  };
  /** A task may join only an existing, active epic. Returns its current key. */
  const assignableEpic = (id) => {
    if (!id) return "";
    const epic = getEpic(id);
    if (epic.archived)
      fail("EPIC_ARCHIVED", `${epic.title} is archived; choose another epic`);
    return epic.id;
  };
  const humanOnly = (identity, action, subject = "epics") => {
    if (identity.kind !== "human")
      fail("FORBIDDEN", `Only humans may ${action} ${subject}`, 403);
  };
  const avatarUrl = (email) =>
    email
      ? `https://gravatar.com/avatar/${createHash("sha256")
          .update(email.trim().toLowerCase())
          .digest("hex")}?s=128&d=404`
      : "";
  const publicActor = (row, includeEmail = false) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    avatar: row.avatar,
    useGravatar: Boolean(row.use_gravatar),
    gravatarUrl: row.use_gravatar ? avatarUrl(row.gravatar_email) : "",
    ...(includeEmail ? { gravatarEmail: row.gravatar_email } : {}),
  });
  const actorRoster = () =>
    db
      .prepare(
        "SELECT id, kind, name, avatar, gravatar_email, use_gravatar FROM actors ORDER BY id",
      )
      .all()
      .map((row) => publicActor(row));
  const profileOf = (id) => {
    const row = db
      .prepare(
        "SELECT id, kind, name, avatar, gravatar_email, use_gravatar FROM actors WHERE id=?",
      )
      .get(id);
    return row ? publicActor(row, true) : undefined;
  };
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
    if (command === "list_boards")
      return readTransaction(() => ({ boards: withFormerPrefixes(allBoards()) }));
    if (command === "create_board")
      return transaction(() => {
        humanOnly(identity, "create", "boards");
        checkBoardPrefix(p.prefix);
        const result = db.prepare("INSERT INTO boards(data) VALUES('{}')").run();
        const now = new Date(clock()).toISOString();
        const board = {
          id: `BOARD-${result.lastInsertRowid}`,
          name: p.name,
          prefix: p.prefix,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        saveBoard(board);
        reserveBoardPrefix(board.prefix, board.id);
        event(board.id, identity, "created");
        return withFormerPrefixes([board])[0];
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
        if (p.patch.prefix !== undefined)
          checkBoardPrefix(p.patch.prefix, board.id);
        const previousPrefix = board.prefix;
        Object.assign(board, p.patch);
        board.version++;
        board.updatedAt = new Date(clock()).toISOString();
        if (board.prefix !== previousPrefix) {
          reserveBoardPrefix(board.prefix, board.id);
          renameBoardTaskKeys(board, board.prefix);
        }
        saveBoard(board);
        event(board.id, identity, "update_board", JSON.stringify(p.patch));
        return withFormerPrefixes([board])[0];
      });
    if (command === "workspace_info")
      return {
        name: "Studio",
        actor: profileOf(identity.id),
        actors: actorRoster(),
        leaseSeconds: 900,
        boards: withFormerPrefixes(allBoards()),
        schemaVersion: 11,
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
        if (p.gravatarEmail !== undefined) {
          db.prepare("UPDATE actors SET gravatar_email=? WHERE id=?").run(
            p.gravatarEmail.toLowerCase(),
            identity.id,
          );
        }
        const profile = db
          .prepare(
            "SELECT gravatar_email, use_gravatar FROM actors WHERE id=?",
          )
          .get(identity.id);
        const willUseGravatar = p.useGravatar ?? Boolean(profile.use_gravatar);
        if (willUseGravatar && !profile.gravatar_email)
          fail("VALIDATION", "Enter a Gravatar email before enabling it", 400);
        if (p.useGravatar !== undefined) {
          db.prepare("UPDATE actors SET use_gravatar=? WHERE id=?").run(
            Number(p.useGravatar),
            identity.id,
          );
        }
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
        const view = p.view && visibleView(identity, p.view);
        if (p.boardId) getBoard(p.boardId);
        const epic =
          p.epic && p.epic !== "none" ? (findEpic(p.epic)?.id ?? p.epic) : p.epic;
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
            (!p.boardId || t.boardId === p.boardId) &&
            (!epic || (t.epic || "none") === epic) &&
            (!view || taskMatchesView(t, view.filters, identity.id)),
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
      return readTransaction(() => {
        if (p.boardId) getBoard(p.boardId);
        const tasks = all().filter((task) => !p.boardId || task.boardId === p.boardId);
        return {
          epics: withCounts(
            allEpics().filter((e) => p.includeArchived || !e.archived),
            tasks,
          ),
        };
      });
    if (command === "list_views")
      return readTransaction(() => ({
        views: withFavorite(
          identity,
          allViews().filter((v) => canSee(identity, v)),
        ),
      }));
    if (command === "create_view")
      return transaction(() => {
        humanOnly(identity, "create", "views");
        const filters = checkFilterEpics(p.filters);
        const result = db.prepare("INSERT INTO views(data) VALUES('{}')").run();
        const now = new Date(clock()).toISOString();
        const view = {
          id: `VIEW-${result.lastInsertRowid}`,
          name: p.name,
          description: p.description,
          color:
            p.color ??
            epicColors[(Number(result.lastInsertRowid) - 1) % epicColors.length],
          owner: identity.id,
          shared: p.shared,
          filters,
          display: p.display,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        saveView(view);
        event(view.id, identity, "created");
        return withFavorite(identity, [view])[0];
      });
    if (command === "update_view" || command === "delete_view")
      return transaction(() => {
        humanOnly(identity, command === "delete_view" ? "delete" : "edit", "views");
        const view = visibleView(identity, p.id);
        if (view.version !== p.expectedVersion)
          fail(
            "VERSION_CONFLICT",
            `View changed. Read it again. Current version: ${view.version}`,
          );
        if (command === "delete_view") {
          db.prepare("DELETE FROM views WHERE number=?").run(
            Number(view.id.slice(5)),
          );
          db.prepare("DELETE FROM view_favorites WHERE view_id=?").run(view.id);
          event(view.id, identity, "delete_view", JSON.stringify(view));
          return { id: view.id, deleted: true };
        }
        // Only the owner moves a view between the workspace and their own list.
        if (
          p.patch.shared !== undefined &&
          p.patch.shared !== view.shared &&
          view.owner !== identity.id
        )
          fail("FORBIDDEN", "Only the view's owner can change who sees it", 403);
        if (p.patch.filters) p.patch.filters = checkFilterEpics(p.patch.filters);
        Object.assign(view, p.patch);
        view.version++;
        view.updatedAt = new Date(clock()).toISOString();
        saveView(view);
        event(view.id, identity, command, JSON.stringify(p.patch));
        return withFavorite(identity, [view])[0];
      });
    if (command === "favorite_view")
      return transaction(() => {
        humanOnly(identity, "favorite", "views");
        const view = visibleView(identity, p.id);
        // A personal preference: it neither versions the view nor logs an event.
        if (p.favorite)
          db.prepare(
            "INSERT OR IGNORE INTO view_favorites(actor, view_id) VALUES(?,?)",
          ).run(identity.id, view.id);
        else
          db.prepare(
            "DELETE FROM view_favorites WHERE actor=? AND view_id=?",
          ).run(identity.id, view.id);
        return withFavorite(identity, [view])[0];
      });
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
        db.prepare("UPDATE epics SET data=? WHERE number=?").run(
          JSON.stringify(epic),
          result.lastInsertRowid,
        );
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
              `${epic.title} still has ${open} open ${open === 1 ? "task" : "tasks"}. Finish, move or archive them first.`,
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
        schemaVersion: 11,
        exportedAt: new Date(clock()).toISOString(),
        boards: allBoards(),
        actors: actorRoster(),
        epics: allEpics(),
        views: allViews(),
        viewFavorites: db
          .prepare("SELECT actor, view_id FROM view_favorites ORDER BY actor, view_id")
          .all()
          .map((row) => ({ actor: row.actor, viewId: row.view_id })),
        boardPrefixReservations: db
          .prepare(
            "SELECT prefix, board_id AS boardId FROM board_prefixes ORDER BY prefix",
          )
          .all()
          .map(({ prefix, boardId }) => ({ prefix, boardId })),
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
        const board = getBoard(p.boardId);
        const nextNumber = nextTaskNumber(board.id);
        const epic = assignableEpic(p.epic);
        const result = db.prepare("INSERT INTO tasks(data) VALUES('{}')").run();
        const now = new Date(clock()).toISOString();
        const t = {
          ...p,
          epic,
          id: taskKey(board, nextNumber),
          status: "backlog",
          version: 1,
          createdAt: now,
          updatedAt: now,
          lease: null,
          archived: false,
        };
        db.prepare("UPDATE tasks SET data=? WHERE number=?").run(
          JSON.stringify(t),
          result.lastInsertRowid,
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
          if (p.patch.epic !== undefined) {
            const epic = p.patch.epic && getEpic(p.patch.epic).id;
            if (epic !== (t.epic ?? "")) assignableEpic(epic);
            p.patch.epic = epic;
          }
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
  /** Integration settings live outside commands, so no client can read them. */
  const setting = (key) =>
    db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? "";
  const setSettings = (values) =>
    transaction(() => {
      for (const [key, value] of Object.entries(values))
        if (value) db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
        else db.prepare("DELETE FROM settings WHERE key=?").run(key);
    });
  return {
    execute,
    registerActors,
    image,
    setting,
    setSettings,
    close: () => db.close(),
  };
}
