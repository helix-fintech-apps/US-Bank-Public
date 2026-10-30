// Who may see or use an account. Every route that takes an account id goes through here.
import { AppError, isUuid } from './http.mjs';

export const VIEW = ['owner', 'joint_owner', 'custodian', 'minor', 'viewer'];
export const MOVE_MONEY = ['owner', 'joint_owner', 'custodian'];   // a minor's own spending is governed by controls (M5)

/** The account and the caller's role on it, or a 404 (never a 403: don't confirm the account exists). */
export async function accountFor(c, userId, accountId, roles = VIEW) {
  if (!isUuid(accountId)) throw new AppError(404, 'not_found', 'Account not found.');
  const a = (await c.query(`SELECT a.*, o.role FROM accounts a JOIN account_owners o ON o.account_id = a.id
     WHERE a.id = $1 AND o.user_id = $2 AND a.kind <> 'system'`, [accountId, userId])).rows[0];
  if (!a || !roles.includes(a.role)) throw new AppError(404, 'not_found', 'Account not found.');
  return a;
}
