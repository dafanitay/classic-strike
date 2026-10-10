// Dev-only: lets `node server/main.ts` import extensionless .ts modules by
// bundling on the fly with esbuild. Production uses the prebuilt bundle.
import { register } from 'node:module';
register(new URL('./ts-loader.mjs', import.meta.url));
