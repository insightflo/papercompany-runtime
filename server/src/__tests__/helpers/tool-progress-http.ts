import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Db } from "@paperclipai/db";
import { toolDefinitionRoutes } from "../../routes/tool-definitions.js";
import { errorHandler } from "../../middleware/error-handler.js";

export function httpFixtures() {
  const servers: Server[] = [];
  async function listen(app: express.Express) {
    const server = createServer(app); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function callback(db: Db) {
    const app = express();
    app.use(express.json({ verify: (req, _res, rawBody) => Object.assign(req, { rawBody }) }));
    app.use("/api", toolDefinitionRoutes(db));
    app.use(errorHandler);
    return listen(app);
  }
  async function close() {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  return { listen, callback, close };
}
