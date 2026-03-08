import type { NavEntry, ContextConfig, ContextStack, PushOptions, UnmatchedBehavior } from "./types";

const DEFAULT_CONTEXT_ID = "default" as const;

const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  backBehavior: "within-context",
  rootBackBehavior: "previous-context",
  clearOnExternalPush: true,
  unmatchedBehavior: "default",
};

type ContextRegistration = {
  prefix: string;
  config: ContextConfig;
};

type RouteMetadata = {
  search?: string;
  params?: Record<string, any>;
};

type RouteInput = string | (RouteMetadata & { pathname: string });

export type MatchContextOptions = {
  /**
   * Optional override for how unmatched routes are handled.
   *
   * Note: Phase 1, Chunk A always resolves unmatched routes to the default
   * context. Active-context handling is implemented in later chunks.
   */
  unmatchedBehavior?: UnmatchedBehavior;
};

/**
 * Creates a context-history registry that can:
 * - register named navigation contexts by pathname prefix
 * - resolve a pathname to the best matching context
 *
 * Phase 1, Chunk A scope: registry + matching only.
 */
export const createContextHistory = () => {
  const registrations = new Map<string, ContextRegistration>();
  const contexts = new Map<string, ContextStack>();
  let activeContext = DEFAULT_CONTEXT_ID;
  let nextEntryId = 1;

  // The default context always exists.
  registrations.set(DEFAULT_CONTEXT_ID, {
    prefix: "",
    config: DEFAULT_CONTEXT_CONFIG,
  });

  contexts.set(DEFAULT_CONTEXT_ID, {
    entries: [],
    cursor: 0,
    config: DEFAULT_CONTEXT_CONFIG,
  });

  const normalizePrefix = (prefix: string): string => {
    if (prefix.length > 1 && prefix.endsWith("/")) {
      return prefix.slice(0, -1);
    }

    return prefix;
  };

  const prefixMatches = (pathname: string, prefix: string): boolean => {
    if (prefix === "") {
      return false;
    }

    return pathname === prefix || pathname.startsWith(prefix + "/");
  };

  const ensureContextStack = (id: string): ContextStack => {
    const existing = contexts.get(id);
    if (existing) {
      return existing;
    }

    const registration = registrations.get(id);
    if (!registration) {
      throw new Error(`Unknown context: ${id}`);
    }

    const created: ContextStack = {
      entries: [],
      cursor: 0,
      config: registration.config,
    };

    contexts.set(id, created);
    return created;
  };

  const parseRouteInput = (route: RouteInput, metadata?: RouteMetadata): RouteMetadata & { pathname: string; search: string } => {
    const normalizeSearch = (search?: string): string => {
      if (!search) {
        return "";
      }

      return search.startsWith("?") ? search.slice(1) : search;
    };

    if (typeof route !== "string") {
      return {
        pathname: route.pathname,
        search: normalizeSearch(route.search),
        params: route.params,
      };
    }

    const [pathname, query = ""] = route.split("?", 2);
    const search = normalizeSearch(metadata?.search ?? query);

    return {
      pathname,
      search,
      params: metadata?.params,
    };
  };

  const createNavEntry = (
    context: string,
    route: ReturnType<typeof parseRouteInput>,
    source: {
      originContext: string | null;
      backBehavior: PushOptions["backBehavior"] | null;
      rootBackBehavior: PushOptions["rootBackBehavior"] | null;
      routerAnimation: PushOptions["routerAnimation"] | undefined;
    }
  ): NavEntry => ({
    id: String(nextEntryId++),
    pathname: route.pathname,
    search: route.search,
    params: route.params,
    context,
    originContext: source.originContext,
    backBehavior: source.backBehavior,
    rootBackBehavior: source.rootBackBehavior,
    routerAnimation: source.routerAnimation,
  });

  const truncateForwardEntriesIfNeeded = (stack: ContextStack): void => {
    if (stack.entries.length === 0) {
      stack.cursor = 0;
      return;
    }

    if (stack.cursor < stack.entries.length - 1) {
      stack.entries.splice(stack.cursor + 1);
    }
  };

  const registerContext = (id: string, prefix: string, config: ContextConfig): void => {
    if (registrations.has(id)) {
      return;
    }

    registrations.set(id, {
      prefix: normalizePrefix(prefix),
      config,
    });

    contexts.set(id, {
      entries: [],
      cursor: 0,
      config,
    });
  };

  const matchContext = (pathname: string, options?: MatchContextOptions): string => {
    let bestMatchId: string | undefined;
    let bestMatchPrefixLength = -1;

    for (const [id, registration] of registrations.entries()) {
      if (id === DEFAULT_CONTEXT_ID) {
        continue;
      }

      const { prefix } = registration;
      if (!prefixMatches(pathname, prefix)) {
        continue;
      }

      if (prefix.length > bestMatchPrefixLength) {
        bestMatchId = id;
        bestMatchPrefixLength = prefix.length;
      }
    }

    if (bestMatchId) {
      return bestMatchId;
    }

    const active = ensureContextStack(activeContext);
    const effectiveUnmatchedBehavior = options?.unmatchedBehavior ?? active.config.unmatchedBehavior;

    return effectiveUnmatchedBehavior === "active" ? activeContext : DEFAULT_CONTEXT_ID;
  };

  const currentEntry = (): NavEntry | undefined => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return undefined;
    }

    return stack.entries[stack.cursor];
  };

  const entryToPath = (entry: NavEntry): string => (entry.search ? `${entry.pathname}?${entry.search}` : entry.pathname);

  const push = (
    route: RouteInput,
    options?: PushOptions,
    metadata?: RouteMetadata
  ): NavEntry => {
    const parsed = parseRouteInput(route, metadata);
    const targetContext = matchContext(parsed.pathname, {
      unmatchedBehavior: options?.unmatchedBehavior,
    });

    const previousActiveContext = activeContext;
    const isCrossContextPush = targetContext !== previousActiveContext;
    const targetStack = ensureContextStack(targetContext);

    if (isCrossContextPush) {
      const shouldClearTarget = options?.clearOnExternalPush ?? targetStack.config.clearOnExternalPush;
      if (shouldClearTarget) {
        targetStack.entries = [];
        targetStack.cursor = 0;
      }
    }

    truncateForwardEntriesIfNeeded(targetStack);

    const entry = createNavEntry(targetContext, parsed, {
      originContext: isCrossContextPush ? previousActiveContext : null,
      backBehavior: options?.backBehavior ?? null,
      rootBackBehavior: options?.rootBackBehavior ?? null,
      routerAnimation: options?.routerAnimation,
    });

    targetStack.entries.push(entry);
    targetStack.cursor = targetStack.entries.length - 1;
    activeContext = targetContext;

    return entry;
  };

  const replace = (
    route: RouteInput,
    options?: PushOptions,
    metadata?: RouteMetadata
  ): NavEntry => {
    const parsed = parseRouteInput(route, metadata);
    const targetContext = matchContext(parsed.pathname, {
      unmatchedBehavior: options?.unmatchedBehavior,
    });

    if (targetContext !== activeContext) {
      return push(parsed, options);
    }

    const activeStack = ensureContextStack(activeContext);
    if (activeStack.entries.length === 0) {
      return push(parsed, options);
    }

    const replaced = activeStack.entries[activeStack.cursor];
    const entry = createNavEntry(activeContext, parsed, {
      originContext: replaced.originContext,
      backBehavior: options?.backBehavior ?? replaced.backBehavior,
      rootBackBehavior: options?.rootBackBehavior ?? replaced.rootBackBehavior,
      routerAnimation: options?.routerAnimation ?? replaced.routerAnimation,
    });

    activeStack.entries[activeStack.cursor] = entry;
    return entry;
  };

  const canGoBack = (deep = 1): boolean => {
    if (deep < 1) {
      return true;
    }

    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return false;
    }

    return stack.cursor >= deep;
  };

  const canGoForward = (deep = 1): boolean => {
    if (deep < 1) {
      return true;
    }

    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return false;
    }

    return stack.cursor + deep <= stack.entries.length - 1;
  };

  const performBack = (): string | null => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return null;
    }

    const entry = stack.entries[stack.cursor];
    if (!entry) {
      return null;
    }

    const effectiveBackBehavior = entry.backBehavior ?? stack.config.backBehavior;
    const effectiveRootBackBehavior = entry.rootBackBehavior ?? stack.config.rootBackBehavior;

    const trySwitchToOriginContext = (): string | null => {
      const originContextId = entry.originContext;
      if (!originContextId) {
        return null;
      }

      const originStack = contexts.get(originContextId);
      if (!originStack || originStack.entries.length === 0) {
        return null;
      }

      const originEntry = originStack.entries[originStack.cursor];
      if (!originEntry) {
        return null;
      }

      activeContext = originContextId;
      return entryToPath(originEntry);
    };

    if (stack.cursor > 0) {
      if (effectiveBackBehavior === "previous-context") {
        const originPathname = trySwitchToOriginContext();
        if (originPathname) {
          return originPathname;
        }
      }

      stack.cursor -= 1;
      return entryToPath(stack.entries[stack.cursor]);
    }

    if (effectiveRootBackBehavior === "previous-context") {
      const originPathname = trySwitchToOriginContext();
      if (originPathname) {
        return originPathname;
      }
    }

    return null;
  };

  const performForward = (): string | null => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0 || stack.cursor >= stack.entries.length - 1) {
      return null;
    }

    stack.cursor += 1;
    return entryToPath(stack.entries[stack.cursor]);
  };

  const go = (delta: number): string | null => {
    const normalizedDelta = Math.trunc(delta);

    if (normalizedDelta === 0) {
      return null;
    }

    if (normalizedDelta < 0) {
      const steps = Math.abs(normalizedDelta);
      const previousActiveContext = activeContext;
      const previousCursors = new Map<string, number>();

      for (const [id, stack] of contexts.entries()) {
        previousCursors.set(id, stack.cursor);
      }

      let completedSteps = 0;
      let finalPathname: string | null = null;

      for (let i = 0; i < steps; i += 1) {
        const pathname = performBack();
        if (pathname === null) {
          if (completedSteps === 0) {
            activeContext = previousActiveContext;
            for (const [id, cursor] of previousCursors.entries()) {
              const stack = contexts.get(id);
              if (stack) {
                stack.cursor = cursor;
              }
            }

            return null;
          }

          const entry = currentEntry();
          return entry ? entryToPath(entry) : null;
        }

        completedSteps += 1;
        finalPathname = pathname;
      }

      return finalPathname;
    }

    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return null;
    }

    const targetCursor = Math.min(stack.cursor + normalizedDelta, stack.entries.length - 1);
    if (targetCursor === stack.cursor) {
      return null;
    }

    stack.cursor = targetCursor;
    return entryToPath(stack.entries[stack.cursor]);
  };

  return {
    registerContext,
    matchContext,
    push,
    replace,
    performBack,
    performForward,
    go,
    currentEntry,
    canGoBack,
    canGoForward,
  };
};
