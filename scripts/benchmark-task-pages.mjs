import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../server/store.mjs";

const directory = mkdtempSync(join(tmpdir(), "tasknboard-pages-"));
const actor = { id: "benchmark", kind: "human" };
try {
  for (const count of [1_000, 10_000]) {
    const path = join(directory, `workspace-${count}.sqlite`);
    let store = createStore(path);
    const task = store.execute("create_task", { boardId: "BOARD-1", title: "Benchmark task" }, actor);
    store.close();
    const db = new DatabaseSync(path);
    db.exec("BEGIN");
    const seed = JSON.parse(db.prepare("SELECT data FROM tasks").get().data);
    const insert = db.prepare("INSERT INTO tasks(data) VALUES(?)");
    for (let i = 2; i <= count; i++) {
      insert.run(JSON.stringify({ ...seed, id: `TNB-${i}`, title: `Benchmark task ${i}` }));
    }
    db.exec("COMMIT");
    db.close();

    store = createStore(path);
    try {
      const samples = [];
      for (let iteration = 0; iteration < 4; iteration++) {
        const start = performance.now();
        for (let offset = 0; offset < count; offset += 100) {
          const page = store.execute("list_tasks", { boardId: task.boardId, offset }, actor);
          if (page.total !== count || page.tasks.length !== 100) throw new Error("Wrong page");
        }
        if (iteration) samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      console.log(`${count} tasks, ${count / 100} pages: ${samples[1].toFixed(1)} ms median`);
    } finally {
      store.close();
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
