import { describe, expect, it } from 'vite-plus/test';
import { matchPatternCaptures, patternRegexSource } from '../../src/index.ts';

const PATTERNS = [
  '/',
  '/about',
  '/blog/:slug',
  '/blog/:slug/comments/:id',
  '/docs/*',
  '/docs/:rest*',
  '/files/:name.json',
  '/a.b+c(d)?',
  '/api/v1:health',
  '/*/edit',
  '/old/*/x/*',
  '*',
];

const PATHS = [
  '/',
  '/about',
  '/about/',
  '/blog/hello',
  '/blog/hello/world',
  '/blog/hello/comments/42',
  '/docs',
  '/docs/',
  '/docs/getting-started',
  '/docs/a/b/c',
  '/files/report.json',
  '/files/report.jsonx',
  '/a.b+c(d)?',
  '/aXb+c(d)?',
  '/api/v1:health',
  '/users/1/edit',
  '/old/1/x/2/3',
  '/anything/at/all',
];

/** Named groups only: anonymous wildcards after the first `*` do not capture. */
function regexCaptures(source: string, path: string): Record<string, string> | null {
  const match = new RegExp(source).exec(path);
  if (!match) {
    return null;
  }
  return { ...match.groups };
}

describe('patternRegexSource', () => {
  it.each(PATTERNS)('agrees with matchPatternCaptures for %s', (pattern) => {
    const source = patternRegexSource(pattern);
    for (const path of PATHS) {
      expect(regexCaptures(source, path), `${pattern} against ${path}`).toEqual(
        matchPatternCaptures(pattern, path) === null
          ? null
          : { ...matchPatternCaptures(pattern, path) },
      );
    }
  });

  it('anchors the source and names each capture', () => {
    expect(patternRegexSource('/blog/:slug/*')).toBe('^/blog/(?<slug>[^/]+)/(?<splat>.*)$');
  });

  it('escapes regex syntax in literal text', () => {
    expect(patternRegexSource('/a.b+c')).toBe('^/a\\.b\\+c$');
  });

  it.each(['/:id/:id', '/:splat/*', '/:1'])('rejects the malformed pattern %s', (pattern) => {
    expect(() => patternRegexSource(pattern)).toThrow(SyntaxError);
  });
});
