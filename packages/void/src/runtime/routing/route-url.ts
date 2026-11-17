import type { EncodedRoutePathMap, RoutePathMap, RouteTypesConfig } from 'void/routes';

/**
 * Encode one path segment of a route param. `encodeURIComponent` keeps dots, and
 * URL parsing resolves `.`/`..` (even as `%2e`), so such a segment would move the
 * request to another path instead of reaching this route.
 */
function encodeSegment(name: string, segment: string): string {
  if (segment === '.' || segment === '..') {
    throw new TypeError(
      `Route param "${name}" cannot be "${segment}"; it would change the request path.`,
    );
  }
  return encodeURIComponent(segment);
}

/** Expand complete route tokens without changing query strings or fragments. */
export function interpolateRouteParams(
  path: string,
  params?: Record<string, string>,
  requireParams = false,
): string {
  if (!params && !requireParams) {
    return path;
  }
  const suffixIndex = path.search(/[?#]/);
  const pathname = suffixIndex === -1 ? path : path.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : path.slice(suffixIndex);
  let leadingName: string | undefined;
  const replaced = pathname.replace(
    /(^|\/)(?::([^/{}]+)(\{\.\+\})?|\[(\.\.\.)?([^/[\]]*)\]|\*)(?=\/|$)/g,
    (
      token: string,
      prefix: string,
      name: string | undefined,
      catchAll: string | undefined,
      bracketCatchAll: string | undefined,
      bracketName: string | undefined,
      offset: number,
    ) => {
      name ??= bracketName || undefined;
      const anonymous = name === undefined;
      name ??= '*';
      if (!params || !Object.hasOwn(params, name)) {
        if (requireParams) {
          throw new TypeError(`Missing route param "${name}".`);
        }
        return token;
      }
      if (offset === 0) {
        leadingName = name;
      }
      const value = params[name];
      if (anonymous && value === '' && pathname.slice(offset + token.length) === '/') {
        return '';
      }
      if (requireParams && !anonymous && value === '') {
        throw new TypeError(`Route param "${name}" must not be empty.`);
      }
      return (
        prefix +
        (catchAll || bracketCatchAll || anonymous
          ? value
              .split('/')
              .map((segment) => encodeSegment(name, segment))
              .join('/')
          : encodeSegment(name, value))
      );
    },
  );
  // A path that starts with `//` is read as another host by fetch() and URL parsing.
  if (replaced.startsWith('//') && !pathname.startsWith('//')) {
    throw new TypeError(
      `Route param "${leadingName ?? ''}" would make the request path start with "//", which changes the request host.`,
    );
  }
  return replaced + suffix;
}

/** Known page, HTTP and WebSocket route patterns. */
export type RoutePath = keyof RoutePathMap & string;

// Dynamic segments in either public or legacy patterns match any text,
// so `/users/[id]` accepts `/users/${string}`. Template
// literal types cannot exclude empty or `/`-leading text without per-character unions.
type RouteUrlSegment<S extends string> = S extends `:${string}` | `[${string}]` | '*' ? string : S;
// Root params and catch-alls would accept every absolute path. Keep those
// patterns available to routeUrl(), but require explicit construction for them.
type CheckedRoutePath<P extends string> = P extends `/${infer Segment}/${infer Rest}`
  ? Rest extends ''
    ? string extends RouteUrlSegment<Segment>
      ? never
      : P
    : P
  : P extends `/${infer Segment}`
    ? string extends RouteUrlSegment<Segment>
      ? never
      : P
    : P;
type RouteSegmentsUrl<P extends string> = P extends `${infer Segment}/${infer Rest}`
  ? `${RouteUrlSegment<Segment>}/${RouteSegmentsUrl<Rest>}`
  : RouteUrlSegment<P>;
// A trailing `/*` also matches the bare prefix, as in Hono: `/docs/*` matches `/docs`.
type RoutePatternUrl<P extends string> = P extends `${infer Prefix}/${'*' | '[...]'}/`
  ? `${RouteSegmentsUrl<Prefix>}/` | `${RouteSegmentsUrl<Prefix>}/${string}/`
  : P extends `${infer Prefix}/${'*' | '[...]'}`
    ? (Prefix extends '' ? '/' : RouteSegmentsUrl<Prefix>) | `${RouteSegmentsUrl<Prefix>}/${string}`
    : RouteSegmentsUrl<P>;
// Fixed segments are also accepted percent-encoded, as `routeUrl()` returns them.
type EncodedRoutePath = EncodedRoutePathMap[keyof EncodedRoutePathMap] & string;
type RoutePathUrl = RoutePatternUrl<CheckedRoutePath<RoutePath | EncodedRoutePath>>;
// Use a structural marker so package and generated declarations agree when a
// helper-built URL crosses into a navigation, form, or stream client.
type BuiltRouteUrl = string & { readonly __voidRouteUrl: true };

/** Whether `routing.typedRoutes` is on in the generated route types. */
export type TypedRoutes = RouteTypesConfig extends { typedRoutes: true } ? true : false;

/** The URL of one of the app's routes. A plain string unless `routing.typedRoutes` is on. */
export type RouteUrl = TypedRoutes extends true
  ? BuiltRouteUrl | RoutePathUrl | `${RoutePathUrl}${'?' | '#'}${string}`
  : string;

/** Anything a link can point to: a route URL, a same-page query or hash, or an external URL. */
export type Href = TypedRoutes extends true
  ? RouteUrl | `${'?' | '#'}${string}` | `${'http://' | 'https://' | 'mailto:' | 'tel:'}${string}`
  : string;

/**
 * A URL an HTTP request can target: one of the app's routes or an absolute
 * `http://`/`https://` URL. A plain string unless `routing.typedRoutes` is on.
 */
// Not re-exported from `void/routes`: apps cast runtime strings with `as RouteUrl`.
export type RequestUrl = TypedRoutes extends true
  ? RouteUrl | `${'http://' | 'https://'}${string}`
  : string;

export type RouteQueryValue = string | number | boolean | null | undefined;
export type RouteQuery = Record<string, RouteQueryValue | ReadonlyArray<RouteQueryValue>>;

// `routeUrl()` infers the pattern it was given, known or not, so its helper types
// accept any string. An unknown pattern has no params.
type RouteParamName<P extends string> = P extends RoutePath ? RoutePathMap[P] & string : never;
type RouteUrlOptions<P extends string> = {
  query?: RouteQuery;
  hash?: string;
} & ([RouteParamName<P>] extends [never]
  ? { params?: never }
  : { params: { [K in RouteParamName<P>]: string | number } });

export type RouteOptions<P extends RoutePath> = RouteUrlOptions<P>;

export type RouteDestination<P extends RoutePath = RoutePath> = P extends RoutePath
  ? { pathname: P } & RouteOptions<P>
  : never;

export type RouteUrlInput = Href | URL | RouteDestination;

// An invalid `routeUrl()` call fails against a type that spells out what to fix,
// so the message appears in TypeScript's error. Where an object is expected, the
// type is the message itself: the error stays on one line and object completions
// gain no members. Where a string can be given (the path, or the value of an
// unknown param), the message is wrapped in `RouteUrlError`: editors would offer
// a bare string literal there as a completion.
interface RouteUrlError<Message extends string> {
  readonly __voidRouteUrlError: Message;
}
type UnknownRouteMessage<P extends string> =
  `Unknown route: ${P}. Pass a registered route pattern as the first argument.`;
// A route union names each missing param with the routes that declare it.
type MissingParamMessage<P extends string, Name extends string> = P extends unknown
  ? Name extends RouteParamName<P>
    ? `Missing param ${Name} for route ${P}. Pass it in \`{ params: { ... } }\`.`
    : never
  : never;
type UnknownParamMessage<
  P extends string,
  Name extends PropertyKey,
> = `Unknown param ${Name & (string | number)} for route ${P}. Use the parameter names in the route pattern.`;
type ParamValueMessage<
  P extends string,
  Name extends string,
> = `Param ${Name} for route ${P} must be a string or number.`;
type NoParamsMessage<P extends string> = `Route ${P} has no path params. Remove params.`;

// `O` is the type of the options argument, or `never` when the call has none.
// Until a pattern is inferred, `P` is `string` and the path is every known pattern,
// which editors offer as completions. TypeScript checks a type parameter against
// every branch, so `P & RoutePath` keeps one constrained to `RoutePath` assignable.
type RouteUrlPath<P extends string, O> = [P] extends [RoutePath]
  ? [O] extends [never]
    ? [RouteParamName<P>] extends [never]
      ? P
      : RouteUrlError<MissingParamMessage<P, RouteParamName<P>>>
    : P
  : string extends P
    ? RoutePath
    : (P & RoutePath) | RouteUrlError<UnknownRouteMessage<Exclude<P, RoutePath>>>;

type RouteUrlGivenParams<P extends string, Given> = {
  [K in keyof Given]: K extends RouteParamName<P>
    ? [Given[K]] extends [string | number]
      ? string | number
      : ParamValueMessage<P, K>
    : RouteUrlError<UnknownParamMessage<P, K>>;
};
// `never` when the given params fit the route; otherwise a type that names what to fix.
// Unknown names are reported before missing ones, so a misspelled param names the typo.
// Params without literal keys keep the plain type error.
type RouteUrlParamsError<P extends string, Given> = [Given] extends [object]
  ? string extends keyof Given
    ? never
    : [Exclude<keyof Given, RouteParamName<P>>] extends [never]
      ? [Exclude<RouteParamName<P>, keyof Given>] extends [never]
        ? [Given] extends [{ [K in RouteParamName<P>]: string | number }]
          ? never
          : RouteUrlGivenParams<P, Given>
        : MissingParamMessage<P, Exclude<RouteParamName<P>, keyof Given>>
      : RouteUrlGivenParams<P, Given>
  : never;
// `never` when the given options fit the route; otherwise a type that names what to fix.
type RouteUrlOptionsError<P extends string, O> = O extends { params: infer Given }
  ? [RouteParamName<P>] extends [never]
    ? [Given] extends [undefined]
      ? never
      : { query?: RouteQuery; hash?: string; params?: NoParamsMessage<P> }
    : [RouteUrlParamsError<P, Given>] extends [never]
      ? never
      : { query?: RouteQuery; hash?: string; params: RouteUrlParamsError<P, Given> }
  : [RouteParamName<P>] extends [never]
    ? never
    : MissingParamMessage<P, RouteParamName<P>>;
// Options already typed as the route's own, as in a wrapper that takes `RouteOptions<P>`
// for a generic `P`, pass as they are: TypeScript cannot evaluate the checks for that `P`.
type RouteUrlOptionsArg<P extends string, O> = [O, RouteUrlOptions<P>] extends [
  RouteUrlOptions<P>,
  O,
]
  ? RouteUrlOptions<P>
  : [RouteUrlOptionsError<P, O>] extends [never]
    ? RouteUrlOptions<P>
    : RouteUrlOptionsError<P, O>;
type RouteUrlArgs<P extends string, O> = [O] extends [never]
  ? // `| O` is where TypeScript infers `O` from the options argument.
    [options?: RouteUrlOptions<P> | O]
  : [RouteParamName<P>] extends [never]
    ? [options?: RouteUrlOptionsArg<P, O>]
    : [options: RouteUrlOptionsArg<P, O>];

type UrlOptions = {
  params?: Record<string, string | number>;
  query?: RouteQuery;
  hash?: string;
};

/** Build a relative URL from a known route pattern. */
export function routeUrl<P extends string, O = never>(
  path: RouteUrlPath<P, O>,
  ...args: RouteUrlArgs<P, O>
): RouteUrl;
export function routeUrl(path: string, options?: UrlOptions): RouteUrl {
  return buildRouteUrl(path, options) as RouteUrl;
}

/** @internal Convert navigation inputs to URL strings without requiring an origin. */
export function toUrlString(value: RouteUrlInput): string;
// With an empty route map, RouteDestination is never. Keep the implementation's
// object input available for serialization while callers use the typed signature above.
export function toUrlString(value: string | URL | ({ pathname: string } & UrlOptions)): string {
  if (typeof value === 'string') {
    return value;
  }
  if ('href' in value && typeof value.href === 'string') {
    return value.href;
  }
  return buildRouteUrl(value.pathname, value);
}

function buildRouteUrl(path: string, options?: UrlOptions): string {
  const params = Object.fromEntries(
    Object.entries(options?.params ?? {}).map(([name, value]) => {
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new TypeError(`Route param "${name}" must be a string or number.`);
      }
      return [name, String(value)];
    }),
  );
  const url = new URL('https://void.invalid');
  url.pathname = interpolateRouteParams(path, params, true);

  for (const [key, value] of Object.entries(options?.query ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item !== null && item !== undefined) {
        url.searchParams.append(key, String(item));
      }
    }
  }
  if (options?.hash) {
    url.hash = options.hash;
  }
  return url.pathname + url.search + url.hash;
}
