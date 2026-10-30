// Liveness for deploy checks: no sign-in, and it touches the database, so "up" means the API can reach Postgres.
/** The commit this deployment was built from: set at deploy time (release.ps1 passes BUILD_SHA), else Vercel's own, else null (local runs). */
export const buildId = () => process.env.BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null;
export function register(r) {
  r.add('GET', '/api/health', async ({ pool }) => { await pool.query('SELECT 1'); return { ok: true, build: buildId() }; });
}
