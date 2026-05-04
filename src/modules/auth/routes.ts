import type { FastifyInstance } from "fastify";
import { getAppUser } from "../users/userRepo";

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/me", { preHandler: app.authenticate }, async (request) => {
    const user = await getAppUser(request.auth.userId);
    return {
      user,
      auth: {
        supabaseUserId: request.auth.supabaseUserId,
        email: request.auth.email
      }
    };
  });

  app.post("/auth/session-sync", { preHandler: app.authenticate }, async (request) => {
    const user = await getAppUser(request.auth.userId);
    return { user };
  });
}
