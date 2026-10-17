import assert from "node:assert/strict";
import { test } from "node:test";
import { Mutex } from "../../src/mutex.js";

test("mutex runs critical sections one at a time", async () => {
  const mutex = new Mutex();
  const order: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = mutex.run(async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  const second = mutex.run(async () => {
    order.push("second");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});
