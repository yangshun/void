import { describe, expect, it } from 'vite-plus/test';
import { resolveVercelRuntime, vercelCronError } from '../../src/index.ts';

describe('vercelCronError', () => {
  it.each(['* * * * *', '0 5 * * *', '*/15 9-17 * * 1-5', '0,30 * 1 1,6 *', '0 0 * 12 0'])(
    'accepts %s',
    (expression) => {
      expect(vercelCronError(expression)).toBeUndefined();
    },
  );

  it.each([
    ['0 5 * *', 'expected 5 fields'],
    ['60 * * * *', 'invalid minute "60"'],
    ['0 9 * * MON', 'invalid day of week "MON"'],
    ['0 9 * JAN *', 'invalid month "JAN"'],
    ['0 9 * * 7', 'invalid day of week "7"'],
    ['0 0 L * *', 'invalid day of month "L"'],
    ['*/0 * * * *', 'invalid minute "*/0"'],
    ['0 0 5-1 * *', 'invalid day of month "5-1"'],
    ['0 0 1 * 1', 'day of month and day of week cannot both be set'],
  ])('rejects %s', (expression, message) => {
    expect(vercelCronError(expression)).toContain(message);
  });
});

describe('resolveVercelRuntime', () => {
  it.each([
    ['v22.12.0', 'nodejs22.x'],
    ['v24.14.0', 'nodejs24.x'],
    ['v26.1.0', 'nodejs26.x'],
    ['v25.0.0', 'nodejs24.x'],
    ['v20.19.0', 'nodejs24.x'],
  ])('maps Node.js %s to %s', (version, runtime) => {
    expect(resolveVercelRuntime(version)).toBe(runtime);
  });

  it('prefers the configured runtime', () => {
    expect(resolveVercelRuntime('v26.1.0', 'nodejs22.x')).toBe('nodejs22.x');
  });
});
