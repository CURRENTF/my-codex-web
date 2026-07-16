import open from "open";
import { config } from "./config.js";
import { createServer } from "./server.js";

const server = await createServer();
await server.app.listen({ host: config.host, port: config.port });
server.app.log.info({ url: `http://${config.host}:${config.port}`, codexHome: config.codexHome }, "Codex Web ready");
if (config.openBrowser) await open(`http://${config.host}:${config.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
