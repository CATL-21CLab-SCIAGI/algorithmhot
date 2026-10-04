import { Worker } from "node:worker_threads";
import type { BoardInput, BoardOutput } from "./v15.ts";

export interface ComputedBoards {
  outputs: BoardOutput[];
  timings: Array<{ board: string; models: number; optimal: boolean; ms: number }>;
}

/** Keep the synchronous HiGHS solver off the queue/heartbeat event loop. Boards still run in their
 * original order, with the exact v15 inputs, solver limits and tie policy, in one bounded worker. */
export function computeBoardsInWorker(boards: BoardInput[]): Promise<ComputedBoards> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./compute-worker.ts", import.meta.url), { workerData: boards });
    let result: ComputedBoards | undefined;
    worker.once("message", (value: ComputedBoards) => { result = value; });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Leaderboard computation worker exited with code ${code}`));
      else if (!result) reject(new Error("Leaderboard computation worker exited without a result"));
      else resolve(result);
    });
  });
}
