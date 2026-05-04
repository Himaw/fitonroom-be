import type { FastifyInstance } from "fastify";
import { getFitonBalance, getFitonLedger } from "./fitonService";

export async function registerFitonRoutes(app: FastifyInstance): Promise<void> {
  app.get("/fitons/balance", { preHandler: app.authenticate }, async (request) => {
    const availableBalance = await getFitonBalance(request.auth.userId);
    return { availableBalance };
  });

  app.get("/fitons/ledger", { preHandler: app.authenticate }, async (request) => {
    const ledger = await getFitonLedger(request.auth.userId);
    return { ledger };
  });
}
