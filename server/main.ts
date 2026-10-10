import { startServer } from './server';

const port = Number(process.env.PORT ?? 8080);
const staticDir = process.env.STATIC_DIR ?? 'dist';
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const debug = process.env.CS_DEBUG === '1';

const server = await startServer({ port, staticDir, debug, allowedOrigins });

const shutdown = () => {
  console.log('[server] shutting down');
  void server.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
