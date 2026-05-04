import "fastify";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: import("fastify").preHandlerHookHandler;
  }

  interface FastifyRequest {
    auth: {
      userId: string;
      supabaseUserId: string;
      email?: string;
    };
  }
}
