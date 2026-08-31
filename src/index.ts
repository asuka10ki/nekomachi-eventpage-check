import { loadEnv } from "./config.js";
import { runApplication } from "./run/orchestrator.js";

async function main(): Promise<void> {
  const outcome = await runApplication(loadEnv());
  process.exitCode = outcome.exitCode;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
