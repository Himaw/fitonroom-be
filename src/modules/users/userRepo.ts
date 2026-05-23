import type { PoolClient } from "pg";
import { query, withTransaction } from "../../db";

export interface AppUser {
  id: string;
  supabase_user_id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

export interface ProfileSummary {
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  tokensRemaining: number;
  completedFitons: number;
}

interface ProfileSummaryRow {
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  tokens_remaining: number | string | null;
  completed_fitons: number | string | null;
}

export interface AuthProfileInput {
  supabaseUserId: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
}

export async function ensureAppUser(input: AuthProfileInput): Promise<AppUser> {
  return withTransaction(async (client) => {
    const user = await upsertAppUser(client, input);
    await client.query(
      `insert into fiton_accounts (user_id, available_balance)
       values ($1, 0)
       on conflict (user_id) do nothing`,
      [user.id]
    );
    await grantInitialTrialIfNeeded(client, user.id);
    return user;
  });
}

async function upsertAppUser(client: PoolClient, input: AuthProfileInput): Promise<AppUser> {
  const result = await client.query<AppUser>(
    `insert into app_users (supabase_user_id, email, display_name, avatar_url, last_seen_at)
     values ($1, $2, $3, $4, now())
     on conflict (supabase_user_id)
     do update set
       email = coalesce(excluded.email, app_users.email),
       display_name = coalesce(excluded.display_name, app_users.display_name),
       avatar_url = coalesce(excluded.avatar_url, app_users.avatar_url),
       last_seen_at = now()
     returning id, supabase_user_id, email, display_name, avatar_url`,
    [input.supabaseUserId, input.email ?? null, input.displayName ?? null, input.avatarUrl ?? null]
  );
  return result.rows[0];
}

async function grantInitialTrialIfNeeded(client: PoolClient, userId: string): Promise<void> {
  const account = await client.query<{ available_balance: number }>(
    `select available_balance from fiton_accounts where user_id = $1 for update`,
    [userId]
  );

  const existing = await client.query(
    `select id from fiton_ledger_entries
     where user_id = $1 and source = 'initial_trial'
     limit 1`,
    [userId]
  );

  if ((existing.rowCount ?? 0) > 0) return;

  const currentBalance = account.rows[0]?.available_balance ?? 0;
  const nextBalance = currentBalance + 5;

  await client.query(
    `update fiton_accounts
     set available_balance = $2, updated_at = now()
     where user_id = $1`,
    [userId, nextBalance]
  );

  await client.query(
    `insert into fiton_ledger_entries
      (user_id, entry_type, amount, balance_after, source, reference_id)
     values ($1, 'grant', 5, $2, 'initial_trial', 'initial_trial')`,
    [userId, nextBalance]
  );
}

export async function getAppUser(userId: string): Promise<AppUser | null> {
  const result = await query<AppUser>(
    `select id, supabase_user_id, email, display_name, avatar_url
     from app_users
     where id = $1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

export async function getProfileSummary(userId: string): Promise<ProfileSummary | null> {
  const result = await query<ProfileSummaryRow>(
    `select
       u.email,
       u.display_name,
       u.avatar_url,
       coalesce(fa.available_balance, 0)::int as tokens_remaining,
       count(tor.id)::int as completed_fitons
     from app_users u
     left join fiton_accounts fa on fa.user_id = u.id
     left join try_on_results tor on tor.user_id = u.id and tor.deleted_at is null
     where u.id = $1
     group by u.id, fa.available_balance`,
    [userId]
  );

  const row = result.rows[0];
  if (!row) return null;

  const fallbackName = row.email?.split("@")[0] ?? "Fiton Room user";

  return {
    displayName: row.display_name || fallbackName,
    email: row.email,
    avatarUrl: row.avatar_url,
    tokensRemaining: Number(row.tokens_remaining ?? 0),
    completedFitons: Number(row.completed_fitons ?? 0)
  };
}
