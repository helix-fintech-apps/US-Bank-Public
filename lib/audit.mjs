// The audit trail writer. Rows are append-only (database triggers); only the action name and a small detail are stored, never a secret.
import { clientIp } from './http.mjs';
import { ACTIONS } from './audit-actions.mjs';

export async function audit(c, req, userId, action, detail = null) {
  if (process.env.AUDIT_STRICT && !(action in ACTIONS)) throw new Error(`audit action "${action}" is not in lib/audit-actions.mjs`);
  await c.query('INSERT INTO audit_events (user_id, action, ip, user_agent, detail) VALUES ($1,$2,$3,$4,$5)',
    [userId, action, req ? clientIp(req) : null, req ? String(req.headers['user-agent'] ?? '').slice(0, 300) : null, detail]);
}
