import { query } from "../db";

interface TryOnJobMessage {
  jobId: string;
  userId: string;
  userPhotoId: string;
  productInputId: string;
}

export async function processTryOnJobMessage(message: TryOnJobMessage): Promise<void> {
  await query(
    `update try_on_jobs
     set status = 'processing', updated_at = now()
     where id = $1 and user_id = $2`,
    [message.jobId, message.userId]
  );

  // TODO: download S3 source assets, call garment extraction / GenAI try-on provider,
  // write the generated image to S3 Results, create try_on_results, and send push.
  await query(
    `update try_on_jobs
     set status = 'failed',
         failure_reason = 'Worker integration placeholder: GenAI provider is not connected yet',
         updated_at = now()
     where id = $1 and user_id = $2`,
    [message.jobId, message.userId]
  );
}
