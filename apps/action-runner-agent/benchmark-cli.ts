import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { runWorkerBenchmark, type BenchmarkReport } from "./benchmark.js";
import { config } from "./config.js";

const reportBenchmark = makeFunctionReference<
  "mutation",
  { token: string; report: BenchmarkReport },
  {
    maxSlots: number;
    recommendedSlots: number;
    scores: { cpu: number; memory: number; disk: number; network: number; balanced: number };
  }
>("workerApi:reportBenchmark");

const client = new ConvexClient(config.convexUrl);
try {
  console.log("Benchmarking CPU, memory, local disk, GitHub, GHCR, and npm…");
  const report = await runWorkerBenchmark();
  const result = await client.mutation(reportBenchmark, {
    token: config.machineToken,
    report,
  });
  console.log(
    `Scores: balanced ${result.scores.balanced}, CPU ${result.scores.cpu}, ` +
      `memory ${result.scores.memory}, I/O ${result.scores.disk}, network ${result.scores.network}`,
  );
  console.log(
    `Capacity: ${result.maxSlots} effective slot(s), ${result.recommendedSlots} recommended`,
  );
  if (report.errors.length > 0) {
    console.warn(`Partial observations: ${report.errors.join("; ")}`);
  }
} finally {
  await client.close();
}
