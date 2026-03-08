import type {
  ContextConfig,
  ContextHistorySnapshot,
  ContextStack,
  CurrentRouteInfo,
  NavEntry,
  NavigationContext,
  PreparedPlan,
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
    rootHref: undefined,
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
      rootHref: undefined,
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
      rootHref: undefined,
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

  /**
   * Check whether going back `deep` steps is possible.
   *
   * Uses cursor position plus an offset of 1 if the active context would
   * still perform one fallback-to-default step at root (i.e. the root
   * entry does not match the effective default target).
   *
   * @param deep - Number of back steps to check (default 1)
   * @param defaultHref - Optional fallback target for non-tab contexts
   */
  const canGoBack = (deep = 1, defaultHref?: string): boolean => {
    if (deep < 1) {
      return true;
    }

    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return false;
    }

    const effectiveDepth = stack.cursor + (contextWouldGoToDefault(defaultHref) ? 1 : 0);
    return effectiveDepth >= deep;
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
   * Compute the effective default target for the active context at cursor 0.
   *
   * Precedence:
   * 1. Tab context rootHref (from IonTabButton.href) — if present, wins.
   *    In a tab context, do NOT fall through to defaultHref or '/'.
   * 2. Caller-supplied defaultHref (from IonBackButton or handleNavigateBack).
   * 3. Fallback: '/'
   *
   * @returns The default target pathname, or undefined if in a tab context
   *   with no rootHref (shouldn't happen in normal operation but handled
   *   defensively).
   */
  const getEffectiveDefault = (defaultHref?: string): string => {
    const stack = ensureContextStack(activeContext);

    // Tab context rootHref wins — back is terminal at tab root.
    if (stack.rootHref !== undefined) {
      return stack.rootHref;
    }

    return defaultHref ?? "/";
  };

  /**
   * Check whether back at cursor 0 would perform a fallback-to-default
   * step (i.e. the root entry does not already match the effective default).
   *
   * Used by canGoBack() to add +1 to the effective depth.
   */
  const contextWouldGoToDefault = (defaultHref?: string): boolean => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return false;
    }

    const rootEntry = stack.entries[0];
    const effectiveDefault = getEffectiveDefault(defaultHref);
    return entryToPath(rootEntry) !== effectiveDefault;
  };

  /**
   * Execute a back navigation within the active context.
   *
   * Decision order:
   * 1. cursor > 0: decrement cursor, return that entry.
   * 2. cursor === 0: compute effective default target:
   *    - rootHref (tab context) > defaultHref > '/'
   *    - If current root entry already matches default, return null (blocked).
   *    - Otherwise, return the default target path.
   *
   * Important: in a tab context with rootHref, defaultHref and '/' are never
   * used. Tab-root back is terminal once the tab root is reached.
   *
   * Never switches context. originContext is inert historical metadata.
   *
   * @param defaultHref - Optional fallback target (from IonBackButton or caller)
   * @returns Target path string, or null if back is blocked
   */
  const performBack = (defaultHref?: string): string | null => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return null;
    }

    // Step 1: cursor > 0 → decrement
    if (stack.cursor > 0) {
      stack.cursor -= 1;
      return entryToPath(stack.entries[stack.cursor]);
    }

    // Step 2: cursor === 0 → fallback to default
    const effectiveDefault = getEffectiveDefault(defaultHref);
    const rootEntry = stack.entries[0];

    // Step 3: already at default → blocked
    if (entryToPath(rootEntry) === effectiveDefault) {
      return null;
    }

    // Step 4: resolve to default target
    return effectiveDefault;
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
   * Multi-step traversal. A thin wrapper over performBack/performForward.
   *
   * For negative deltas: replays performBack(defaultHref) up to abs(delta)
   * times, stopping at the first null. If the first step blocks, returns null.
   *
   * For positive deltas: replays performForward() up to delta times,
   * stopping at the first null.
   *
   * @param delta - Number of steps (negative = back, positive = forward)
   * @param defaultHref - Optional fallback target for non-tab contexts
   * @returns Final reached path, or null if first step was blocked
   */
  const go = (delta: number, defaultHref?: string): string | null => {
    const normalizedDelta = Math.trunc(delta);

    if (normalizedDelta === 0) {
      return null;
    }

    if (normalizedDelta < 0) {
      const steps = Math.abs(normalizedDelta);
      let finalPathname: string | null = null;

      for (let i = 0; i < steps; i += 1) {
        const pathname = performBack(defaultHref);
        if (pathname === null) {
          // First step blocked → cancel entirely; partial → stop here
          return i === 0 ? null : finalPathname;
        }
        finalPathname = pathname;
      }

      return finalPathname;
    }

    // Positive delta: replay performForward()
    let finalPathname: string | null = null;

    for (let i = 0; i < normalizedDelta; i += 1) {
      const pathname = performForward();
      if (pathname === null) {
        return i === 0 ? null : finalPathname;
      }
      finalPathname = pathname;
    }

    return finalPathname;
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
   * Uses implicit defaults only (rootHref if present, else '/'):
   * - cursor > 0 → previous entry pathname
   * - cursor === 0 → implicit default target, unless the root entry
   *   already matches it (in which case back is blocked → undefined)
   */
  const derivePushedByRoute = (): string | undefined => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return undefined;
    }

    if (stack.cursor > 0) {
      return stack.entries[stack.cursor - 1]?.pathname;
    }

    // cursor === 0: check implicit default (no caller-specific defaultHref)
    const implicitDefault = getEffectiveDefault();
    const rootEntry = stack.entries[0];
    if (entryToPath(rootEntry) === implicitDefault) {
      return undefined; // already at the implicit default → blocked
    }

    return implicitDefault;
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

  /**
   * Register a tab context if not already registered, and store the tab's
   * root href for fallback-to-default back navigation.
   *
   * @param tab - Tab context identifier (e.g. "feed")
   * @param currentPathname - Current route pathname (used to derive the prefix
   *   for context matching on first registration)
   * @param rootHref - The tab button's original href (e.g. "/tabs/feed/").
   *   This is the source of truth for where back falls back to when the
   *   cursor reaches 0 in this tab context.
   */
  const handleSetCurrentTab = (tab: string, currentPathname: string, rootHref?: string): void => {
    ensureTabRegistration(tab, currentPathname);

    if (rootHref !== undefined) {
      const stack = contexts.get(tab);
      if (stack) {
        stack.rootHref = rootHref;
      }
    }
  };

  // ─── Prepared (non-mutating) navigation methods ────────────────────

  /**
   * Helper to build a commit function that replaces the entry at the active
   * context's current cursor position using the resolved route payload.
   *
   * Used by fallback-to-default scenarios where back/go resolves to a
   * synthetic default target rather than an existing entry.
   */
  const buildReplaceCommit = (
    contextId: string,
    animation: PreparedPlan["animation"]
  ): PreparedPlan["commit"] => {
    return (resolved) => {
      const stack = ensureContextStack(contextId);
      const parsed = parseRouteInput(resolved);
      const entry = createNavEntry(contextId, parsed, {
        originContext: null,
        routerAnimation: animation,
      });
      if (stack.entries.length === 0) {
        stack.entries.push(entry);
        stack.cursor = 0;
      } else {
        stack.entries[stack.cursor] = entry;
      }
      activeContext = contextId;
      return entry;
    };
  };

  /**
   * Prepare a back navigation plan without mutating state.
   *
   * Returns null if back is blocked.
   */
  const prepareBack = (defaultHref?: string, animation?: PreparedPlan["animation"]): PreparedPlan | null => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return null;
    }

    const currentCtx = activeContext;

    if (stack.cursor > 0) {
      // Cursor move: target is the entry one position back
      const targetEntry = stack.entries[stack.cursor - 1];
      const target = entryToPath(targetEntry);

      return {
        transport: "replace",
        target,
        direction: "back",
        action: "pop",
        expectedComparableTarget: target,
        animation,
        commit: () => {
          const s = ensureContextStack(currentCtx);
          s.cursor -= 1;
          activeContext = currentCtx;
          return s.entries[s.cursor];
        },
      };
    }

    // cursor === 0: fallback to default
    const effectiveDefault = getEffectiveDefault(defaultHref);
    const rootEntry = stack.entries[0];
    if (entryToPath(rootEntry) === effectiveDefault) {
      return null; // blocked
    }

    return {
      transport: "replace",
      target: effectiveDefault,
      direction: "back",
      action: "pop",
      expectedComparableTarget: effectiveDefault,
      animation,
      commit: buildReplaceCommit(currentCtx, animation),
    };
  };

  /**
   * Prepare a forward navigation plan without mutating state.
   *
   * Returns null if forward is blocked.
   */
  const prepareForward = (animation?: PreparedPlan["animation"]): PreparedPlan | null => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0 || stack.cursor >= stack.entries.length - 1) {
      return null;
    }

    const currentCtx = activeContext;
    const targetEntry = stack.entries[stack.cursor + 1];
    const target = entryToPath(targetEntry);

    return {
      transport: "replace",
      target,
      direction: "forward",
      action: "push",
      expectedComparableTarget: target,
      animation,
      commit: () => {
        const s = ensureContextStack(currentCtx);
        s.cursor += 1;
        activeContext = currentCtx;
        return s.entries[s.cursor];
      },
    };
  };

  /**
   * Prepare a multi-step traversal plan without mutating state.
   *
   * Simulates the steps to find the final target, then the commit function
   * replays the actual mutations.
   *
   * Returns null if the first step would be blocked.
   */
  const prepareGo = (delta: number, defaultHref?: string, animation?: PreparedPlan["animation"]): PreparedPlan | null => {
    const normalizedDelta = Math.trunc(delta);
    if (normalizedDelta === 0) {
      return null;
    }

    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return null;
    }

    const currentCtx = activeContext;

    if (normalizedDelta < 0) {
      // Simulate back steps to find final target
      const steps = Math.abs(normalizedDelta);
      let simCursor = stack.cursor;
      let finalTarget: string | null = null;
      let stepsCompleted = 0;
      let lastStepWasFallback = false;

      for (let i = 0; i < steps; i += 1) {
        if (simCursor > 0) {
          simCursor -= 1;
          finalTarget = entryToPath(stack.entries[simCursor]);
          stepsCompleted += 1;
          lastStepWasFallback = false;
        } else {
          // cursor === 0: fallback
          const effectiveDefault = getEffectiveDefault(defaultHref);
          const rootEntry = stack.entries[0];
          if (entryToPath(rootEntry) === effectiveDefault) {
            break; // blocked
          }
          finalTarget = effectiveDefault;
          stepsCompleted += 1;
          lastStepWasFallback = true;
          break; // fallback is terminal (can't go further back)
        }
      }

      if (stepsCompleted === 0 || finalTarget === null) {
        return null;
      }

      const finalCursor = simCursor;
      const isFallback = lastStepWasFallback;

      return {
        transport: "replace",
        target: finalTarget,
        direction: "back",
        action: "pop",
        expectedComparableTarget: finalTarget,
        animation,
        commit: isFallback
          ? buildReplaceCommit(currentCtx, animation)
          : () => {
              const s = ensureContextStack(currentCtx);
              s.cursor = finalCursor;
              activeContext = currentCtx;
              return s.entries[s.cursor];
            },
      };
    }

    // Positive delta: simulate forward steps
    let simCursor = stack.cursor;
    let finalTarget: string | null = null;
    let stepsCompleted = 0;

    for (let i = 0; i < normalizedDelta; i += 1) {
      if (simCursor < stack.entries.length - 1) {
        simCursor += 1;
        finalTarget = entryToPath(stack.entries[simCursor]);
        stepsCompleted += 1;
      } else {
        break;
      }
    }

    if (stepsCompleted === 0 || finalTarget === null) {
      return null;
    }

    const finalCursor = simCursor;

    return {
      transport: "replace",
      target: finalTarget,
      direction: "forward",
      action: "push",
      expectedComparableTarget: finalTarget,
      animation,
      commit: () => {
        const s = ensureContextStack(currentCtx);
        s.cursor = finalCursor;
        activeContext = currentCtx;
        return s.entries[s.cursor];
      },
    };
  };

  /**
   * Prepare a tab change plan without mutating state.
   *
   * Returns a plan whose commit switches the active context and
   * potentially synthesizes a first entry for an empty tab.
   */
  const prepareChangeTab = (tab: string, defaultHref: string): PreparedPlan => {
    ensureTabRegistration(tab, defaultHref);
    const targetStack = ensureContextStack(tab);

    const targetPath = targetStack.entries.length > 0
      ? entryToPath(targetStack.entries[targetStack.cursor])
      : defaultHref;

    return {
      transport: "push",
      target: targetPath,
      direction: "none",
      action: "push",
      expectedComparableTarget: targetPath,
      commit: (resolved) => {
        const stack = ensureContextStack(tab);
        if (stack.entries.length === 0) {
          const parsed = parseRouteInput(resolved);
          const synthesized = createNavEntry(tab, parsed, {
            originContext: null,
            routerAnimation: undefined,
          });
          stack.entries.push(synthesized);
          stack.cursor = 0;
        }
        activeContext = tab;
        return stack.entries[stack.cursor];
      },
    };
  };

  /**
   * Prepare a tab reset plan without mutating state.
   *
   * Returns null if the tab is not the active context (no navigation needed).
   */
  const prepareResetTab = (tab: string, defaultHref?: string): PreparedPlan | null => {
    const targetStack = ensureContextStack(tab);
    const rootEntry = targetStack.entries[0];
    const rootMatchesDefaultHref = Boolean(rootEntry) && (defaultHref === undefined || entryToPath(rootEntry) === defaultHref);

    const targetPath = rootEntry && rootMatchesDefaultHref
      ? entryToPath(rootEntry)
      : defaultHref ?? null;

    if (targetPath === null) {
      return null;
    }

    if (activeContext !== tab) {
      return null;
    }

    return {
      transport: "replace",
      target: targetPath,
      direction: "back",
      action: "pop",
      expectedComparableTarget: targetPath,
      commit: (resolved) => {
        const stack = ensureContextStack(tab);
        const root = stack.entries[0];
        const rootMatches = Boolean(root) && (defaultHref === undefined || entryToPath(root) === defaultHref);

        if (root && rootMatches) {
          stack.entries = [root];
        } else {
          stack.entries = [];
          const parsed = parseRouteInput(resolved);
          stack.entries.push(
            createNavEntry(tab, parsed, {
              originContext: null,
              routerAnimation: undefined,
            })
          );
        }
        stack.cursor = 0;
        if (stack.entries[0]) {
          stack.entries[0].originContext = null;
        }
        return stack.entries[stack.cursor];
      },
    };
  };

  /**
   * Prepare a full reset plan without mutating state.
   *
   * Always returns a plan (resetAll always succeeds).
   */
  const prepareResetAll = (redirectTo: string): PreparedPlan => {
    return {
      transport: "replace",
      target: redirectTo,
      direction: "root",
      action: "replace",
      expectedComparableTarget: redirectTo,
      commit: (resolved) => {
        for (const stack of contexts.values()) {
          stack.entries = [];
          stack.cursor = 0;
        }

        const parsed = parseRouteInput(resolved);
        const targetContext = matchContext(parsed.pathname);
        const targetStack = ensureContextStack(targetContext);
        const entry = createNavEntry(targetContext, parsed, {
          originContext: null,
          routerAnimation: undefined,
        });

        targetStack.entries.push(entry);
        targetStack.cursor = 0;
        activeContext = targetContext;
        return entry;
      },
    };
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
    // Prepared (non-mutating) methods
    prepareBack,
    prepareForward,
    prepareGo,
    prepareChangeTab,
    prepareResetTab,
    prepareResetAll,
  };
};
