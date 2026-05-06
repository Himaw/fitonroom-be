import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { processTryOnJobMessage } from "./tryOnWorker";

interface RunOptions {
  queueUrl: string;
  client?: SQSClient;
  waitTimeSeconds?: number;
  maxMessages?: number;
}

export async function runOnce(opts: RunOptions): Promise<void> {
  const client = opts.client ?? new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });

  const received = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: opts.queueUrl,
      MaxNumberOfMessages: opts.maxMessages ?? 10,
      WaitTimeSeconds: opts.waitTimeSeconds ?? 20,
      VisibilityTimeout: 300
    })
  );

  const messages = received.Messages ?? [];
  for (const msg of messages) {
    if (!msg.Body || !msg.ReceiptHandle) continue;
    try {
      const parsed = JSON.parse(msg.Body);
      await processTryOnJobMessage(parsed);
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: opts.queueUrl,
          ReceiptHandle: msg.ReceiptHandle
        })
      );
    } catch (err) {
      console.error("worker.process_failed", { messageId: msg.MessageId, err });
      // Do NOT delete — let SQS visibility timeout return the message,
      // and the queue's redrive policy will eventually move it to the DLQ.
    }
  }
}

async function loop(): Promise<void> {
  // Import env lazily so the module can be loaded in test environments
  // without requiring all env vars to be set at module load time.
  const { env } = await import("../config/env");
  const queueUrl = env.SQS_TRY_ON_QUEUE_URL;
  while (true) {
    try {
      await runOnce({ queueUrl });
    } catch (err) {
      console.error("worker.loop_error", { err: err instanceof Error ? err.message : String(err) });
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

if (require.main === module) {
  loop().catch((err) => {
    console.error("worker.fatal", err);
    process.exit(1);
  });
}
