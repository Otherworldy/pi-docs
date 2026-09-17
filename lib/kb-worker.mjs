import { Worker, isMainThread, parentPort, threadId } from "node:worker_threads";
import {
  decodeEntities,
  digestFileName,
  extractNoteTitle,
  parseShowDocReadme,
  pathKey,
  sha256,
} from "./source.mjs";

export const workerFileUrl = new URL("./kb-worker.mjs", import.meta.url);

const SOURCE_FNS = {
  decodeEntities,
  digestFileName,
  extractNoteTitle,
  parseShowDocReadme,
  pathKey,
  sha256,
};

export function createKbRuntime(options = {}) {
  const worker = new Worker(workerFileUrl, options);
  let seq = 0;
  const pending = new Map();
  const failAll = (err) => {
    for (const item of pending.values()) item.reject(err);
    pending.clear();
  };
  worker.on("message", (msg) => {
    const item = pending.get(msg?.id);
    if (!item) return;
    pending.delete(msg.id);
    if (msg.ok) item.resolve(msg);
    else item.reject(new Error(String(msg.error ?? "worker error")));
  });
  worker.on("error", failAll);
  worker.on("exit", (code) => {
    if (pending.size) failAll(new Error(`worker exit ${code}`));
  });
  return {
    worker,
    request(payload, transferList) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, ...payload }, transferList);
      });
    },
    close() {
      failAll(new Error("worker closed"));
      return worker.terminate();
    },
  };
}

async function handle(msg) {
  const id = msg?.id;
  try {
    if (msg?.op === "ping") {
      return { id, ok: true, node: process.version, threadId, pid: process.pid };
    }
    if (msg?.op === "source") {
      const fn = SOURCE_FNS[msg.fn];
      if (!fn) throw new Error(`unknown source fn: ${msg.fn}`);
      return { id, ok: true, result: fn(...(msg.args ?? [])) };
    }
    if (msg?.op === "indexRoot") {
      const { indexRoot } = await import("./collect.mjs");
      const result = await indexRoot(msg);
      return { id, ...result };
    }
    throw new Error(`unknown op: ${msg?.op}`);
  } catch (err) {
    return { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

if (!isMainThread && parentPort) {
  parentPort.on("message", async (msg) => {
    parentPort.postMessage(await handle(msg));
  });
}
