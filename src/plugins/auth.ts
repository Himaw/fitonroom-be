import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { jwtVerify, type JWTPayload } from "jose";
import { env } from "../config/env";
import { ensureAppUser } from "../modules/users/userRepo";

interface SupabaseJwtPayload extends JWTPayload {
  email?: string;
  user_metadata?: {
    name?: string;
    full_name?: string;
    avatar_url?: string;
  };
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorate("authenticate", async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

    if (!token) {
      throw app.httpErrors.unauthorized("Missing bearer token");
    }

    let payload: SupabaseJwtPayload;
    try {
      const verified = await jwtVerify(
        token,
        new TextEncoder().encode(env.SUPABASE_JWT_SECRET)
      );
      payload = verified.payload as SupabaseJwtPayload;
    } catch {
      throw app.httpErrors.unauthorized("Invalid bearer token");
    }

    if (!payload.sub) {
      throw app.httpErrors.unauthorized("JWT missing subject");
    }

    const appUser = await ensureAppUser({
      supabaseUserId: payload.sub,
      email: payload.email,
      displayName:
        payload.user_metadata?.full_name ?? payload.user_metadata?.name,
      avatarUrl: payload.user_metadata?.avatar_url
    });

    request.auth = {
      userId: appUser.id,
      supabaseUserId: appUser.supabase_user_id,
      email: appUser.email ?? undefined
    };
  });
};

export default fp(authPlugin, { name: "auth-plugin" });
