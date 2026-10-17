export type RouteMatch = Record<string, string>;

export type Route = {
  method: "GET" | "POST";
  pattern: string;
  auth: boolean;
};

export type ResolvedRoute =
  | { kind: "match"; route: Route; params: RouteMatch }
  | { kind: "method_not_allowed" }
  | { kind: "not_found" };

export function matchPath(pattern: string, pathname: string): RouteMatch | null {
  const patternParts = pattern.split("/").filter((part) => part.length > 0);
  const pathParts = pathname.split("/").filter((part) => part.length > 0);
  if (patternParts.length !== pathParts.length) {
    return null;
  }
  const params: RouteMatch = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected === undefined || actual === undefined) {
      return null;
    }
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) {
      return null;
    }
  }
  return params;
}

export function resolveRoute(routes: readonly Route[], method: string, pathname: string): ResolvedRoute {
  const matches: Array<{ route: Route; params: RouteMatch }> = [];
  for (const route of routes) {
    const params = matchPath(route.pattern, pathname);
    if (params) {
      matches.push({ route, params });
    }
  }
  if (matches.length === 0) {
    return { kind: "not_found" };
  }
  const methodMatch = matches.find((match) => match.route.method === method);
  if (!methodMatch) {
    return { kind: "method_not_allowed" };
  }
  return { kind: "match", route: methodMatch.route, params: methodMatch.params };
}
