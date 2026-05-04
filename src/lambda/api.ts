import awsLambdaFastify from "@fastify/aws-lambda";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { buildApp } from "../app";

type ApiGatewayProxy = (
  event: APIGatewayProxyEventV2,
  context: Context
) => Promise<unknown>;

let proxy: ApiGatewayProxy | undefined;

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context
) => {
  if (!proxy) {
    const app = await buildApp();
    await app.ready();
    proxy = awsLambdaFastify(app) as ApiGatewayProxy;
  }

  return proxy(event, context);
};
