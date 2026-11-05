---
title: Vercel Target
status: implemented
---

# Vercel target

`target: 'vercel'` builds a native Void app into Vercel's Build Output API
(`.vercel/output`). It is a Node.js target (`isNodeTarget`): Cloudflare-only
features fail the build as on `node`, plus `void/queues` and `queues/`, which
nothing on Vercel would deliver. Users deploy the output with Vercel's Git
integration or `vercel deploy --prebuilt`; `void deploy` refuses the target.
Revalidation is not implemented and is ignored with a warning.

## Build

`nodeTargetPlugin('vercel')` keeps the Node target's dual client and SSR build
with one SSR input, `.void/app.ts` from `compileVercelApp`, and
`ssr.noExternal: true`. `runtime/vercel.ts` supplies the handler:

- a `node:fs` `ASSETS` provider over `import.meta.voidClientDirectory`, so no
  `@hono/node-server` is needed;
- an execution context whose `waitUntil` uses the handler's `context` argument
  or Vercel's `@vercel/request-context` store. The route table is compiled with
  `executionContext: true`, which keeps `executionCtx` in rewrite dispatch and
  the request store;
- `GET /__void/cron`, which checks `Authorization: Bearer $CRON_SECRET` and runs
  the route table's `scheduled` export for `x-vercel-cron-schedule`.

`vite preview` and the prerender runner import the same `dist/ssr/app.js`.
After both builds and prerendering, `routingPlugin.api.finalizeVercelOutput`
calls `writeVercelBuildOutput`, which uses `@void/deploy-vercel`.

## Output

`static/` is the client build without `.vite/`, `_headers` and `_redirects`.
`functions/__void.func/` holds the server build, the client manifest, error
pages and the static rewrite and fallback destinations, at their paths relative
to a common root, plus what `@vercel/nft` traces from the entry. The trace reads
`new URL('../client/', import.meta.url)` as the whole client build, so traced
client files are dropped: the CDN serves them.

## Routing

The edge applies only what it can apply exactly; the function, which sees the
original URL after an edge rewrite, applies every Void rule again:

1. Each redirect becomes a GET/HEAD route at the edge, followed by a route that
   sends other methods to the function, which keeps page-action redirects.
2. Each rewrite becomes a `dest` route, so a rewrite to a static file is served
   by the CDN.
3. A rule whose destination has a query, a fragment, a `$`, or a leading
   multi-segment capture (`/:splat` could produce `//host`) sends its requests
   to the function at its position, which preserves first-match order.
4. Static HTML follows Workers Assets' `auto-trailing-slash`: overrides serve
   `x.html` at `/x`, and 307 routes redirect `/x.html`, `/x/`, `/dir` and
   `/dir/index.html`.
5. After `filesystem`, a missing hashed asset gets a `no-store` 404 when no
   route can reach the assets directory, and everything else goes to the
   function. Static output has no function: fallbacks and `404.html` are edge
   routes, and rules the edge cannot apply safely fail the build.
6. Header rules are computed per static file with Void's last-match-wins merge
   and emitted after `hit` as one route per distinct header set. Function
   responses get headers from the in-function middleware.

Static files are served before the function, so middleware does not run for
them and a public file shadows a route at the same path.

## Spike results (2026-11-05)

Measured on a production deployment of a hand-written output:

- The function's `request.url` keeps the original path after an edge `dest`
  rewrite; the destination's query is merged into the request query.
- Redirects append the request query to `Location`. With a destination query,
  the request's parameters come first, unlike `mergeQueryIntoLocation`.
- `hit` routes match the served file path (an override's path, a rewrite's
  destination) and also apply to function responses. For a repeated header,
  the first matching route wins; the function's own headers win over routes.
- `/x/` serves an overridden `x.html` without the `/x` header routes.
- `check: true` fallbacks and a `404.html` route with status 404 work after
  `filesystem`.
- `export default { fetch }` with `launcherType: 'Nodejs'` streams, and the
  handler receives `{ waitUntil, cache, purge }` as its second argument.
- `AWS_LAMBDA_FUNCTION_MEMORY_SIZE` is unset, so the `memory` setting is not
  exposed until its effect under Fluid compute is confirmed.
