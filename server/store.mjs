import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  schemas,
  fail,
  epicColors,
  linkTypes,
  imageBytesLimit,
  pullRequestLimit,
  laneRoles,
  laneLimit,
} from "./domain.mjs";
import { taskMatchesView } from "./views.mjs";
import { similarityScorer, similarityThreshold } from "./similarity.mjs";
import { mentionedIdentities } from "./agent-config.mjs";
import { areTaskCommitsOnDefaultBranch } from "./commit-links.mjs";

// Decoded bytes must match the declared type; the data URL prefix alone is not trusted.
const imageSignatures = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString("latin1")),
  "image/webp": (b) =>
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP",
};
// A Markdown link or image target holding inline image data, as in
// ![shot](data:image/png;base64,...). Pasted text and agents can carry these.
const embeddedImage =
  /\]\(\s*<?data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})>?/g;

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
  let transactionDepth = 0;
  const transaction = (fn) => {
    if (transactionDepth) return fn();
    db.exec("BEGIN IMMEDIATE");
    transactionDepth++;
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally { transactionDepth--; }
  };
  const saveImage = (mime, bytes, actor) => {
    const id = randomBytes(16).toString("hex");
    db.prepare(
      "INSERT INTO images(id,mime,data,actor,created_at) VALUES(?,?,?,?,?)",
    ).run(id, mime, bytes, actor, new Date(clock()).toISOString());
    return id;
  };
  /**
   * Moves inline image data out of Markdown into the images table, leaving a
   * /files/ link. `saved` maps data already stored by this call to its ID, so a
   * repeated image is stored once. Data that is not a valid image calls `invalid`.
   */
  const storeEmbeddedImages = (text, actor, saved, invalid) =>
    text.includes("data:image/")
      ? text.replace(embeddedImage, (match, mime, base64) => {
          const bytes = Buffer.from(base64, "base64");
          if (
            !bytes.length ||
            bytes.length > imageBytesLimit ||
            !imageSignatures[mime](bytes)
          )
            return invalid(match);
          const key = `${mime};${base64}`;
          if (!saved.has(key)) saved.set(key, saveImage(mime, bytes, actor));
          return `](/files/${saved.get(key)}`;
        })
      : text;
  /** Lanes of a new board, one per role, in column order. */
  const defaultLanes = [
    ["Backlog", "todo"],
    ["In progress", "in_progress"],
    ["In review", "in_review"],
    ["Done", "done"],
  ];
  /** Adds the default lanes to a board. Returns the lane ID of each role. */
  const insertDefaultLanes = (boardId) => {
    const insert = db.prepare(
      "INSERT INTO lanes(board_id, position, name, role) VALUES(?,?,?,?)",
    );
    return Object.fromEntries(
      defaultLanes.map(([name, role], position) => [
        role,
        `LANE-${insert.run(boardId, position, name, role).lastInsertRowid}`,
      ]),
    );
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
        description: "",
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
    if (!db.prepare("SELECT version FROM migrations WHERE version=12").get()) {
      // Each person's boards hidden from their sidebar. Boards show by default.
      db.exec(`CREATE TABLE board_sidebar_hidden(actor TEXT NOT NULL, board_id TEXT NOT NULL, PRIMARY KEY(actor, board_id));
 INSERT INTO migrations VALUES(12);`);
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=13").get()) {
      // Boards gained a description.
      db.exec(`UPDATE boards SET data=json_set(data, '$.description', '')
 WHERE json_type(data, '$.description') IS NULL;
 INSERT INTO migrations VALUES(13);`);
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=14").get()) {
      // Links use stable task row numbers across prefix changes.
      db.exec(`CREATE TABLE task_links(from_number INTEGER NOT NULL REFERENCES tasks(number), to_number INTEGER NOT NULL REFERENCES tasks(number), kind TEXT NOT NULL CHECK(kind IN ('relates','blocks','duplicates')), PRIMARY KEY(from_number, to_number));
 CREATE INDEX task_links_to ON task_links(to_number);
 INSERT INTO migrations VALUES(14);`);
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=16").get()) {
      // Images embedded as data in Markdown move to the images table. Invalid
      // data stays as written; the renderer never displays it.
      const saved = new Map();
      const keep = (match) => match;
      const events = db
        .prepare(
          "SELECT sequence, actor, body FROM events WHERE instr(body, 'data:image/') ORDER BY sequence",
        )
        .all();
      const updateEvent = db.prepare("UPDATE events SET body=? WHERE sequence=?");
      for (const row of events) {
        const body = storeEmbeddedImages(row.body, row.actor, saved, keep);
        if (body !== row.body) updateEvent.run(body, row.sequence);
      }
      for (const table of ["tasks", "epics"]) {
        const rows = db
          .prepare(`SELECT number, data FROM ${table} WHERE instr(data, 'data:image/')`)
          .all();
        const update = db.prepare(`UPDATE ${table} SET data=? WHERE number=?`);
        for (const row of rows) {
          const data = storeEmbeddedImages(row.data, "tasknboard", saved, keep);
          if (data !== row.data) update.run(data, row.number);
        }
      }
      db.prepare("INSERT INTO migrations VALUES(16)").run();
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=17").get()) {
      // Each actor's Inbox read position: the last event sequence they marked read.
      // The Inbox finds each event's task by key, as findTask does.
      db.exec(`CREATE TABLE inbox_cursors(actor TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
 CREATE INDEX tasks_by_id ON tasks(json_extract(data, '$.id'));
 INSERT INTO migrations VALUES(17);`);
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=18").get()) {
      // Board lanes replace the four fixed task statuses. Each board gets one
      // lane per former status. Tasks, their history and views name lanes.
      db.exec(`CREATE TABLE lanes(number INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('todo','in_progress','in_review','done')));
 CREATE INDEX lanes_by_board ON lanes(board_id, position);`);
      const roleOfStatus = {
        backlog: "todo",
        in_progress: "in_progress",
        in_review: "in_review",
        done: "done",
      };
      const lanes = new Map(
        db
          .prepare("SELECT json_extract(data, '$.id') AS id FROM boards ORDER BY number")
          .all()
          .map((row) => [row.id, insertDefaultLanes(row.id)]),
      );
      const laneOf = (boardId, status) => lanes.get(boardId)[roleOfStatus[status]];
      const boardOfTask = new Map();
      const updateTask = db.prepare("UPDATE tasks SET data=? WHERE number=?");
      for (const row of db.prepare("SELECT number, data FROM tasks").all()) {
        const { status, ...task } = JSON.parse(row.data);
        task.lane = laneOf(task.boardId, status);
        boardOfTask.set(task.id, task.boardId);
        updateTask.run(JSON.stringify(task), row.number);
      }
      const updateEvent = db.prepare("UPDATE events SET body=? WHERE sequence=?");
      for (const row of db
        .prepare(
          `SELECT sequence, task_id, body FROM events WHERE kind='update_task' AND instr(body, '"status"')`,
        )
        .all()) {
        const { status, ...patch } = JSON.parse(row.body);
        if (status === undefined) continue;
        patch.lane = laneOf(boardOfTask.get(row.task_id), status);
        updateEvent.run(JSON.stringify(patch), row.sequence);
      }
      const updateView = db.prepare("UPDATE views SET data=? WHERE number=?");
      for (const row of db.prepare("SELECT number, data FROM views").all()) {
        const view = JSON.parse(row.data);
        view.filters.conditions = view.filters.conditions.map((c) =>
          c.field === "status"
            ? { ...c, field: "role", values: c.values.map((v) => roleOfStatus[v]) }
            : c,
        );
        if (view.display.groupBy === "status") view.display.groupBy = "lane";
        updateView.run(JSON.stringify(view), row.number);
      }
      db.prepare("INSERT INTO migrations VALUES(18)").run();
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=19").get()) {
      db.prepare("INSERT INTO migrations VALUES(19)").run();
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=20").get()) {
      const rejected = db.prepare("SELECT number, board_id FROM lanes WHERE role='rejected'").all();
      const replacements = new Map(rejected.map((lane) => [
        `LANE-${lane.number}`,
        `LANE-${db.prepare("SELECT number FROM lanes WHERE board_id=? AND role='todo' ORDER BY position LIMIT 1").get(lane.board_id).number}`,
      ]));
      for (const row of db.prepare("SELECT number, data FROM tasks").all()) {
        const task = JSON.parse(row.data);
        if (!replacements.has(task.lane)) continue;
        task.lane = replacements.get(task.lane);
        task.archived = true;
        task.lease = null;
        task.delegatedTo = "";
        task.delegatedBy = "";
        task.version++;
        db.prepare("UPDATE tasks SET data=? WHERE number=?").run(JSON.stringify(task), row.number);
      }
      for (const row of db.prepare("SELECT number, data FROM views").all()) {
        const view = JSON.parse(row.data);
        let changed = false;
        for (const condition of view.filters.conditions) {
          if (condition.field === "lane") {
            const values = condition.values.filter((id) => !replacements.has(id));
            if (values.length !== condition.values.length) {
              condition.values = values;
              changed = true;
            }
          } else if (condition.field === "role" && condition.values.includes("rejected")) {
            condition.values = condition.values.filter((role) => role !== "rejected");
            changed = true;
          }
        }
        if (changed) {
          view.filters.conditions = view.filters.conditions.filter((condition) => condition.values.length);
          view.version++;
          db.prepare("UPDATE views SET data=? WHERE number=?").run(JSON.stringify(view), row.number);
        }
      }
      const lastLaneNumber = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='lanes'").get()?.seq ?? 0;
      db.exec(`CREATE TABLE lanes_next(number INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('todo','in_progress','in_review','done')));
 INSERT INTO lanes_next SELECT * FROM lanes WHERE role<>'rejected';
 DROP TABLE lanes;
 ALTER TABLE lanes_next RENAME TO lanes;
 CREATE INDEX lanes_by_board ON lanes(board_id, position);`);
      db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq, ?) WHERE name='lanes'").run(lastLaneNumber);
      for (const row of db.prepare("SELECT number, data FROM boards").all()) {
        const board = JSON.parse(row.data);
        const lanes = db.prepare("SELECT number FROM lanes WHERE board_id=? ORDER BY position").all(board.id);
        if (!rejected.some((lane) => lane.board_id === board.id)) continue;
        lanes.forEach((lane, position) => db.prepare("UPDATE lanes SET position=? WHERE number=?").run(position, lane.number));
        board.version++;
        db.prepare("UPDATE boards SET data=? WHERE number=?").run(JSON.stringify(board), row.number);
      }
      db.prepare("INSERT INTO migrations VALUES(20)").run();
    }
    if (!db.prepare("SELECT version FROM migrations WHERE version=21").get()) {
      db.exec("CREATE TABLE IF NOT EXISTS task_history(task_number INTEGER NOT NULL, version INTEGER NOT NULL, actor TEXT NOT NULL, sequence INTEGER NOT NULL, created_at TEXT NOT NULL, before_data TEXT, fields TEXT NOT NULL, PRIMARY KEY(task_number,version)); CREATE TABLE IF NOT EXISTS milestones(number INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS label_colors(label TEXT PRIMARY KEY,color TEXT NOT NULL)");
      for (const row of db.prepare("SELECT number,data FROM boards").all()) {
        const board = JSON.parse(row.data);
        board.policy = { requireBriefForProgress: false, requireReviewArtifact: false, autoDispatch: false, humanCompletionOnly: true,completionMode:"any_agent",labelCompletionPolicies:{} };
        db.prepare("UPDATE boards SET data=? WHERE number=?").run(JSON.stringify(board),row.number);
      }
      const positions = new Map();
      for (const row of db.prepare("SELECT number,data FROM tasks ORDER BY number").all()) {
        const task = JSON.parse(row.data); const position = positions.get(task.lane) ?? 0;
        if(task.review)task.review.author=task.delegatedTo || task.review.actor;
        positions.set(task.lane,position+1);
        db.prepare("UPDATE tasks SET data=? WHERE number=?").run(JSON.stringify({branch:"",briefPath:"",resultPath:"",milestone:"",position,...task}),row.number);
      }
      for (const row of db.prepare("SELECT number,data FROM epics").all()) { const epic=JSON.parse(row.data);epic.completionPolicy="inherit";db.prepare("UPDATE epics SET data=? WHERE number=?").run(JSON.stringify(epic),row.number); }
      db.prepare("INSERT INTO migrations VALUES(21)").run();
    }
  });
  if (!db.prepare("PRAGMA table_info(actors)").all().some((column) => column.name === "role")) db.exec("ALTER TABLE actors ADD COLUMN role TEXT NOT NULL DEFAULT 'worker'");
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
  // Boards saved before repository folders existed read as having none.
  const parseBoard = (data) => ({ repository: "", ...JSON.parse(data) });
  const allBoards = () =>
    db
      .prepare("SELECT data FROM boards ORDER BY number")
      .all()
      .map((row) => parseBoard(row.data));
  const getBoard = (id) => {
    const number = Number(id.slice("BOARD-".length));
    const row = db.prepare("SELECT data FROM boards WHERE number=?").get(number);
    if (!row) fail("NOT_FOUND", "Board not found", 404);
    const board = parseBoard(row.data);
    if (board.id !== id) fail("NOT_FOUND", "Board not found", 404);
    return board;
  };
  const laneNumber = (id) => Number(id.slice("LANE-".length));
  const laneRecord = (row) => ({ id: `LANE-${row.number}`, name: row.name, role: row.role });
  /** A board's lanes in column order. */
  const lanesOf = (boardId) =>
    db
      .prepare("SELECT number, name, role FROM lanes WHERE board_id=? ORDER BY position")
      .all(boardId)
      .map(laneRecord);
  const getLane = (id) => {
    const row = db
      .prepare("SELECT number, board_id, name, role FROM lanes WHERE number=?")
      .get(laneNumber(id));
    if (!row) fail("NOT_FOUND", "Lane not found", 404);
    return { ...laneRecord(row), boardId: row.board_id };
  };
  /** The leftmost lane with a role. Every board has one. */
  const firstLane = (boardId, role) =>
    lanesOf(boardId).find((lane) => lane.role === role).id;
  const saveLaneOrder = (ids) => {
    const update = db.prepare("UPDATE lanes SET position=? WHERE number=?");
    ids.forEach((id, position) => update.run(position, laneNumber(id)));
  };
  /** The role of every lane, by lane ID. */
  const laneRoleMap = () =>
    new Map(
      db
        .prepare("SELECT number, role FROM lanes")
        .all()
        .map((row) => [`LANE-${row.number}`, row.role]),
    );
  const latestArchive = db.prepare("SELECT kind FROM events WHERE task_id=? AND kind IN ('archive_task','reject_task') ORDER BY sequence DESC LIMIT 1");
  const permalink = (query) => `${db.prepare("SELECT value FROM settings WHERE key='workspace_url'").get()?.value?.replace(/\/$/, "") ?? process.env.TASKNBOARD_SERVER_URL?.replace(/\/$/, "") ?? ""}/${query}`;
  const commentText=(body="")=>{if(body.startsWith("{")){try{return JSON.parse(body).body ?? body;}catch{}}return body;};
  /** A task with its lane role and current archive category. */
  const withRole = (t, roles = laneRoleMap()) => ({
    ...t,
    role: roles.get(t.lane),
    url: permalink(`?board=${t.boardId}&task=${t.id}`),
    position: t.position ?? 0,
    labelColors: Object.fromEntries(t.labels.flatMap((label) => { const row = db.prepare("SELECT color FROM label_colors WHERE label=?").get(label.toLowerCase()); return row ? [[label,row.color]] : []; })),
    lease: t.lease ? { ...t.lease, expiresInSeconds: Math.max(0, Math.ceil((t.lease.expiresAt - clock()) / 1000)) } : null,
    ...dependencies(t, roles),
    completionPolicy:completionPolicy(t),
    archiveCategory: t.archived
      ? (latestArchive.get(t.id)?.kind === "reject_task" ? "rejected" : "archived")
      : null,
  });
  const saveBoard = (board) =>
    db
      .prepare("UPDATE boards SET data=? WHERE number=?")
      .run(JSON.stringify(board), Number(board.id.slice("BOARD-".length)));
  /**
   * Records the prefix for the board, after checkBoardPrefix. Taking another
   * board's former prefix moves the reservation, which ends its redirect.
   */
  const reserveBoardPrefix = (prefix, boardId) =>
    db
      .prepare(
        "INSERT INTO board_prefixes(prefix, board_id) VALUES(?, ?) ON CONFLICT(prefix) DO UPDATE SET board_id=excluded.board_id",
      )
      .run(prefix, boardId);
  /**
   * Adds `formerPrefixes`, the retired prefixes whose task keys still resolve
   * on each board, `inSidebar`, the caller's own sidebar preference, `lanes`
   * with their `tasks` and `archivedTasks` counts, and `inProgress`, the
   * number of active tasks in lanes with role in_progress. Derived on every read.
   */
  const boardsFor = (identity, boards) => {
    const reservations = db
      .prepare("SELECT prefix, board_id FROM board_prefixes ORDER BY prefix")
      .all();
    const hidden = new Set(
      db
        .prepare("SELECT board_id FROM board_sidebar_hidden WHERE actor=?")
        .all(identity.id)
        .map((r) => r.board_id),
    );
    const inProgress = new Map(
      db
        .prepare(
          `SELECT json_extract(t.data, '$.boardId') AS board_id, COUNT(*) AS count FROM tasks t
 JOIN lanes l ON json_extract(t.data, '$.lane') = 'LANE-' || l.number
 WHERE l.role = 'in_progress' AND NOT coalesce(json_extract(t.data, '$.archived'), 0)
 GROUP BY board_id`,
        )
        .all()
        .map((r) => [r.board_id, r.count]),
    );
    const laneCounts = new Map(
      db
        .prepare(
          `SELECT json_extract(data, '$.lane') AS lane,
 SUM(NOT coalesce(json_extract(data, '$.archived'), 0)) AS tasks,
 SUM(coalesce(json_extract(data, '$.archived'), 0)) AS archived
 FROM tasks GROUP BY lane`,
        )
        .all()
        .map((r) => [r.lane, r]),
    );
    return boards.map((board) => ({
      ...board,
      formerPrefixes: reservations
        .filter((r) => r.board_id === board.id && r.prefix !== board.prefix)
        .map((r) => r.prefix),
      inSidebar: !hidden.has(board.id),
      lanes: lanesOf(board.id).map((lane) => ({
        ...lane,
        tasks: laneCounts.get(lane.id)?.tasks ?? 0,
        archivedTasks: laneCounts.get(lane.id)?.archived ?? 0,
      })),
      inProgress: inProgress.get(board.id) ?? 0,
      url: permalink(`?board=${board.id}`),
    }));
  };
  const taskKey = (board, n) => `${board.prefix}-${n}`;
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
  const completionPolicy = (task) => {
    const board = getBoard(task.boardId);
    const strictness = {human:5,any_agent_other_than_author:4,architect:3,auto_on_evidence:2,any_agent:1};
    const overrides = task.labels.map((label)=>label.toLowerCase()).filter((label) => Object.hasOwn(board.policy.labelCompletionPolicies,label)).sort((a,b) => strictness[board.policy.labelCompletionPolicies[b]]-strictness[board.policy.labelCompletionPolicies[a]] || a.localeCompare(b));
    if (overrides.length) return {mode:board.policy.labelCompletionPolicies[overrides[0]],source:`label:${overrides[0]}`};
    const epic = task.epic && findEpic(task.epic);
    if (epic && epic.completionPolicy !== "inherit") return {mode:epic.completionPolicy,source:`epic:${epic.id}`};
    return {mode:board.policy.humanCompletionOnly ? "human" : board.policy.completionMode,source:"board"};
  };
  const mayComplete = (task,identity,policy=completionPolicy(task)) => identity.kind === "human" ||
    policy.mode === "any_agent" ||
    (policy.mode === "architect" && identity.role === "architect") ||
    (policy.mode === "any_agent_other_than_author" && getLane(task.lane).role === "in_review" && Boolean(task.review?.author) && identity.id !== task.review.author);
  /** A prefix is free unless another board uses it now. Former prefixes are free. */
  const checkBoardPrefix = (prefix, exceptBoardId) => {
    const owner = db
      .prepare("SELECT board_id FROM board_prefixes WHERE prefix=?")
      .get(prefix);
    if (
      owner &&
      owner.board_id !== exceptBoardId &&
      getBoard(owner.board_id).prefix === prefix
    )
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
    return views.map((v) => ({ ...v, favorite: favorites.has(v.id),url:permalink(`?view=${v.id}`) }));
  };
  /**
   * Filters may name only existing epics and lanes. Archived epics stay valid.
   * Lanes of any board are valid, because views are workspace records.
   */
  const checkFilterRecords = (filters) =>
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
          : condition.field === "lane"
            ? { ...condition, values: condition.values.map((value) => getLane(value).id) }
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
      const nextId = `${prefix}-${Number(match[1])}`;
      if (previousId === nextId) continue;
      task.id = nextId;
      updateTask.run(JSON.stringify(task), row.number);
      rewrites.push([previousId, nextId]);
    }
    const updateEvent = db.prepare("UPDATE events SET task_id=? WHERE task_id=?");
    for (const [previousId, nextId] of rewrites)
      updateEvent.run(nextId, previousId);
  };
  transaction(() => {
    if (db.prepare("SELECT version FROM migrations WHERE version=15").get()) return;
    for (const board of allBoards()) renameBoardTaskKeys(board, board.prefix);
    db.prepare("INSERT INTO migrations VALUES(15)").run();
  });
  /** Lane role counts of non-archived tasks, per epic. Derived on every read. */
  const withCounts = (epics, tasks = all()) => {
    const roles = laneRoleMap();
    const counts = new Map(
      epics.map((e) => [e.id, Object.fromEntries(laneRoles.map((role) => [role, 0]))]),
    );
    for (const t of tasks)
      if (!t.archived && counts.has(t.epic)) counts.get(t.epic)[roles.get(t.lane)]++;
    return epics.map((e) => {
      const ids = tasks.filter((task) => task.epic === e.id).map((task) => task.id);
      const latest = ids.length ? db.prepare(`SELECT body,actor,created_at AS createdAt FROM events WHERE kind='add_comment' AND task_id IN (${ids.map(() => "?").join(",")}) ORDER BY sequence DESC LIMIT 1`).get(...ids) : null;
      const status=commentText(latest?.body);
      return { ...e, counts: counts.get(e.id), status, statusAt: latest?.createdAt ?? null, url: permalink(`?board=${e.boardId ?? ""}&epic=${e.id}`) };
    });
  };
  /** A task may join only an existing, active epic. Returns its current key. */
  const assignableEpic = (id, boardId) => {
    if (!id) return "";
    const epic = getEpic(id);
    if (epic.boardId && boardId && epic.boardId !== boardId) fail("VALIDATION", "epic: Choose an epic of this board", 400);
    if (epic.archived)
      fail("EPIC_ARCHIVED", `${epic.title} is archived; choose another epic`);
    return epic.id;
  };
  const humanOnly = (identity, action, subject = "epics") => {
    if (identity.kind !== "human" && identity.role !== "architect")
      fail("FORBIDDEN", `Only humans and architects may ${action} ${subject}`, 403);
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
    ...(row.role === "architect" ? { role: row.role } : {}),
    name: row.name,
    avatar: row.avatar,
    useGravatar: Boolean(row.use_gravatar),
    gravatarUrl: row.use_gravatar ? avatarUrl(row.gravatar_email) : "",
    ...(includeEmail ? { gravatarEmail: row.gravatar_email } : {}),
  });
  const actorRoster = () =>
    db
      .prepare(
        "SELECT id, kind, role, name, avatar, gravatar_email, use_gravatar FROM actors ORDER BY id",
      )
      .all()
      .map((row) => publicActor(row));
  const profileOf = (id) => {
    const row = db
      .prepare(
        "SELECT id, kind, role, name, avatar, gravatar_email, use_gravatar FROM actors WHERE id=?",
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
    db.prepare("UPDATE actors SET role=? WHERE id=? AND role<>?").run(actor.role, actor.id, actor.role);
  };
  const validActor = (actor) => {
    if (
      typeof actor?.id !== "string" ||
      actor.id.length === 0 ||
      !["human", "agent"].includes(actor.kind)
    )
      fail("UNAUTHORIZED", "Valid actor required", 401);
    if (actor.role !== undefined && !["architect", "worker"].includes(actor.role)) fail("UNAUTHORIZED", "Valid actor role required", 401);
    const stored = db.prepare("SELECT role FROM actors WHERE id=?").get(actor.id);
    return { id: actor.id, kind: actor.kind, role: actor.role ?? stored?.role ?? "worker" };
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
    if (!needsWrite) {
      for (const identity of identities) db.prepare("UPDATE actors SET role=? WHERE id=? AND role<>?").run(identity.role, identity.id, identity.role);
      return;
    }
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
  const taskNumber = (id) =>
    db.prepare("SELECT number FROM tasks WHERE json_extract(data, '$.id')=?").get(id)
      .number;
  /** The same link read from the other task's side. Rows store only the first three. */
  const inverseLink = {
    relates: "relates",
    blocks: "blocked_by",
    duplicates: "duplicated_by",
    blocked_by: "blocks",
    duplicated_by: "duplicates",
  };
  /** The one link between two tasks, in either direction. */
  const linkBetween = (a, b) =>
    db
      .prepare(
        "SELECT from_number, to_number, kind FROM task_links WHERE (from_number=? AND to_number=?) OR (from_number=? AND to_number=?)",
      )
      .get(a, b, b, a);
  const linksOf = (t) => {
    const number = taskNumber(t.id);
    return db
      .prepare(
        "SELECT l.from_number, l.kind, t.data FROM task_links l JOIN tasks t ON t.number = CASE WHEN l.from_number=? THEN l.to_number ELSE l.from_number END WHERE l.from_number=? OR l.to_number=?",
      )
      .all(number, number, number)
      .map((row) => {
        const other = JSON.parse(row.data);
        return {
          type: row.from_number === number ? row.kind : inverseLink[row.kind],
          id: other.id,
          title: other.title,
          lane: other.lane,
          role: getLane(other.lane).role,
          archived: other.archived,
        };
      })
      .sort(
        (a, b) =>
          linkTypes.indexOf(a.type) - linkTypes.indexOf(b.type) ||
          a.id.localeCompare(b.id, undefined, { numeric: true }),
      );
  };
  const dependencies = (t, roles = laneRoleMap()) => {
    const blockers = db.prepare("SELECT other.data FROM task_links l JOIN tasks self ON self.number=l.to_number JOIN tasks other ON other.number=l.from_number WHERE l.kind='blocks' AND json_extract(self.data,'$.id')=?").all(t.id).map((row) => JSON.parse(row.data))
      .filter((other) => !other.archived && !["in_review", "done"].includes(roles.get(other.lane)))
      .map((other) => ({ id: other.id, title: other.title, lane: other.lane, role: roles.get(other.lane), archived: false, type: "blocked_by" }));
    return { blocked: blockers.length > 0, blockers };
  };
  const finishEvidence = (task,identity) => {
    const effective=completionPolicy(task);
    if(task.archived || getLane(task.lane).role!=="in_review" || effective.mode!=="auto_on_evidence")return false;
    const artifactPresent=Boolean(task.review?.artifactUrl || task.review?.artifacts?.length);
    const merged=artifactPresent && areTaskCommitsOnDefaultBranch(getBoard(task.boardId).repository,task.commits ?? []);
    task.autoCompletion={eligible:merged,reason:merged ? "" : "Automatic completion requires an artifact and linked commits on the configured default branch"};
    if(!merged)return false;
    task.lane=firstLane(task.boardId,"done");task.lease=null;task.delegatedTo="";task.delegatedBy="";
    task.completion={actor:identity.id,humanCompletionOnly:getBoard(task.boardId).policy.humanCompletionOnly,approvedBy:"evidence",...effective,automatic:true};
    return true;
  };
  const undoInfo = (t, identity) => {
    const row = db.prepare("SELECT * FROM task_history WHERE task_number=? ORDER BY version DESC LIMIT 1").get(taskNumber(t.id));
    const creator=t.creator ?? db.prepare("SELECT actor FROM events WHERE task_id=? AND kind='created' ORDER BY sequence LIMIT 1").get(t.id)?.actor ?? null;
    const untouched = creator!==null && !db.prepare("SELECT sequence FROM events WHERE task_id=? AND actor<>? LIMIT 1").get(t.id, creator);
    const eligible = !!identity && creator === identity.id && row?.version === t.version && row.actor === identity.id && (clock() - Date.parse(row.created_at) <= 600000 || untouched);
    return { eligible, sequence: row?.sequence ?? null, reason: eligible ? "" : "Only the creator can undo their latest action within ten minutes or on an untouched task" };
  };
  const detail = (t, identity) => {
    const events = db
      .prepare(
        "SELECT sequence, actor, kind, body, created_at AS createdAt FROM events WHERE task_id=? ORDER BY sequence",
      )
      .all(t.id);
    return {
      ...withCommentCount(
        withRole(t),
        events.filter((event) => event.kind === "add_comment").length,
      ),
      links: linksOf(t),
      undo: undoInfo(t, identity),
      events,
    };
  };
  /**
   * The first `limit` items and the unread count of the actor's Inbox: comments
   * and review submissions by other actors that concern `identity`, newest
   * first, on non-archived tasks. Derived from events on every read. A review
   * reaches the task's creator and assignee; when neither is a known human, it
   * reaches every human, so no review goes unseen. The scan walks events from
   * the newest and stops once it has `limit` items and reaches read events.
   */
  const inbox = (identity, limit) => {
    const cursor =
      db.prepare("SELECT sequence FROM inbox_cursors WHERE actor=?").get(identity.id)
        ?.sequence ?? 0;
    const humans = new Set(
      db
        .prepare("SELECT id FROM actors WHERE kind='human'")
        .all()
        .map((row) => row.id),
    );
    const excerpt = (text) => {
      const flat = text.replace(/\s+/g, " ").trim();
      return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
    };
    const items = [];
    let unread = 0;
    // CROSS JOIN keeps events as the outer loop, in sequence order. The unary
    // + drops the column's affinity, so the tasks_by_id index applies.
    for (const row of db
      .prepare(
        `SELECT e.sequence, e.task_id, e.actor, e.kind, e.body, e.created_at,
 json_extract(t.data, '$.title') AS title, json_extract(t.data, '$.assignee') AS assignee,
 (SELECT c.actor FROM events c WHERE c.task_id=e.task_id AND c.kind='created' ORDER BY c.sequence LIMIT 1) AS creator
 FROM events e CROSS JOIN tasks t ON json_extract(t.data, '$.id')=+e.task_id
 WHERE e.kind IN ('add_comment','submit_review') AND e.actor<>?
 AND NOT coalesce(json_extract(t.data, '$.archived'), 0)
 ORDER BY e.sequence DESC`,
      )
      .iterate(identity.id)) {
      if (row.sequence <= cursor && items.length >= limit) break;
      const owners = [row.creator, row.assignee];
      const owns = owners.includes(identity.id);
      let reason = "";
      if (row.kind === "add_comment") {
        if (mentionedIdentities(row.body).includes(identity.id)) reason = "mention";
        else if (owns) reason = "comment";
      } else if (
        owns ||
        (humans.has(identity.id) && !owners.some((id) => humans.has(id)))
      )
        reason = "review";
      if (!reason) continue;
      if (row.sequence > cursor) unread++;
      if (items.length < limit)
        items.push({
          sequence: row.sequence,
          taskId: row.task_id,
          taskTitle: row.title,
          actor: row.actor,
          kind: row.kind,
          reason,
          excerpt: excerpt(
            row.kind === "submit_review" ? JSON.parse(row.body).summary : row.body,
          ),
          createdAt: row.created_at,
        });
    }
    return { items, unread, cursor };
  };
  const active = (t) => t.lease && t.lease.expiresAt > clock();
  const leaseFailure = (code, message, t) => {
    const now = clock();
    const expiresAt = t.lease?.expiresAt ?? null;
    const remainingMs = expiresAt === null ? 0 : expiresAt - now;
    const lease = { actor: t.lease?.actor ?? null, expiresAt, remainingMs, expiresInSeconds: Math.max(0, Math.ceil(remainingMs / 1000)), now, active: expiresAt !== null && remainingMs > 0 };
    const state = expiresAt === null
      ? `No lease exists; now=${now}`
      : `Lease holder=${lease.actor}; expiresAt=${expiresAt}; now=${now}; remainingMs=${remainingMs}`;
    fail(code, `${message}. ${state}`, 409, { lease });
  };
  /**
   * Stores image data embedded in any Markdown text of a command, so tasks,
   * comments and their history keep only /files/ links. If the command then
   * fails, the images it stored are removed again.
   */
  function execute(command, input, actor) {
    if (
      ["upload_image", "upload_artifact", "update_profile"].includes(command) ||
      !JSON.stringify(input ?? null).includes("data:image/")
    )
      return run(command, input, actor);
    const saved = new Map();
    const identity = validActor(actor);
    const rewrite = (value) =>
      typeof value === "string"
        ? storeEmbeddedImages(value, identity.id, saved, () =>
            fail("VALIDATION", "data: image content does not match its type", 400),
          )
        : Array.isArray(value)
          ? value.map(rewrite)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([k, v]) => [k, rewrite(v)]),
              )
            : value;
    try {
      return run(command, transaction(() => rewrite(input)), actor);
    } catch (e) {
      if (saved.size)
        transaction(() => {
          const remove = db.prepare("DELETE FROM images WHERE id=?");
          for (const id of saved.values()) remove.run(id);
        });
      throw e;
    }
  }
  function run(command, input, actor) {
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
    if(command === "keep_alive")return transaction(()=>{
      if(identity.kind !== "agent")fail("FORBIDDEN","Only agents can maintain their active claims",403);
      const renewed=[];
      for(const id of new Set(p.ids)){
        let task;
        try{task=get(id);}catch(error){if(error.code==="NOT_FOUND")continue;throw error;}
        const now=clock();
        if(task.archived || task.delegatedTo || !task.lease || task.lease.actor!==identity.id || !(task.lease.expiresAt>now) || task.lease.expiresAt-now>300000)continue;
        const expiresAt=now+900000;
        db.prepare("UPDATE tasks SET data=json_set(data,'$.lease.expiresAt',?) WHERE number=?").run(expiresAt,taskNumber(task.id));
        event(task.id,identity,"auto_heartbeat",JSON.stringify({previousExpiresAt:task.lease.expiresAt,expiresAt}));
        renewed.push({id:task.id,lease:{actor:identity.id,expiresAt,expiresInSeconds:900}});
      }
      return {renewed};
    });
    if (command === "critical_path") return readTransaction(() => {
      const goal = get(p.id); const tasks = new Map(); const edges = []; const cycles = [];
      const visit = (task, chain) => {
        if (chain.includes(task.id)) { cycles.push([...chain, task.id]); return; }
        if (tasks.has(task.id)) return;
        tasks.set(task.id, withRole(task));
        for (const blocker of dependencies(task).blockers) { edges.push({ from: blocker.id, to: task.id }); visit(get(blocker.id), [...chain, task.id]); }
      };
      visit(goal, []);
      return { goal: goal.id, tasks: [...tasks.values()], edges, cycles };
    });
    if (command === "list_activity") return readTransaction(() => {
      if (p.boardId) getBoard(p.boardId);
      const cutoff = new Date(clock() - p.hours * 3600000).toISOString();
      const events = db.prepare("SELECT e.sequence,e.task_id AS taskId,e.actor,e.kind,e.body,e.created_at AS createdAt,t.data FROM events e JOIN tasks t ON json_extract(t.data,'$.id')=e.task_id WHERE e.created_at>=? ORDER BY e.sequence DESC").all(cutoff)
        .filter((row) => (!p.boardId || JSON.parse(row.data).boardId === p.boardId) && (!p.agent || row.actor === p.agent)).slice(0,p.limit).map(({data,...row}) => ({...row,url:permalink(`?board=${JSON.parse(data).boardId}&task=${row.taskId}`)}));
      const running = all().filter((task) => !task.archived && task.delegatedTo && getLane(task.lane).role === "in_progress" && (!p.boardId || task.boardId === p.boardId) && (!p.agent || [task.delegatedTo,task.delegatedBy].includes(p.agent)))
        .map((task) => ({ ...withRole(task), elapsedSeconds: Math.max(0,Math.floor((clock()-Date.parse(task.delegatedAt ?? task.updatedAt))/1000)), lastActivityAt: db.prepare("SELECT created_at FROM events WHERE task_id=? AND kind IN ('heartbeat','add_comment') ORDER BY sequence DESC LIMIT 1").get(task.id)?.created_at ?? task.delegatedAt ?? task.updatedAt,
          lastActivity:db.prepare("SELECT kind,body,created_at AS createdAt FROM events WHERE task_id=? AND kind IN ('heartbeat','add_comment') ORDER BY sequence DESC LIMIT 1").get(task.id) ?? null,
          lastComment:commentText(db.prepare("SELECT body FROM events WHERE task_id=? AND kind='add_comment' ORDER BY sequence DESC LIMIT 1").get(task.id)?.body),
        }));
      return { events, running, hours:p.hours };
    });
    if (["list_milestones","create_milestone","update_milestone","archive_milestone"].includes(command)) return transaction(() => {
      const read = () => db.prepare("SELECT data FROM milestones ORDER BY number").all().map((row) => JSON.parse(row.data));
      const present = (milestone) => ({ ...milestone, url:permalink(`?board=${milestone.boardId}&milestone=${milestone.id}`) });
      if (command === "list_milestones") return { milestones: read().filter((milestone) => (p.includeArchived || !milestone.archived) && (!p.boardId || milestone.boardId === p.boardId)).map(present) };
      humanOnly(identity,"manage milestones");
      let milestone;
      const now = new Date(clock()).toISOString();
      if (command === "create_milestone") {
        getBoard(p.boardId);
        const inserted = db.prepare("INSERT INTO milestones(data) VALUES('{}')").run();
        milestone = { ...p,id:`MILESTONE-${inserted.lastInsertRowid}`,version:1,archived:false,createdAt:now,updatedAt:now };
      } else {
        milestone = read().find((milestone) => milestone.id === p.id);
        if (!milestone) fail("NOT_FOUND","Milestone not found",404);
        if (milestone.version !== p.expectedVersion) fail("VERSION_CONFLICT",`Milestone changed. Current version: ${milestone.version}`);
        if (milestone.archived) fail("ARCHIVED","Milestone is archived");
        Object.assign(milestone, p.patch ?? {archived:true}, {version:milestone.version+1,updatedAt:now});
      }
      db.prepare("UPDATE milestones SET data=? WHERE number=?").run(JSON.stringify(milestone),Number(milestone.id.split("-")[1]));
      event(milestone.id,identity,command,JSON.stringify(p));
      return present(milestone);
    });
    if (command === "set_label_color") return transaction(() => { humanOnly(identity,"set label colours"); db.prepare("INSERT INTO label_colors(label,color) VALUES(?,?) ON CONFLICT(label) DO UPDATE SET color=excluded.color").run(p.label.toLowerCase(),p.color); return { label:p.label,color:p.color }; });
    const batches = { claim_tasks: ["claim_task", "tasks"], add_comments: ["add_comment", "comments"], submit_reviews: ["submit_review", "reviews"] };
    if (batches[command]) return transaction(() => ({ tasks: p[batches[command][1]].map((args) => run(batches[command][0], args, identity)) }));
    if (command === "upload_artifact") {
      const [, mime, encoded] = p.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
      const bytes = Buffer.from(encoded,"base64");
      if (!bytes.length || bytes.length > 8 * 1024 * 1024 || (imageSignatures[mime] && !imageSignatures[mime](bytes))) fail("VALIDATION","Artifact bytes do not match the file type or size limit",400);
      if (mime === "application/json") { try { JSON.parse(bytes.toString("utf8")); } catch { fail("VALIDATION","Artifact contains invalid JSON",400); } }
      const artifactId = transaction(() => saveImage(mime,bytes,identity.id));
      return { id: artifactId, title: p.title, url: `/files/${artifactId}`, mime, bytes: bytes.length };
    }
    if (["bulk_create_tasks", "bulk_move_tasks"].includes(command)) return transaction(() => ({ tasks: p.tasks.map((task) => run(command === "bulk_create_tasks" ? "create_task" : "update_task", command === "bulk_create_tasks" ? task : { ...task, patch: { lane: p.lane } }, identity)) }));
    if (command === "list_boards")
      return readTransaction(() => ({ boards: boardsFor(identity, allBoards()) }));
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
          description: p.description,
          repository: p.repository,
          agentReasoning: p.agentReasoning,
          agentSandbox: p.agentSandbox,
          policy: p.policy,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        saveBoard(board);
        insertDefaultLanes(board.id);
        reserveBoardPrefix(board.prefix, board.id);
        event(board.id, identity, "created");
        return boardsFor(identity, [board])[0];
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
        if (p.patch.policy) p.patch.policy = { ...board.policy,...p.patch.policy };
        Object.assign(board, p.patch);
        board.version++;
        board.updatedAt = new Date(clock()).toISOString();
        if (board.prefix !== previousPrefix) {
          reserveBoardPrefix(board.prefix, board.id);
          renameBoardTaskKeys(board, board.prefix);
        }
        saveBoard(board);
        event(board.id, identity, "update_board", JSON.stringify(p.patch));
        return boardsFor(identity, [board])[0];
      });
    if (command === "set_board_sidebar")
      return transaction(() => {
        humanOnly(identity, "arrange", "the sidebar");
        const board = getBoard(p.id);
        // A personal preference: it neither versions the board nor logs an event.
        if (p.inSidebar)
          db.prepare(
            "DELETE FROM board_sidebar_hidden WHERE actor=? AND board_id=?",
          ).run(identity.id, board.id);
        else
          db.prepare(
            "INSERT OR IGNORE INTO board_sidebar_hidden(actor, board_id) VALUES(?,?)",
          ).run(identity.id, board.id);
        return boardsFor(identity, [board])[0];
      });
    if (["create_lane", "update_lane", "delete_lane"].includes(command))
      return transaction(() => {
        humanOnly(
          identity,
          { create_lane: "create", update_lane: "edit", delete_lane: "delete" }[command],
          "lanes",
        );
        const lane = command === "create_lane" ? null : getLane(p.id);
        const board = getBoard(lane?.boardId ?? p.boardId);
        if (board.version !== p.expectedVersion)
          fail(
            "VERSION_CONFLICT",
            `Board changed. Read it again. Current version: ${board.version}`,
          );
        const lanes = lanesOf(board.id);
        const order = lanes.map((l) => l.id).filter((id) => id !== lane?.id);
        const name = command === "create_lane" ? p.name : p.patch?.name;
        if (
          name !== undefined &&
          lanes.some((l) => l.id !== lane?.id && l.name.toLowerCase() === name.toLowerCase())
        )
          fail("VALIDATION", `name: ${board.name} already has a lane named ${name}`, 400);
        const now = new Date(clock()).toISOString();
        let body;
        if (command === "create_lane") {
          if (lanes.length >= laneLimit)
            fail("VALIDATION", `A board has at most ${laneLimit} lanes`, 400);
          const id = `LANE-${
            db
              .prepare("INSERT INTO lanes(board_id, position, name, role) VALUES(?,?,?,?)")
              .run(board.id, lanes.length, p.name, p.role).lastInsertRowid
          }`;
          order.splice(p.position ?? order.length, 0, id);
          body = { id, name: p.name, role: p.role };
        } else if (command === "update_lane") {
          if (p.patch.name !== undefined)
            db.prepare("UPDATE lanes SET name=? WHERE number=?").run(
              p.patch.name,
              laneNumber(lane.id),
            );
          order.splice(p.patch.position ?? lanes.findIndex((l) => l.id === lane.id), 0, lane.id);
          body = { id: lane.id, ...p.patch };
        } else {
          if (!lanes.some((l) => l.id !== lane.id && l.role === lane.role))
            fail(
              "LANE_REQUIRED",
              `${board.name} needs at least one ${lane.role} lane, so ${lane.name} cannot be deleted`,
            );
          const target = getLane(p.moveTo);
          if (target.boardId !== board.id || target.role !== lane.role)
            fail("VALIDATION", `moveTo: Choose another ${lane.role} lane of ${board.name}`, 400);
          // Moved tasks keep their role, so claims and the review gate stay
          // valid. Their versions advance so stale writes are caught.
          const moved = JSON.stringify({ from: lane.id, to: target.id });
          for (const t of all()) {
            if (t.lane !== lane.id) continue;
            t.lane = target.id;
            t.version++;
            t.updatedAt = now;
            save(t);
            event(t.id, identity, command, moved);
          }
          for (const v of allViews()) {
            if (!v.filters.conditions.some((c) => c.field === "lane" && c.values.includes(lane.id)))
              continue;
            v.filters.conditions = v.filters.conditions.map((c) =>
              c.field === "lane"
                ? { ...c, values: [...new Set(c.values.map((x) => (x === lane.id ? target.id : x)))] }
                : c,
            );
            v.version++;
            v.updatedAt = now;
            saveView(v);
            event(v.id, identity, command, moved);
          }
          db.prepare("DELETE FROM lanes WHERE number=?").run(laneNumber(lane.id));
          body = { id: lane.id, moveTo: target.id };
        }
        saveLaneOrder(order);
        board.version++;
        board.updatedAt = now;
        saveBoard(board);
        event(board.id, identity, command, JSON.stringify(body));
        return boardsFor(identity, [board])[0];
      });
    if (command === "workspace_info")
      return {
        name: "Studio",
        actor: profileOf(identity.id),
        actors: actorRoster(),
        leaseSeconds: 900,
        boards: boardsFor(identity, allBoards()),
        schemaVersion: 21,
      };
    if (command === "update_profile")
      return transaction(() => {
        if (p.agentId !== undefined) {
          if (identity.kind !== "human") fail("FORBIDDEN", "Only humans can change agent roles", 403);
          const target = profileOf(p.agentId);
          if (!target) fail("NOT_FOUND", "Agent not found", 404);
          if (target.kind !== "agent") fail("VALIDATION", "agentId: Choose an agent", 400);
          db.prepare("UPDATE actors SET role=? WHERE id=?").run(p.role, p.agentId);
          return profileOf(p.agentId);
        }
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
      const id = transaction(() => saveImage(mime, bytes, identity.id));
      return { id, url: `/files/${id}`, mime, bytes: bytes.length };
    }
    if (command === "list_tasks") {
      return readTransaction(() => {
        const view = p.view && visibleView(identity, p.view);
        if (p.boardId) getBoard(p.boardId);
        const epic =
          p.epic && p.epic !== "none" ? (findEpic(p.epic)?.id ?? p.epic) : p.epic;
        const q = p.query?.toLowerCase();
        const roles = laneRoleMap();
        const rows = all().map((t) => withRole(t, roles)).filter(
          (t) =>
            Boolean(t.archived) === p.archived &&
            (!q ||
              `${t.id} ${t.title} ${t.description}`
                .toLowerCase()
                .includes(q)) &&
            (!p.role || t.role === p.role) &&
            (!p.lane || t.lane === p.lane) &&
            (p.assignee === undefined || t.assignee === p.assignee) &&
            (p.owner === undefined || t.assignee === p.owner) &&
            (p.delegated === undefined || Boolean(t.delegatedTo) === p.delegated) &&
            (!p.label || t.labels.includes(p.label)) &&
            (!p.boardId || t.boardId === p.boardId) &&
            (!epic || (t.epic || "none") === epic) &&
            (!view || taskMatchesView(t, view.filters, identity.id)),
        );
        const page = rows.slice(p.offset, p.offset + p.limit);
        const counts = commentCounts(page.map((t) => t.id));
        return {
          tasks: page.map((t) => p.fields ? Object.fromEntries(p.fields.map((field) => [field,t[field]])) : p.compact ? { id: t.id, title: t.title, version: t.version, lane: t.lane, role: t.role, epic:t.epic, assignee: t.assignee, labels: t.labels, delegatedTo: t.delegatedTo ?? "", lease:t.lease } : { ...withCommentCount(t, counts.get(t.id) ?? 0),undo:undoInfo(t,identity) }),
          total: rows.length,
        };
      });
    }
    if (command === "get_task")
      return readTransaction(() => detail(get(p.id),identity));
    if (command === "find_similar_tasks")
      return readTransaction(() => {
        if (p.boardId) getBoard(p.boardId);
        const excluded = p.excludeId && get(p.excludeId).id;
        const score = similarityScorer(p.title, p.context);
        const roles = laneRoleMap();
        const tasks = all()
          .filter(
            (t) =>
              (p.includeArchived || !t.archived) &&
              (p.includeDone || roles.get(t.lane) !== "done") &&
              t.id !== excluded &&
              (!p.boardId || t.boardId === p.boardId),
          )
          .map((t) => ({
            id: t.id,
            title: t.title,
            lane: t.lane,
            role: roles.get(t.lane),
            score: score(t),
          }))
          .filter((t) => t.score > similarityThreshold)
          .sort((a, b) => b.score - a.score)
          .slice(0, p.limit);
        return {
          tasks: tasks.map((t) => ({ ...t, score: Math.round(t.score * 1000) / 1000 })),
        };
      });
    // Task references in Markdown read many tasks at once; missing IDs are left out.
    if (command === "get_tasks")
      return readTransaction(() => {
        const roles = laneRoleMap();
        return {
          tasks: p.ids.flatMap((id) => {
            const t = findTask(id) ?? findTask(renamedTaskKey(id));
            return t
              ? [
                  {
                    id: t.id,
                    title: t.title,
                    lane: t.lane,
                    role: roles.get(t.lane),
                    archived: Boolean(t.archived),
                    url:permalink(`?board=${t.boardId}&task=${t.id}`),
                    lease: t.lease ? { ...t.lease,expiresInSeconds:Math.max(0,Math.ceil((t.lease.expiresAt-clock())/1000)) } : null,
                  },
                ]
              : [];
          }),
        };
      });
    if (command === "list_notifications") return readTransaction(() => {
      const items = db.prepare(`SELECT e.sequence, e.task_id AS taskId, e.actor, e.kind, e.body, e.created_at AS createdAt, t.data
        FROM events e JOIN tasks t ON json_extract(t.data, '$.id')=e.task_id
        JOIN actors a ON a.id=e.actor
        WHERE e.sequence>? AND e.actor<>? AND e.kind IN ('add_comment','submit_review','request_changes','reject_task','update_task','delegate_task','archive_task','restore_task','link_commits','unblocked','dispatch_requested','auto_complete') ORDER BY e.sequence`)
        .all(p.after, identity.id).filter((row) => {
          const task = JSON.parse(row.data);
          const creator = task.creator ?? db.prepare("SELECT actor FROM events WHERE task_id=? AND kind='created' ORDER BY sequence LIMIT 1").get(task.id)?.actor;
          const prior = db.prepare("SELECT before_data FROM task_history WHERE sequence=?").get(row.sequence)?.before_data;
          const previous = prior ? JSON.parse(prior) : {};
          return identity.role === "architect" || [creator, task.assignee, task.delegatedBy, task.delegatedTo,previous.delegatedBy,previous.delegatedTo].includes(identity.id);
        }).slice(0, p.limit).map(({ data, ...row }) => ({...row,url:permalink(`?board=${JSON.parse(data).boardId}&task=${row.taskId}`)}));
      return { items, cursor: items.at(-1)?.sequence ?? p.after };
    });
    if (command === "list_inbox")
      return readTransaction(() => {
        const { items, unread } = inbox(identity, p.limit);
        return { items, unread };
      });
    if (command === "mark_inbox_read")
      return transaction(() => {
        // A personal read position: no task version and no event.
        const latest =
          db.prepare("SELECT MAX(sequence) AS sequence FROM events").get().sequence ?? 0;
        if (p.upTo > latest)
          fail("VALIDATION", `upTo: Latest event is ${latest}`, 400);
        db.prepare(
          "INSERT INTO inbox_cursors(actor, sequence) VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET sequence=MAX(sequence, excluded.sequence)",
        ).run(identity.id, p.upTo);
        const { cursor, unread } = inbox(identity, 0);
        return { sequence: cursor, unread };
      });
    if (command === "list_epics")
      return readTransaction(() => {
        if (p.boardId) getBoard(p.boardId);
        const tasks = all().filter((task) => !p.boardId || task.boardId === p.boardId);
        return {
          epics: withCounts(
            allEpics().filter((e) => (p.includeArchived || !e.archived) && (!p.boardId || e.boardId === p.boardId || (!e.boardId && tasks.some((task) => task.epic === e.id)))),
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
        const filters = checkFilterRecords(p.filters);
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
        if (p.patch.filters) p.patch.filters = checkFilterRecords(p.patch.filters);
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
    if (command === "list_labels")
      return readTransaction(() => {
        const counts = new Map();
        for (const t of all())
          if (!t.archived)
            for (const label of t.labels)
              counts.set(label, (counts.get(label) ?? 0) + 1);
        return {
          labels: [...counts]
            .map(([name, tasks]) => ({ name, tasks, color:db.prepare("SELECT color FROM label_colors WHERE label=?").get(name.toLowerCase())?.color ?? null }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
      });
    if (command === "rename_label")
      return transaction(() => {
        const swap = (values) => [
          ...new Set(values.flatMap((v) => (v.toLowerCase() !== p.from.toLowerCase() ? [v] : p.to ? [p.to] : []))),
        ];
        // A workspace-wide edit open to people and agents: active tasks change
        // whoever holds their claim, and advance their version so stale
        // drafts and leases are caught by the usual version check.
        let tasks = 0;
        for (const t of all()) {
          if (t.archived || !t.labels.some((label)=>label.toLowerCase()===p.from.toLowerCase())) continue;
          t.labels = swap(t.labels);
          t.version++;
          t.updatedAt = new Date(clock()).toISOString();
          save(t);
          event(t.id, identity, command, JSON.stringify({ from: p.from, to: p.to }));
          tasks++;
        }
        // Views follow a rename. A removed label stays in their filters,
        // so a view never silently widens to match more tasks.
        let views = 0;
        if (p.to)
          for (const v of allViews()) {
            if (
              !v.filters.conditions.some(
                (c) => c.field === "label" && c.values.some((label)=>label.toLowerCase()===p.from.toLowerCase()),
              )
            )
              continue;
            v.filters.conditions = v.filters.conditions.map((c) =>
              c.field === "label" ? { ...c, values: swap(c.values) } : c,
            );
            v.version++;
            v.updatedAt = new Date(clock()).toISOString();
            saveView(v);
            event(v.id, identity, command, JSON.stringify({ from: p.from, to: p.to }));
            views++;
          }
        const oldColor = db.prepare("SELECT color FROM label_colors WHERE label=?").get(p.from.toLowerCase());
        if (oldColor && p.to) db.prepare("INSERT OR IGNORE INTO label_colors(label,color) VALUES(?,?)").run(p.to.toLowerCase(),oldColor.color);
        const archivedLabelRemains=all().some((task) => task.labels.some((label)=>label.toLowerCase()===p.from.toLowerCase()));
        if (!archivedLabelRemains) db.prepare("DELETE FROM label_colors WHERE label=?").run(p.from.toLowerCase());
        const strictness={human:5,any_agent_other_than_author:4,architect:3,auto_on_evidence:2,any_agent:1};
        for (const board of allBoards()) {
          const policies=board.policy.labelCompletionPolicies;
          const from=p.from.toLowerCase(),to=p.to.toLowerCase();
          if (!Object.hasOwn(policies,from)) continue;
          const source=policies[from];if(!archivedLabelRemains)delete policies[from];
          if (to && (!Object.hasOwn(policies,to) || strictness[source]>strictness[policies[to]])) Object.defineProperty(policies,to,{value:source,enumerable:true,writable:true,configurable:true});
          board.version++;board.updatedAt=new Date(clock()).toISOString();saveBoard(board);
          event(board.id,identity,"rename_label",JSON.stringify({from:p.from,to:p.to}));
        }
        return { from: p.from, to: p.to, tasks, views };
      });
    if (command === "create_epic")
      return transaction(() => {
        humanOnly(identity, "create");
        if (p.boardId) getBoard(p.boardId);
        const result = db.prepare("INSERT INTO epics(data) VALUES('{}')").run();
        const now = new Date(clock()).toISOString();
        const epic = {
          id: `EPIC-${result.lastInsertRowid}`,
          completionPolicy:p.completionPolicy,
          title: p.title,
          boardId: p.boardId ?? "",
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
          const roles = laneRoleMap();
          const open = all().filter(
            (t) => !t.archived && t.epic === epic.id && roles.get(t.lane) !== "done",
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
        schemaVersion: 21,
        exportedAt: new Date(clock()).toISOString(),
        boards: allBoards().map((board) => ({ ...board, lanes: lanesOf(board.id) })),
        actors: actorRoster(),
        epics: allEpics(),
        views: allViews(),
        milestones: db.prepare("SELECT data FROM milestones ORDER BY number").all().map((row) => JSON.parse(row.data)),
        labelColors: Object.fromEntries(db.prepare("SELECT label,color FROM label_colors ORDER BY label").all().map((row) => [row.label,row.color])),
        taskHistory: db.prepare("SELECT * FROM task_history ORDER BY task_number,version").all(),
        viewFavorites: db
          .prepare("SELECT actor, view_id FROM view_favorites ORDER BY actor, view_id")
          .all()
          .map((row) => ({ actor: row.actor, viewId: row.view_id })),
        boardSidebarHidden: db
          .prepare(
            "SELECT actor, board_id FROM board_sidebar_hidden ORDER BY actor, board_id",
          )
          .all()
          .map((row) => ({ actor: row.actor, boardId: row.board_id })),
        boardPrefixReservations: db
          .prepare(
            "SELECT prefix, board_id AS boardId FROM board_prefixes ORDER BY prefix",
          )
          .all()
          .map(({ prefix, boardId }) => ({ prefix, boardId })),
        tasks: all(),
        taskLinks: db
          .prepare(
            "SELECT json_extract(f.data, '$.id') AS source, l.kind AS type, json_extract(t.data, '$.id') AS target FROM task_links l JOIN tasks f ON f.number=l.from_number JOIN tasks t ON t.number=l.to_number ORDER BY l.from_number, l.to_number",
          )
          .all()
          .map(({ source, type, target }) => ({ source, type, target })),
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
        const epic = assignableEpic(p.epic, board.id);
        const lane = p.lane ? getLane(p.lane) : null;
        if (lane && (lane.boardId !== board.id))
          fail("VALIDATION", `lane: Choose a lane of ${board.name}`, 400);
        const result = db.prepare("INSERT INTO tasks(data) VALUES('{}')").run();
        const now = new Date(clock()).toISOString();
        const { blockedBy, ...fields } = p;
        const t = {
          ...fields,
          epic,
          id: taskKey(board, nextNumber),
          lane: lane?.id ?? firstLane(board.id, "todo"),
          version: 1,
          createdAt: now,
          updatedAt: now,
          creator: identity.id,
          lease: null,
          delegatedTo: "",
          archived: false,
          position: all().filter((task) => task.boardId === board.id && task.lane === (lane?.id ?? firstLane(board.id,"todo"))).length,
        };
        if (getLane(t.lane).role === "in_progress" && board.policy.requireBriefForProgress && !t.briefPath)
          fail("POLICY_REQUIRED","Board policy requires a brief path before In progress");
        if (t.milestone) {
          const milestone = db.prepare("SELECT data FROM milestones WHERE number=?").get(Number(t.milestone.split("-")[1]));
          if (!milestone || JSON.parse(milestone.data).boardId !== t.boardId || JSON.parse(milestone.data).archived) fail("VALIDATION","milestone: Choose an active milestone of this board",400);
        }
        db.prepare("UPDATE tasks SET data=? WHERE number=?").run(
          JSON.stringify(t),
          result.lastInsertRowid,
        );
        for (const target of new Set(blockedBy)) {
          const blocker = get(target);
          if (blocker.archived) fail("ARCHIVED", `${blocker.id} is archived`);
          db.prepare("INSERT INTO task_links(from_number,to_number,kind) VALUES(?,?,?)").run(taskNumber(blocker.id), taskNumber(t.id), "blocks");
          event(blocker.id, identity, "link_task", JSON.stringify({ type: "blocks", target: t.id }));
        }
        event(t.id, identity, "created");
        db.prepare("INSERT INTO task_history(task_number,version,actor,sequence,created_at,before_data,fields) VALUES(?,?,?,?,?,?,?)").run(taskNumber(t.id),1,identity.id,db.prepare("SELECT MAX(sequence) AS sequence FROM events WHERE task_id=?").get(t.id).sequence,t.createdAt,null,JSON.stringify(Object.keys(t)));
        return detail(t,identity);
      }
      const t = get(p.id);
      const before = structuredClone(t);
      const beforeLinks = db.prepare("SELECT from_number,to_number,kind FROM task_links WHERE from_number=? OR to_number=?").all(taskNumber(t.id),taskNumber(t.id));
      const beforePositions = command === "reorder_task" ? all().filter((task) => task.lane === t.lane && !task.archived).map((task) => ({id:task.id,position:task.position ?? 0})) : null;
      let link;
      if (t.archived && !["restore_task","undo_task"].includes(command)) fail("ARCHIVED", "Task is archived");
      // An owned active claim is a read-only retry, even with a stale version.
      // All commands that change task data still require the current version.
      if (command === "claim_task" && active(t) && t.lease.actor === identity.id)
        return detail(t,identity);
      if ((command !== "add_comment" || p.expectedVersion !== undefined) && t.version !== p.expectedVersion)
        fail(
          "VERSION_CONFLICT",
          `Task changed. Read it again. Current version: ${t.version}`,
          409,
          (() => {
            const history = db.prepare("SELECT fields,sequence FROM task_history WHERE task_number=? AND version>? ORDER BY version").all(taskNumber(t.id),p.expectedVersion ?? 0);
            return { currentVersion:t.version, changedFields:[...new Set(history.flatMap((row) => JSON.parse(row.fields)))], events:history.length ? db.prepare("SELECT sequence,actor,kind,body,created_at AS createdAt FROM events WHERE task_id=? AND sequence>=? ORDER BY sequence").all(t.id,history[0].sequence) : [] };
          })(),
        );
      if (command === "undo_task") {
        if (!undoInfo(t,identity).eligible) fail("FORBIDDEN",undoInfo(t,identity).reason,403);
        const previous = db.prepare("SELECT before_data FROM task_history WHERE task_number=? ORDER BY version DESC LIMIT 1").get(taskNumber(t.id));
        const undone = db.prepare("SELECT sequence,kind,body FROM events WHERE sequence=?").get(undoInfo(t,identity).sequence);
        link = { undoneSequence:undone.sequence,kind:undone.kind };
        if (undone.kind === "add_comment") db.prepare("UPDATE events SET kind='comment_undone' WHERE sequence=?").run(undone.sequence);
        if (previous.before_data) {
          const old = JSON.parse(previous.before_data); const restoredLinks = old._links; const restoredPositions = old._positions; delete old._links; delete old._positions;
          for (const key of Object.keys(t)) delete t[key];
          Object.assign(t,old,{version:before.version});
          if (restoredLinks) {
            db.prepare("DELETE FROM task_links WHERE from_number=? OR to_number=?").run(taskNumber(t.id),taskNumber(t.id));
            for (const row of restoredLinks) db.prepare("INSERT INTO task_links(from_number,to_number,kind) VALUES(?,?,?)").run(row.from_number,row.to_number,row.kind);
          }
          for (const position of restoredPositions ?? []) {
            if (position.id === t.id) continue;
            const other = get(position.id); other.position = position.position; other.version++; other.updatedAt = new Date(clock()).toISOString(); save(other);
            event(other.id,identity,"undo_task",JSON.stringify({position:position.position,taskId:t.id}));
          }
        }
        else { t.archived = true; t.lease = null; t.delegatedTo = ""; t.delegatedBy = ""; }
      } else if (command === "restore_task") {
        const creator = t.creator ?? db.prepare("SELECT actor FROM events WHERE task_id=? AND kind='created' ORDER BY sequence LIMIT 1").get(t.id)?.actor;
        if (identity.kind !== "human" && identity.role !== "architect" && creator !== identity.id)
          fail("FORBIDDEN", "Workers can restore only tasks they created", 403);
        if (!t.archived) fail("INVALID_TRANSITION", "Only archived tasks can be restored");
        if(identity.kind === "agent" && identity.role !== "architect") {
          const lastArchive=db.prepare("SELECT actor,created_at FROM events WHERE task_id=? AND kind IN ('archive_task','reject_task') ORDER BY sequence DESC LIMIT 1").get(t.id);
          const untouched=!db.prepare("SELECT sequence FROM events WHERE task_id=? AND actor<>? LIMIT 1").get(t.id,identity.id);
          const recent=lastArchive && clock()-Date.parse(lastArchive.created_at)<=600000;
          if(lastArchive?.actor!==identity.id || (!recent&&!untouched))
            fail("FORBIDDEN","Workers can restore only their own archive within ten minutes or on a task nobody else touched",403);
        }
        t.archived = false;
        t.lease = null;
        t.delegatedTo = "";
        t.delegatedBy = "";
      } else if (command === "set_standup_notes" && identity.kind === "human") {
        // Presentation annotations do not change execution ownership or status.
        // They still advance the version so concurrent edits cannot be lost.
        t.standup = { highlight: p.highlight, blocker: p.blocker };
      } else if (command === "reject_task") {
        if (identity.kind !== "human" && identity.role !== "architect")
          fail("FORBIDDEN", "Human or architect access required", 403);
        t.archived = true;
        t.lease = null;
        t.delegatedTo = "";
        t.delegatedBy = "";
      } else if (command === "claim_task") {
        if (active(t))
          leaseFailure("LEASE_CONFLICT", `Task is claimed by ${t.lease.actor}`, t);
        const role = getLane(t.lane).role;
        if (!["todo", "in_progress"].includes(role))
          fail(
            "INVALID_TRANSITION",
            "Only tasks in a todo or in_progress lane can be claimed",
          );
        t.lease = { actor: identity.id, expiresAt: clock() + 900000 };
        if (role === "todo") t.lane = firstLane(t.boardId, "in_progress");
      } else if (command === "add_comment") {
        // Anyone may reply, claimed or not; the comment changes no task field.
      } else {
        const planner = identity.role === "architect";
        const effectivePolicy = completionPolicy(t);
        const completing = command === "update_task" && p.patch.lane && getLane(p.patch.lane).role === "done";
        if (completing && identity.kind === "agent" && effectivePolicy.mode === "auto_on_evidence")
          fail("POLICY_REQUIRED","Automatic completion requires submit_review with artifacts and commits on the default branch");
        if (completing && identity.kind === "agent" && !mayComplete(t,identity,effectivePolicy))
          fail("FORBIDDEN",`Completion policy ${effectivePolicy.mode} from ${effectivePolicy.source} does not permit this actor to complete the task`,403);
        const reviewApproval = completing && Object.keys(p.patch).length===1 && effectivePolicy.mode === "any_agent_other_than_author" && getLane(t.lane).role === "in_review" && mayComplete(t,identity,effectivePolicy);
        const creator = t.creator ?? db.prepare("SELECT actor FROM events WHERE task_id=? AND kind='created' ORDER BY sequence LIMIT 1").get(t.id)?.actor;
        const creatorArchive = command === "archive_task" && creator === identity.id;
        if (command === "archive_task" && identity.kind !== "human" && !planner && !creatorArchive)
          fail("FORBIDDEN", "Workers can archive only tasks they created", 403);
        const creatorEvidence = ["submit_review", "link_commits"].includes(command) && creator === identity.id;
        const delegatedAccess = ["submit_review","link_commits","update_task","reorder_task"].includes(command) && [t.delegatedTo,t.delegatedBy].includes(identity.id);
        const resumeLaneMove = command === "update_task" &&
          Object.keys(p.patch).length === 1 && p.patch.lane !== undefined &&
          !active(t) && t.lease?.actor === identity.id &&
          ["todo", "in_progress"].includes(getLane(t.lane).role);
        if (!planner && !creatorEvidence && !delegatedAccess && !reviewApproval && active(t) && t.lease.actor !== identity.id)
          leaseFailure("LEASE_CONFLICT", `Task is claimed by ${t.lease.actor}`, t);
        if (
          identity.kind === "agent" && !planner && !creatorEvidence && !delegatedAccess && !reviewApproval && !creatorArchive && !resumeLaneMove && command !== "delegate_task" &&
          (!active(t) || t.lease.actor !== identity.id)
        )
          leaseFailure("LEASE_REQUIRED", "Claim this task before changing it", t);
        if (command === "heartbeat" || command === "release_task") {
          if (!active(t) || (t.lease.actor !== identity.id && (command === "heartbeat" || !planner)))
            leaseFailure("LEASE_REQUIRED", command === "heartbeat"
              ? "An active owned claim is required"
              : "An active claim owned by you or architect access is required", t);
          if (command === "heartbeat") t.lease.expiresAt = clock() + 900000;
          else t.lease = null;
        }
        if (command === "update_task") {
          const target = p.patch.lane !== undefined ? getLane(p.patch.lane) : null;
          if (target && target.boardId !== t.boardId)
            fail("VALIDATION", "lane: Choose a lane of this task's board", 400);
          if (
            identity.kind === "agent" && !planner &&
            (p.patch.assignee !== undefined ||
              (target && !["todo", "in_progress", "done"].includes(target.role)))
          )
            fail(
              "FORBIDDEN",
              "Agents cannot reassign tasks; use submit_review for review",
              403,
            );
          if (
            identity.kind === "human" &&
            target?.role === "done" &&
            !["in_review", "done"].includes(getLane(t.lane).role)
          )
            fail(
              "INVALID_TRANSITION",
              "Tasks must be reviewed before completion",
            );
          if (p.patch.epic !== undefined) {
            const epic = p.patch.epic && getEpic(p.patch.epic).id;
            if (epic !== (t.epic ?? "")) assignableEpic(epic, t.boardId);
            p.patch.epic = epic;
          }
          if (resumeLaneMove) t.lease = { actor: identity.id, expiresAt: clock() + 900000 };
          Object.assign(t, p.patch);
          if (getLane(before.lane).role === "done" && target && target.role !== "done") t.completion=null;
          if (target?.role === "done") t.completion = { actor:identity.id,humanCompletionOnly:getBoard(t.boardId).policy.humanCompletionOnly,approvedBy:identity.kind === "human" ? "human" : "agent",...effectivePolicy,automatic:false };
          if (target?.role === "todo") t.lease = null;
          if (["in_review", "done"].includes(getLane(t.lane).role)) t.lease = null;
          if (getLane(t.lane).role === "done") { t.delegatedTo = ""; t.delegatedBy = ""; }
        }
        if (command === "set_standup_notes") {
          t.standup = { highlight: p.highlight, blocker: p.blocker };
        }
        if (command === "submit_review") {
          if (!["todo", "in_progress"].includes(getLane(t.lane).role))
            fail(
              "INVALID_TRANSITION",
              "Only tasks in an in_progress lane can be submitted",
            );
          t.lane = firstLane(t.boardId, "in_review");
          t.lease = null;
          if (getBoard(t.boardId).policy.requireReviewArtifact && !p.artifactUrl && !p.artifacts.length)
            fail("POLICY_REQUIRED","Board policy requires at least one review artifact");
          t.review = {
            summary: p.summary,
            artifactUrl: p.artifactUrl,
            actor: identity.id,
            author:t.delegatedTo || identity.id,
            artifacts:p.artifacts,
            commitRange:p.commitRange,
            verifiedBy:p.verifiedBy,
            ...(p.via ? {via:p.via} : {}),
          };
          finishEvidence(t,identity);
        }
        if (command === "delegate_task") {
          if (!["todo", "in_progress"].includes(getLane(t.lane).role)) fail("INVALID_TRANSITION", "Only open tasks can be delegated");
          t.delegatedTo = p.delegatedTo;
          t.delegatedBy = identity.id;
          t.delegatedAt = new Date(clock()).toISOString();
          t.lane = firstLane(t.boardId, "in_progress");
          t.lease = null;
        }
        if (command === "request_changes") {
          if (identity.kind !== "human" && !planner) fail("FORBIDDEN", "Human or architect access required", 403);
          if (getLane(t.lane).role !== "in_review") fail("INVALID_TRANSITION", "Only review tasks accept changes requests");
          t.lane = firstLane(t.boardId, "in_progress");
          t.lease = null;
          t.changeRequest = { reason: p.reason, actor: identity.id };
        }
        if (command === "link_commits") {
          t.commits = [...new Set([...(t.commits ?? []), ...p.commits.map((sha) => sha.toLowerCase())])];
          link = { commits: p.commits, ...(p.via ? {via:p.via} : {}) };
          if(finishEvidence(t,identity))link.completion=t.completion;
        }
        if (command === "link_task" || command === "unlink_task") {
          const other = get(p.target);
          if (other.id === t.id)
            fail("VALIDATION", "target: A task cannot link to itself", 400);
          const self = taskNumber(t.id);
          const otherNumber = taskNumber(other.id);
          const existing = linkBetween(self, otherNumber);
          if (command === "link_task") {
            if (other.archived) fail("ARCHIVED", `${other.id} is archived`);
            if (existing)
              fail(
                "LINK_EXISTS",
                `${t.id} and ${other.id} are already linked. Remove that link first.`,
              );
            // "A blocked_by B" is stored as "B blocks A".
            const reversed = p.type.endsWith("_by");
            db.prepare(
              "INSERT INTO task_links(from_number, to_number, kind) VALUES(?,?,?)",
            ).run(
              reversed ? otherNumber : self,
              reversed ? self : otherNumber,
              reversed ? inverseLink[p.type] : p.type,
            );
            link = { type: p.type, target: other.id };
          } else {
            if (!existing)
              fail("NOT_FOUND", `${t.id} is not linked to ${other.id}`, 404);
            db.prepare(
              "DELETE FROM task_links WHERE from_number=? AND to_number=?",
            ).run(existing.from_number, existing.to_number);
            link = {
              type:
                existing.from_number === self
                  ? existing.kind
                  : inverseLink[existing.kind],
              target: other.id,
            };
          }
          // The other task records the change but keeps its version.
          event(
            other.id,
            identity,
            command,
            JSON.stringify({ type: inverseLink[link.type], target: t.id }),
          );
        }
        if (command === "link_pull_requests" || command === "unlink_pull_request") {
          const linked = t.pullRequests ?? [];
          const same = (a) => (b) =>
            a.repository.toLowerCase() === b.repository.toLowerCase() &&
            a.number === b.number;
          if (command === "link_pull_requests") {
            const added = p.pullRequests.filter(
              (pr, i, list) =>
                !linked.some(same(pr)) && list.findIndex(same(pr)) === i,
            );
            if (!added.length)
              fail(
                "LINK_EXISTS",
                `${t.id} already links ${p.pullRequests.length === 1 ? "this pull request" : "these pull requests"}`,
              );
            if (linked.length + added.length > pullRequestLimit)
              fail(
                "VALIDATION",
                `pullRequests: A task links at most ${pullRequestLimit} pull requests`,
                400,
              );
            t.pullRequests = [...linked, ...added];
            link = { pullRequests: added.map((pr) => pr.url) };
          } else {
            const existing = linked.find(same(p.pullRequest));
            if (!existing)
              fail("NOT_FOUND", `${t.id} does not link ${p.pullRequest.url}`, 404);
            t.pullRequests = linked.filter((pr) => pr !== existing);
            link = { pullRequests: [existing.url] };
          }
        }
        if (command === "archive_task") {
          t.archived = true;
          t.lease = null;
          t.delegatedTo = "";
          t.delegatedBy = "";
        }
      }
      if (getLane(t.lane).role === "in_progress" && getBoard(t.boardId).policy.requireBriefForProgress && !t.briefPath)
        fail("POLICY_REQUIRED","Board policy requires a brief path before In progress");
      if (t.milestone && command === "update_task" && p.patch.milestone !== undefined) {
        const milestone = db.prepare("SELECT data FROM milestones WHERE number=?").get(Number(t.milestone.split("-")[1]));
        if (!milestone || JSON.parse(milestone.data).boardId !== t.boardId || JSON.parse(milestone.data).archived) fail("VALIDATION","milestone: Choose an active milestone of this board",400);
      }
      if (command === "reorder_task") {
        const siblings = all().filter((task) => !task.archived && task.lane === t.lane && task.id !== t.id).sort((a,b) => (a.position ?? 0)-(b.position ?? 0) || taskNumber(a.id)-taskNumber(b.id));
        const index = Math.min(p.position,siblings.length);
        siblings.splice(index,0,t);
        for (let position = 0; position < siblings.length; position++) {
          const other = siblings[position];
          if (other.id === t.id) { t.position = position; continue; }
          if (other.position === position) continue;
          const previousOther = structuredClone(other);
          other.position = position; other.version++; other.updatedAt = new Date(clock()).toISOString(); save(other);
          event(other.id,identity,"reorder_task",JSON.stringify({position}));
          db.prepare("INSERT INTO task_history(task_number,version,actor,sequence,created_at,before_data,fields) VALUES(?,?,?,?,?,?,?)").run(taskNumber(other.id),other.version,identity.id,db.prepare("SELECT MAX(sequence) AS sequence FROM events WHERE task_id=?").get(other.id).sequence,other.updatedAt,JSON.stringify(previousOther),JSON.stringify(["position"]));
        }
      }
      t.version++;
      t.updatedAt = new Date(clock()).toISOString();
      save(t);
      event(
        t.id,
        identity,
        command,
        (p.body && p.via ? JSON.stringify({body:p.body,via:p.via}) : p.body) ?? p.reason ?? (command === "delegate_task" ? JSON.stringify({ delegatedTo: p.delegatedTo,delegatedBy:identity.id }) : undefined) ??
          (command === "submit_review"
            ? JSON.stringify({...t.review,...(t.completion?.automatic ? {completion:t.completion} : {}),...(t.autoCompletion ? {autoCompletion:t.autoCompletion} : {})})
            : command === "set_standup_notes"
              ? JSON.stringify(t.standup)
              : command === "update_task"
                ? JSON.stringify({ ...p.patch, ...(p.patch.lane && getLane(p.patch.lane).role === "done" ? {completion:t.completion} : {}) })
                : link
                  ? JSON.stringify(link)
                  : ""),
      );
      const sequence = db.prepare("SELECT MAX(sequence) AS sequence FROM events WHERE task_id=?").get(t.id).sequence;
      const changed = Object.keys(t).filter((field) => JSON.stringify(t[field]) !== JSON.stringify(before[field]));
      db.prepare("INSERT INTO task_history(task_number,version,actor,sequence,created_at,before_data,fields) VALUES(?,?,?,?,?,?,?)").run(taskNumber(t.id),t.version,identity.id,sequence,t.updatedAt,JSON.stringify({...before,_links:beforeLinks,...(beforePositions ? {_positions:beforePositions} : {})}),JSON.stringify(changed.filter((field) => !["version","updatedAt"].includes(field))));
      if (!before.archived && !["in_review","done"].includes(getLane(before.lane).role) && (t.archived || ["in_review","done"].includes(getLane(t.lane).role))) {
        const dependents = db.prepare("SELECT other.data FROM task_links l JOIN tasks other ON other.number=l.to_number WHERE l.from_number=? AND l.kind='blocks'").all(taskNumber(t.id));
        for (const row of dependents) { const dependent = JSON.parse(row.data); if (!dependent.archived && !dependencies(dependent).blocked) event(dependent.id,identity,"unblocked",JSON.stringify({blocker:t.id})); }
      }
      return detail(t,identity);
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
  /** Setting keys that start with a prefix, such as every agent configuration. */
  const settingKeys = (prefix) =>
    db
      .prepare("SELECT key FROM settings WHERE substr(key, 1, ?) = ? ORDER BY key")
      .all(prefix.length, prefix)
      .map((row) => row.key);
  const setSettings = (values) =>
    transaction(() => {
      for (const [key, value] of Object.entries(values))
        if (value) db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
        else db.prepare("DELETE FROM settings WHERE key=?").run(key);
    });
  const versionQuery = db.prepare(
    "SELECT (SELECT data_version FROM pragma_data_version) AS other, total_changes() AS own",
  );
  /**
   * Changes when any connection commits to the database file. data_version
   * covers other connections; total_changes covers this one.
   */
  const dataVersion = () => {
    const { other, own } = versionQuery.get();
    return `${other}:${own}`;
  };
  /** Activity written by the service itself, such as an automatic agent start. */
  const recordEvent = (taskId, actor, kind, body = "") =>
    transaction(() => {
      const identity = validActor(actor);
      addActor(identity);
      event(get(taskId).id, identity, kind, body);
    });
  const completeEvidenceTasks = (boardIds,actor) => {
    const identity=validActor(actor);registerActors([identity]);const completed=[];
    for(const candidate of all().filter(task=>boardIds.has(task.boardId)&&!task.archived&&getLane(task.lane).role==="in_review"&&completionPolicy(task).mode==="auto_on_evidence"))transaction(()=>{
      const task=get(candidate.id),before=structuredClone(task);
      if(!finishEvidence(task,identity))return;
      task.version++;task.updatedAt=new Date(clock()).toISOString();save(task);
      event(task.id,identity,"auto_complete",JSON.stringify({completion:task.completion}));
      const sequence=db.prepare("SELECT MAX(sequence) AS sequence FROM events WHERE task_id=?").get(task.id).sequence;
      db.prepare("INSERT INTO task_history(task_number,version,actor,sequence,created_at,before_data,fields) VALUES(?,?,?,?,?,?,?)").run(taskNumber(task.id),task.version,identity.id,sequence,task.updatedAt,JSON.stringify(before),JSON.stringify(["lane","completion","lease","delegatedTo","delegatedBy"]));
      completed.push(detail(task,identity));
    });
    return completed;
  };
  return {
    execute,
    boards: allBoards,
    registerActors,
    recordEvent,
    completeEvidenceTasks,
    image,
    setting,
    settingKeys,
    setSettings,
    dataVersion,
    close: () => db.close(),
  };
}
