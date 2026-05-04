import type { SQSEvent } from "aws-lambda";
import { processTryOnJobMessage } from "../workers/tryOnWorker";

export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    await processTryOnJobMessage(JSON.parse(record.body));
  }
};
