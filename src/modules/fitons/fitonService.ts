import type { PoolClient } from "pg";
import { query, withTransaction } from "../../db";

export async function getFitonBalance(userId: string): Promise<number> {
  const result = await query<{ available_balance: number }>(
    `select available_balance from fiton_accounts where user_id = $1`,
    [userId]
  );
  return result.rows[0]?.available_balance ?? 0;
}

export async function getFitonLedger(userId: string): Promise<unknown[]> {
  const result = await query(
    `select id, entry_type, amount, balance_after, source, reference_id, expires_at, created_at
     from fiton_ledger_entries
     where user_id = $1
     order by created_at desc
     limit 100`,
    [userId]
  );
  return result.rows;
}

export async function debitFitonsForJob(input: {
  userId: string;
  amount: number;
  jobId: string;
  client?: PoolClient;
}): Promise<number> {
  const run = async (client: PoolClient) => {
    const account = await client.query<{ available_balance: number }>(
      `select available_balance
       from fiton_accounts
       where user_id = $1
       for update`,
      [input.userId]
    );

    const current = account.rows[0]?.available_balance ?? 0;
    if (current < input.amount) {
      throw new Error("INSUFFICIENT_FITONS");
    }

    const next = current - input.amount;
    await client.query(
      `update fiton_accounts
       set available_balance = $2, updated_at = now()
       where user_id = $1`,
      [input.userId, next]
    );

    await client.query(
      `insert into fiton_ledger_entries
        (user_id, entry_type, amount, balance_after, source, reference_id)
       values ($1, 'debit', $2, $3, 'try_on_job', $4)`,
      [input.userId, -input.amount, next, input.jobId]
    );

    return next;
  };

  if (input.client) return run(input.client);
  return withTransaction(run);
}
