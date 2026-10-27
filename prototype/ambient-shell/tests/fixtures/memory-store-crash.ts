import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MemoryStore, newStoreOperation, type MemoryStoreOptions } from "../../server/memory/store.ts";
const [dir, keyHex, stage, opJSON] = process.argv.slice(2);
const key = Buffer.from(keyHex!, "hex");
const secretBox = {
  available: () => true,
  seal(plain: string) { const nonce = randomBytes(12), c = createCipheriv("aes-256-gcm", key, nonce); return Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]); },
  open(sealed: Buffer) { const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12)); d.setAuthTag(sealed.subarray(-16)); return Buffer.concat([d.update(sealed.subarray(12, -16)), d.final()]).toString(); },
};
const store = await MemoryStore.open({ dir: dir!, secretBox, checkpoint: point => { if (point === stage) process.kill(process.pid, "SIGKILL"); } } satisfies MemoryStoreOptions);
const op = opJSON ? JSON.parse(opJSON) : newStoreOperation(1, "forget");
await store.commit(op, data => { data.facts = []; data.tombstones.push({ id: "fact-a", revision: 2 }); return "forgotten"; });
await store.close();
