# @void/deploy-vercel

Vercel Build Output API primitives used by [Void](https://void.cloud). Turns a Void build into `.vercel/output`: static files for Vercel's CDN, routes for Vercel's router, and one Node.js function for everything else.

To build a Void app for Vercel, set `target: 'vercel'` in `void.config.ts` and run `vite build`.

## Documentation

See the [Vercel guide](https://void.cloud/integrations/vercel) for setup and deployment.

Read the [Void documentation](https://void.cloud) online or use the Markdown guides and references in `node_modules/void/docs/`, included with the `void` package.
