/** Node.js runtimes a Vercel Function can use. */
export type VercelRuntime = 'nodejs22.x' | 'nodejs24.x' | 'nodejs26.x';

export const VERCEL_RUNTIMES: ReadonlyArray<VercelRuntime> = [
  'nodejs22.x',
  'nodejs24.x',
  'nodejs26.x',
];

const DEFAULT_RUNTIME: VercelRuntime = 'nodejs24.x';

/**
 * The function runtime: the override when set, otherwise the building Node.js
 * major when Vercel offers it, otherwise Node.js 24.
 */
export function resolveVercelRuntime(nodeVersion: string, override?: VercelRuntime): VercelRuntime {
  if (override) {
    return override;
  }
  const major = /^v?(\d+)\./.exec(nodeVersion)?.[1];
  const candidate = `nodejs${major}.x`;
  return VERCEL_RUNTIMES.find((runtime) => runtime === candidate) ?? DEFAULT_RUNTIME;
}
