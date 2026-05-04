import { buildApp } from "./app";
import { env } from "./config/env";

async function main(): Promise<void> {
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
