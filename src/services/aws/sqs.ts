import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { env } from "../../config/env";

export const sqsClient = new SQSClient({ region: env.AWS_REGION });

export async function enqueueTryOnJob(message: {
  jobId: string;
  userId: string;
  userPhotoId: string;
  productInputId: string;
}): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: env.SQS_TRY_ON_QUEUE_URL,
      MessageBody: JSON.stringify(message)
    })
  );
}
