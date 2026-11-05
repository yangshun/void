---
outline: deep
---

# Vercel

Set `target: "vercel"` to deploy a Void app on [Vercel](https://vercel.com). The build writes Vercel's [Build Output](https://vercel.com/docs/build-output-api): static files for Vercel's CDN, your redirects and headers as Vercel routes, and one Node.js function for routes, pages, and middleware.

```ts
// void.config.ts
import { defineConfig } from 'void/config';

export default defineConfig({
  target: 'vercel',
});
```

## Getting Started

### 1. Configure the target

Set `target: "vercel"` in `void.config.ts`. Optionally choose where and how long the function runs:

```ts
export default defineConfig({
  target: 'vercel',
  vercel: { regions: ['iad1'], maxDuration: 60 },
});
```

See [`vercel`](../reference/config.md#vercel) for every setting. Add `.vercel` to `.gitignore`.

### 2. Develop

```bash
npx vite dev
```

### 3. Build

```bash
npx vite build
```

The build writes `dist/` and `.vercel/output/`. Vercel deploys `.vercel/output`; you don't need to set an output directory.

### 4. Deploy

Import your repository in Vercel. Vercel runs your build command and deploys `.vercel/output`.

To deploy from your machine or CI instead, build first and upload the result:

```bash
npx vite build
npx vercel deploy --prebuilt
```

This creates a preview deployment. Add `--prod` to deploy to production.

`void deploy` deploys to Cloudflare and Void platforms only.

## What Works

These Void features work on Vercel:

- [File-based routing](../guide/server-routing.md) (`routes/`, `middleware/`)
- [Pages mode](../guide/pages-routing/overview.md) with SSR (React, Vue, Svelte, Solid)
- [Typed fetch client](../guide/typed-fetch.md) (`void/client`)
- [Headers](../guide/edge/headers.md), [redirects](../guide/edge/redirects.md), and [rewrites](../guide/edge/rewrites.md)
- [Static site generation](../guide/ssg.md)
- [Cron jobs](../guide/jobs.md), as Vercel Cron Jobs
- `c.executionCtx.waitUntil()`, which keeps the function running for work after the response

## Static Files

Vercel's CDN serves your build's static files before the function runs: hashed JavaScript and CSS, files from `public/`, and prerendered pages.

- Middleware and routes don't run for static files. A file in `public/` takes the place of a route or page with the same path.
- Hashed files are cached forever. Other files follow your [header rules](../guide/edge/headers.md).
- HTML files are served without `.html`: `public/legal.html` answers `/legal`, and `/legal.html` redirects there.

## Environment Variables

Set server values in your Vercel project's environment variables and read them with `process.env`. Public `VITE_*` values are embedded at build time, so set them for builds too.

## Cron Jobs

Each expression a job in `crons/` exports becomes a Vercel Cron Job. Add a `CRON_SECRET` environment variable to your Vercel project: Vercel sends it with each invocation, and Void runs your jobs only when it matches.

Vercel Cron Jobs run on production deployments and use their own syntax:

- Five numeric fields. Names such as `MON` or `JAN` are not supported.
- Day of week runs from `0` (Sunday) to `6`.
- Set day of month or day of week, not both.

The build fails on an expression Vercel can't run. On the Hobby plan, each job runs at most once a day. See [Vercel's cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

## What's Different

Vercel runs your app as a Node.js function, so the [Node.js target's differences](./nodejs-bun-deno.md#what-s-different) apply: Cloudflare bindings, `void/env`, auth, WebSocket routes, inbound email, and edge prerendering are unavailable. In addition:

- **Queues:** `void/queues` and `queues/` require Cloudflare. The build fails if your app uses them.
- **Revalidation:** `routing.revalidate` and per-page `revalidate` are ignored.
- **HTTPS:** Vercel redirects HTTP to HTTPS for you, so `routing.alwaysUseHttps` is not available.
- **Local preview:** `vite preview` serves your build without Vercel's routing. Use a [preview deployment](https://vercel.com/docs/deployments/environments#preview-environment-pre-production) to check redirects and headers.
