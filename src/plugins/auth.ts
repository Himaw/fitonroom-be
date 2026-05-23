import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { jwtVerify, createRemoteJWKSet, decodeProtectedHeader, type JWTPayload } from "jose";
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

const JWKS = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorate("authenticate", async (request, _reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

    if (!token) {
      throw app.httpErrors.unauthorized("Missing bearer token");
    }

    let payload: SupabaseJwtPayload;
    try {
      const protectedHeader = decodeProtectedHeader(token);
      let verified;

      if (protectedHeader.alg === "HS256") {
        verified = await jwtVerify(token, new TextEncoder().encode(env.SUPABASE_JWT_SECRET));
      } else {
        verified = await jwtVerify(token, JWKS);
      }

      payload = verified.payload as SupabaseJwtPayload;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("JWT Verification error:", err);
      throw app.httpErrors.unauthorized(`Invalid bearer token: ${message}`);
    }

    if (!payload.sub) {
      throw app.httpErrors.unauthorized("JWT missing subject");
    }

    const appUser = await ensureAppUser({
      supabaseUserId: payload.sub,
      email: payload.email,
      displayName: payload.user_metadata?.full_name ?? payload.user_metadata?.name,
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
