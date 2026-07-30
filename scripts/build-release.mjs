import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm(".release", { recursive: true, force: true });
await mkdir(".release", { recursive: true });
await build({
  entryPoints: ["apps/server/src/index.ts"],
  outfile: ".release/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  external: ["@fastify/cookie", "@fastify/multipart", "@fastify/static", "better-sqlite3", "fastify", "open", "pino", "ws", "zod"],
});
