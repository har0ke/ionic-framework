import type {
  ContextConfig,
  ContextHistorySnapshot,
  ContextStack,
  CurrentRouteInfo,
  NavEntry,
  NavigationContext,
  PushOptions,
  RouteAction,
  RouteDirection,
  SavedEntries,
  StateSnapshot,
} from "./types";

const DEFAULT_CONTEXT_ID = "default" as const;

const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  clearOnExternalPush: true,
};

const TAB_CONTEXT_CONFIG: ContextConfig = {
  clearOnExternalPush: false,
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

/**
 * Creates a context-history manager with named navigation context stacks.
 *
 * Context matching uses longest registered prefix; unmatched routes always
 * go to the default context.
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
      routerAnimation: PushOptions["routerAnimation"] | undefined;
    }
  ): NavEntry => ({
    id: String(nextEntryId++),
    pathname: route.pathname,
    search: route.search,
    params: route.params,
    context,
    originContext: source.originContext,
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

  /**
   * Resolve a pathname to its best matching context ID.
   *
   * Uses longest registered prefix match. If nothing matches, returns
   * the default context.
   */
  const matchContext = (pathname: string): string => {
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

    return bestMatchId ?? DEFAULT_CONTEXT_ID;
  };

  const currentEntry = (): NavEntry | undefined => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return undefined;
    }

    return stack.entries[stack.cursor];
  };

  const entryToPath = (entry: NavEntry): string => (entry.search ? `${entry.pathname}?${entry.search}` : entry.pathname);

  const mapActionFromDirection = (direction: RouteDirection): RouteAction => {
    switch (direction) {
      case "back":
        return "pop";
      case "root":
        return "replace";
      case "forward":
      case "none":
      default:
        return "push";
    }
  };

  const cloneEntry = (entry: NavEntry): NavEntry => ({
    ...entry,
    params: entry.params ? { ...entry.params } : undefined,
  });

  const push = (
    route: RouteInput,
    options?: PushOptions,
    metadata?: RouteMetadata
  ): NavEntry => {
    const parsed = parseRouteInput(route, metadata);
    const targetContext = matchContext(parsed.pathname);

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
    const targetContext = matchContext(parsed.pathname);

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

  /**
   * Execute a back navigation within the active context.
   *
   * If cursor > 0, decrements the cursor and returns the target path.
   * If cursor === 0, back is blocked and returns null.
   *
   * Never switches context. originContext is inert historical metadata.
   */
  const performBack = (): string | null => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0 || stack.cursor <= 0) {
      return null;
    }

    stack.cursor -= 1;
    return entryToPath(stack.entries[stack.cursor]);
  };

  const performForward = (): string | null => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0 || stack.cursor >= stack.entries.length - 1) {
      return null;
    }

    stack.cursor += 1;
    return entryToPath(stack.entries[stack.cursor]);
  };

  /**
   * Multi-step traversal within the active context.
   *
   * For negative deltas: replays performBack() up to abs(delta) times,
   * stopping at the first null (blocked). If the first step blocks,
   * returns null. Otherwise returns the final reached path.
   *
   * For positive deltas: advances cursor by delta (clamped to stack top).
   */
  const go = (delta: number): string | null => {
    const normalizedDelta = Math.trunc(delta);

    if (normalizedDelta === 0) {
      return null;
    }

    if (normalizedDelta < 0) {
      const steps = Math.abs(normalizedDelta);
      const stack = ensureContextStack(activeContext);
      const previousCursor = stack.cursor;

      let completedSteps = 0;
      let finalPathname: string | null = null;

      for (let i = 0; i < steps; i += 1) {
        const pathname = performBack();
        if (pathname === null) {
          if (completedSteps === 0) {
            // First step blocked -- restore cursor and cancel entirely
            stack.cursor = previousCursor;
            return null;
          }
          // Partial completion -- stop at last successful position
          return finalPathname;
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

  const changeTab = (tab: string, defaultHref: string): string => {
    ensureTabRegistration(tab, defaultHref);
    const targetStack = ensureContextStack(tab);

    if (targetStack.entries.length === 0) {
      const route = parseRouteInput(defaultHref);
      const synthesized = createNavEntry(tab, route, {
        originContext: null,
        routerAnimation: undefined,
      });

      targetStack.entries.push(synthesized);
      targetStack.cursor = 0;
    }

    activeContext = tab;
    return entryToPath(targetStack.entries[targetStack.cursor]);
  };

  const resetTab = (tab: string, defaultHref?: string): string | null => {
    const targetStack = ensureContextStack(tab);
    const rootEntry = targetStack.entries[0];
    const rootMatchesDefaultHref = Boolean(rootEntry) && (defaultHref === undefined || entryToPath(rootEntry) === defaultHref);

    if (rootEntry && rootMatchesDefaultHref) {
      targetStack.entries = [rootEntry];
    } else {
      targetStack.entries = [];
      if (defaultHref) {
        const route = parseRouteInput(defaultHref);
        targetStack.entries.push(
          createNavEntry(tab, route, {
            originContext: null,
            routerAnimation: undefined,
          })
        );
      }
    }

    targetStack.cursor = targetStack.entries.length > 0 ? 0 : 0;
    if (targetStack.entries[0]) {
      targetStack.entries[0].originContext = null;
    }

    if (activeContext !== tab) {
      return null;
    }

    const activeEntry = targetStack.entries[targetStack.cursor];
    return activeEntry ? entryToPath(activeEntry) : null;
  };

  const resetAll = (redirectTo: string): string => {
    for (const stack of contexts.values()) {
      stack.entries = [];
      stack.cursor = 0;
    }

    const route = parseRouteInput(redirectTo);
    const targetContext = matchContext(route.pathname);
    const targetStack = ensureContextStack(targetContext);
    const entry = createNavEntry(targetContext, route, {
      originContext: null,
      routerAnimation: undefined,
    });

    targetStack.entries.push(entry);
    targetStack.cursor = 0;
    activeContext = targetContext;

    return entryToPath(entry);
  };

  const captureState = (savedEntries?: SavedEntries[]): StateSnapshot => {
    const cursors: StateSnapshot["cursors"] = {};
    for (const [id, stack] of contexts.entries()) {
      cursors[id] = stack.cursor;
    }

    return {
      activeContext,
      cursors,
      savedEntries: savedEntries?.map((saved) => ({
        context: saved.context,
        entries: saved.entries.map(cloneEntry),
      })),
    };
  };

  const getRetainedPathnames = (): Set<string> => {
    const retainedPathnames = new Set<string>();

    for (const stack of contexts.values()) {
      if (stack.entries.length === 0) {
        continue;
      }

      for (let i = 0; i <= stack.cursor && i < stack.entries.length; i += 1) {
        retainedPathnames.add(stack.entries[i].pathname);
      }
    }

    return retainedPathnames;
  };

  const restoreState = (snapshot: StateSnapshot): void => {
    activeContext = snapshot.activeContext;

    for (const [id, cursor] of Object.entries(snapshot.cursors)) {
      const stack = ensureContextStack(id);
      stack.cursor = cursor;
    }

    for (const saved of snapshot.savedEntries ?? []) {
      const stack = ensureContextStack(saved.context);
      stack.entries.push(...saved.entries.map(cloneEntry));
    }
  };

  /**
   * Derive the pushedByRoute value for CurrentRouteInfo production.
   *
   * Returns the pathname that back() would navigate to, or undefined if
   * back is blocked. This controls swipe-back availability and the
   * back button visibility (!!pushedByRoute === showGoBack).
   *
   * With previous-context removed, this is purely cursor-based:
   * cursor > 0 → previous entry pathname, else undefined.
   */
  const derivePushedByRoute = (): string | undefined => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0 || stack.cursor <= 0) {
      return undefined;
    }

    return stack.entries[stack.cursor - 1]?.pathname;
  };

  const produceCurrentRouteInfo = (
    entering: NavEntry,
    leaving: CurrentRouteInfo | undefined,
    navCtx: NavigationContext & { action?: RouteAction }
  ): CurrentRouteInfo => {
    const direction = navCtx.direction ?? "forward";
    const action = navCtx.action ?? mapActionFromDirection(direction);

    return {
      id: entering.id,
      pathname: entering.pathname,
      search: entering.search,
      params: entering.params,
      pushedByRoute: derivePushedByRoute(),
      routerAction: action,
      routerDirection: direction,
      routerAnimation: navCtx.animation ?? (direction === "back" ? leaving?.routerAnimation : entering.routerAnimation),
      lastPathname: leaving?.pathname ?? "",
      prevRouteLastPathname: leaving?.lastPathname,
      delta: undefined,
      tab: activeContext,
    };
  };

  const deriveTabPrefix = (tab: string, currentPathname: string): string => {
    const pathname = currentPathname.split("?", 1)[0];
    const segments = pathname.split("/").filter(Boolean);
    const tabSegmentIndex = segments.indexOf(tab);

    if (tabSegmentIndex === -1) {
      return normalizePrefix(pathname || "/");
    }

    return normalizePrefix(`/${segments.slice(0, tabSegmentIndex + 1).join("/")}`);
  };

  const migrateDefaultEntriesToTab = (tab: string): void => {
    const registration = registrations.get(tab);
    if (!registration) {
      return;
    }

    const defaultStack = ensureContextStack(DEFAULT_CONTEXT_ID);
    const tabStack = ensureContextStack(tab);
    const movedEntries: NavEntry[] = [];
    let movedBeforeOrAtCursorCount = 0;
    let movedCurrent = false;

    defaultStack.entries = defaultStack.entries.filter((entry, index) => {
      if (!prefixMatches(entry.pathname, registration.prefix)) {
        return true;
      }

      if (index <= defaultStack.cursor) {
        movedBeforeOrAtCursorCount += 1;
      }

      if (index === defaultStack.cursor) {
        movedCurrent = true;
      }

      entry.context = tab;
      movedEntries.push(entry);
      return false;
    });

    if (movedEntries.length === 0) {
      return;
    }

    tabStack.entries.push(...movedEntries);
    tabStack.cursor = tabStack.entries.length - 1;

    if (defaultStack.entries.length === 0) {
      defaultStack.cursor = 0;
    } else {
      defaultStack.cursor = Math.max(
        0,
        defaultStack.cursor - movedBeforeOrAtCursorCount
      );
      if (defaultStack.cursor > defaultStack.entries.length - 1) {
        defaultStack.cursor = defaultStack.entries.length - 1;
      }
    }

    if (
      activeContext === DEFAULT_CONTEXT_ID &&
      (movedCurrent || defaultStack.entries.length === 0)
    ) {
      activeContext = tab;
    }
  };

  const ensureTabRegistration = (tab: string, currentPathname: string): void => {
    if (registrations.has(tab)) {
      return;
    }

    const prefix = deriveTabPrefix(tab, currentPathname);
    registerContext(tab, prefix, TAB_CONTEXT_CONFIG);
    migrateDefaultEntriesToTab(tab);
  };

  const handleSetCurrentTab = (tab: string, currentPathname: string): void => {
    ensureTabRegistration(tab, currentPathname);
  };

  /**
   * Produce a read-only snapshot of the complete navigational model state.
   *
   * Each entry's backTarget is purely cursor-based: cursor > 0 → previous
   * entry in the same context, cursor === 0 → null (blocked).
   */
  const snapshot = (): ContextHistorySnapshot => {
    const contextSnapshots: ContextHistorySnapshot["contexts"] = {};

    for (const [id, stack] of contexts.entries()) {
      contextSnapshots[id] = {
        cursor: stack.cursor,
        entries: stack.entries.map((entry, index) => ({
          url: entryToPath(entry),
          backTarget: index > 0 ? { context: id, cursor: index - 1 } : null,
        })),
      };
    }

    return {
      activeContext,
      contexts: contextSnapshots,
    };
  };

  return {
    registerContext,
    matchContext,
    push,
    replace,
    changeTab,
    resetTab,
    resetAll,
    captureState,
    getRetainedPathnames,
    restoreState,
    derivePushedByRoute,
    produceCurrentRouteInfo,
    handleSetCurrentTab,
    snapshot,
    performBack,
    performForward,
    go,
    currentEntry,
    canGoBack,
    canGoForward,
  };
};
