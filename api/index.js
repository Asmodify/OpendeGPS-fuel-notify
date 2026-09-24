// Vercel function: every /api/* request of the cloud version (vercel.json rewrites them here).
// The dashboard itself is served as static files from public/.
import { handler } from '../src/cloud/app.js';

export const config = { maxDuration: 60 };

export default handler;
