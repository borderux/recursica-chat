// Fork: the running task turns of the workspace's agents, for the task card's
// working line and the board's working marker (lib/task-working.ts).
import { FastifyInstance } from "fastify";
import { requireWorkspace } from "../auth/session.js";
import { listTaskWork } from "../lib/task-working.js";

export default async function taskWorkingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tasks/working", { preHandler: requireWorkspace }, async (req) => ({
    working: await listTaskWork(req.auth!.workspaceId!),
  }));
}
