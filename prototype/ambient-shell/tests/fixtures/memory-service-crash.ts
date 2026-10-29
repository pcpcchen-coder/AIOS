import { writeFileSync } from "node:fs";
import { harness, selectProfile } from "./memory-service.ts";

// M09 子程序：開同一個記憶資料夾，選定人物後說一句「記住…」，在指定的 store checkpoint 被 SIGKILL。
// 送進 store 的操作 ID 先同步寫到 opFile（父程序重啟後用它查回條）。
const [dir, keyHex, stage, opFile, profile] = process.argv.slice(2);
const h = harness({
  dir: dir!, key: Buffer.from(keyHex!, "hex"),
  clock: { now: Date.now() },
  store: { checkpoint: (point) => { if (point === stage) process.kill(process.pid, "SIGKILL"); } },
  wrap: (store) => ({
    read: () => store.read(),
    receipt: (id) => store.receipt(id),
    close: () => store.close(),
    commit: (operation, change) => { writeFileSync(opFile!, JSON.stringify({ operationId: operation.operationId })); return store.commit(operation, change); },
  }),
});
h.clock.now = Date.now();
await selectProfile(h, profile!);
await h.turn("記住我不喝咖啡");
await h.close();
