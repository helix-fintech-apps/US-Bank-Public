// The whole API is this one Vercel function (Hobby allows 12). vercel.json rewrites /api/* here.
import { createApp } from '../lib/app.mjs';
import { sharedPool } from '../lib/db.mjs';

const app = createApp({ pool: sharedPool });
export default function handler(req, res) { return app(req, res); }
