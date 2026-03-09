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
} from "./types";

const DEFAULT_CONTEXT_ID = "default" as const;

// Default context clears its entries when a cross-context push targets it.
// This prevents stale routes (e.g. login pages) from accumulating when
// the user navigates between tabs and non-tab routes. Each visit to the
// default context starts with a fresh stack.
const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  clearOnExternalPush: true,
};

// Tab contexts preserve their entries on cross-context push because tab
// stacks are long-lived: switching away from a tab and back should restore
// the tab's last-visited page, not clear it.
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
 * Design rationale (from design doc amendment):
 *
 * - **Cursor-based, not destroy-on-pop.** Entries are preserved when
 *   navigating back. The cursor moves within the stack, enabling
 *   within-context forward navigation without entry re-creation.
 *
 * - **Browser history is not a source of truth.** All browser back/forward
 *   is intercepted and translated to context-local stack operations. Browser
 *   history diverges from internal state and that is accepted.
 *
 * - **No cross-context back.** `originContext` is stored as inert historical
 *   metadata but does not drive back behavior. This eliminates the complexity
 *   of simulating cross-context back chains in `canGoBack()` and
 *   `derivePushedByRoute()`. The concrete UX value of cross-context back
 *   was low compared to the maintenance cost.
 *
 * - **No cross-context forward.** Forward navigation only works within the
 *   active context's entry stack. Cross-context forward has inherent UX
 *   problems: its availability depends on invisible state the user cannot
 *   predict (whether intervening navigations in other contexts have
 *   invalidated the forward chain).
 *
 * - **Context matching uses longest registered prefix.** If nothing matches,
 *   the default context receives the route. There is no `unmatchedBehavior`
 *   configuration — routes always go to the context with the longest
 *   matching prefix, or the default context.
 *
 * Context matching uses longest registered prefix; unmatched routes always
 * go to the default context.
 */
export const createContextHistory = () => {
  const registrations = new Map<string, ContextRegistration>();
  const contexts = new Map<string, ContextStack>();
  let activeContext: string = DEFAULT_CONTEXT_ID;
  let nextEntryId = 1;

  // Monotonic generation counter for commit staleness protection.
  // Each prepare*() call increments prepareGeneration and captures it.
  // A commit() is blocked if:
  //   (a) gen < prepareGeneration — a newer plan was prepared since this
  //       one, making this plan stale (e.g. p1=prepare, p2=prepare, p1.commit)
  //   (b) gen <= lastCommittedGeneration — this plan was already committed
  //       (or a newer one was), preventing double-commit.
  // Both checks together handle: stale commit, double commit, and
  // out-of-order commit.
  let prepareGeneration = 0;
  let lastCommittedGeneration = 0;

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

  // Undo/redo semantics: pushing a new entry when the cursor is not at
  // the top truncates all forward entries. This matches browser behavior
  // and prevents ambiguous forward state after a branch.
  const truncateForwardEntriesIfNeeded = (stack: ContextStack): void => {
    if (stack.entries.length === 0) {
      stack.cursor = 0;
      return;
    }

    if (stack.cursor < stack.entries.length - 1) {
      stack.entries.splice(stack.cursor + 1);
    }
  };

  /**
   * Register a named navigation context with a URL prefix for route matching.
   *
   * Once registered, routes whose pathname matches this prefix (longest
   * prefix wins) will be assigned to this context's stack. Registration
   * is idempotent — calling with the same `id` twice is a no-op.
   *
   * @param id     - Unique context identifier (e.g. "feed")
   * @param prefix - URL prefix for route matching (e.g. "/tabs/feed").
   *   Must not be "/" or "" — those would match every route.
   * @param config - Context-specific configuration (e.g. clearOnExternalPush)
   * @throws If prefix is "/" or ""
   */
  const registerContext = (id: string, prefix: string, config: ContextConfig): void => {
    if (registrations.has(id)) {
      return;
    }

    const normalized = normalizePrefix(prefix);
    if (normalized === "/" || normalized === "") {
      throw new Error(
        `Invalid context prefix "${prefix}": would match every route. ` +
        `Use a more specific prefix like "/tabs/feed".`
      );
    }

    registrations.set(id, {
      prefix: normalized,
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

  /**
   * Return the navigation entry at the active context's current cursor,
   * or undefined if the active context has no entries.
   */
  const currentEntry = (): NavEntry | undefined => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return undefined;
    }

    return stack.entries[stack.cursor];
  };

  /** Build a full path string (pathname + optional query) from a NavEntry. */
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

  /**
   * Push a new navigation entry onto the matched context's stack.
   *
   * The target context is determined by longest-prefix match against the
   * route's pathname. If this is a cross-context push, the target context's
   * existing entries may be cleared (depending on `clearOnExternalPush`).
   * Forward entries beyond the cursor are always truncated before pushing.
   *
   * @param route    - URL string (e.g. "/tabs/feed/page2?q=1") or object
   * @param options  - Push options (routerAnimation, clearOnExternalPush override)
   * @param metadata - Additional route metadata (search, params) when
   *   route is a string and metadata comes from a separate source
   * @returns The created NavEntry
   */
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

  /**
   * Replace the entry at the active context's cursor with a new entry.
   *
   * If the route resolves to a different context than the active one,
   * delegates to `push`. Rationale: replacing a route in context A with a
   * route in context B doesn't have clear stack semantics — should it
   * remove from A? Modify B? The simplest correct behavior is to treat
   * it as entering the new context. The metadata (search, params) is
   * already embedded in the parsed route, so it is preserved through push().
   *
   * Also delegates to `push` if the active stack is empty (nothing to
   * replace in-place).
   *
   * @param route    - URL string or route object
   * @param options  - Push options (routerAnimation)
   * @param metadata - Additional route metadata
   * @returns The created or replaced NavEntry
   */
  const replace = (
    route: RouteInput,
    options?: PushOptions,
    metadata?: RouteMetadata
  ): NavEntry => {
    const parsed = parseRouteInput(route, metadata);
    const targetContext = matchContext(parsed.pathname);

    if (targetContext !== activeContext) {
      // Cross-context replace delegates to push: there is no "current entry"
      // in the target context to replace. The metadata (search, params) is
      // already embedded in `parsed`, so it is preserved through push().
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

  /**
   * Check whether going forward `deep` steps is possible.
   *
   * Returns true if there are at least `deep` entries beyond the cursor.
   * For `deep < 1`, always returns true.
   *
   * @param deep - Number of forward steps to check (default 1)
   */
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
   *    This means tab-root back is terminal: once the tab root is reached,
   *    back stops. Cold-start deep links inside a tab back to the tab root
   *    even with no browser history and no explicit defaultHref.
   * 2. Caller-supplied defaultHref (from IonBackButton or handleNavigateBack).
   * 3. Fallback: '/'
   *
   * This precedence ensures that browser back, hardware back, and
   * swipe-back all share the same fallback rules regardless of entry point.
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
   * Switch to a tab context, restoring its last-visited entry or creating
   * one from `defaultHref` if the tab's stack is empty.
   *
   * Tab switch does NOT trigger `clearOnExternalPush` — tab stacks are
   * long-lived and should preserve their history across tab switches.
   * The synthesized entry (for empty tabs) has `originContext: null`
   * because there is no meaningful "source" for a tab's initial default
   * route — it was not pushed from another context.
   *
   * Delegates to `prepareChangeTab().commit()` so that registration and
   * stack logic are centralized. This is the direct-mutation API — the
   * router layer uses `prepareChangeTab` + `executePlan` instead.
   *
   * @param tab        - Tab context identifier
   * @param defaultHref - Fallback URL if the tab has no history
   * @returns The path of the activated entry
   */
  const changeTab = (tab: string, defaultHref: string): string => {
    const plan = prepareChangeTab(tab, defaultHref);
    const parsed = parseRouteInput(defaultHref);
    const entry = plan.commit({ pathname: parsed.pathname, search: parsed.search });
    return entryToPath(entry);
  };

  /**
   * Reset a tab context to its root entry, truncating all child-page history.
   *
   * If the root entry matches `defaultHref` (or `defaultHref` is undefined),
   * it is preserved. Otherwise, the stack is rebuilt with a single entry
   * from `defaultHref`. The root entry's `originContext` is cleared.
   *
   * Returns the path of the resulting root entry if this is the active tab,
   * or null if the tab is not active (reset still happens but no navigation
   * is needed).
   *
   * @param tab         - Tab context identifier
   * @param defaultHref - Expected root URL; if provided and different from
   *   the current root, the root entry is replaced
   */
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

    targetStack.cursor = 0;
    if (targetStack.entries[0]) {
      targetStack.entries[0].originContext = null;
    }

    if (activeContext !== tab) {
      return null;
    }

    const activeEntry = targetStack.entries[targetStack.cursor];
    return activeEntry ? entryToPath(activeEntry) : null;
  };

  /**
   * Clear all context stacks and create a single entry for `redirectTo`
   * in its matched context. Effectively resets the entire navigation model.
   *
   * @param redirectTo - URL to navigate to after clearing all history
   * @returns The path of the created entry
   */
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

  /**
   * Collect all pathnames from entries at or before the cursor in every
   * context. These are the "retained" views that IonRouterOutlet should
   * keep in the DOM for instant restore on back navigation.
   *
   * Includes entries across ALL contexts (active and inactive), so
   * inactive tab contexts' views stay mounted — this is how tab
   * preservation works (hidden tabs remain in DOM for instant restore).
   *
   * Entries beyond the cursor (forward history) are excluded — those
   * views can be destroyed and will be re-created if the user goes forward.
   */
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

  /**
   * Derive the pushedByRoute value for CurrentRouteInfo production.
   *
   * Returns the pathname that back() would navigate to, or undefined if
   * back is blocked. This controls swipe-back availability and the
   * back button visibility (!!pushedByRoute === showGoBack).
   *
   * Why derived, not stored: the origin context's cursor may change after
   * the entry was created (e.g. `resetTab` on an inactive tab). A stored
   * snapshot would become stale. The dynamic lookup reflects the actual
   * current state — if you go back, you land at the current cursor
   * position, so `pushedByRoute` should reflect that position.
   *
   * Uses implicit defaults only (rootHref if present, else '/'):
   * - cursor > 0 → previous entry pathname
   * - cursor === 0 → implicit default target, unless the root entry
   *   already matches it (in which case back is blocked → undefined)
   *
   * Note: `CurrentRouteInfo.pushedByRoute` reflects the implicit back
   * contract, not a caller-specific `defaultHref`. This is an accepted
   * inconsistency: `IonBackButton` with an explicit `defaultHref` may
   * navigate somewhere different in non-tab contexts, but generic UI
   * (swipe-back, `.can-go-back` class) should reflect the implicit
   * router contract.
   */
  const derivePushedByRoute = (): string | undefined => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return undefined;
    }

    if (stack.cursor > 0) {
      // Guards above ensure cursor > 0 and entries.length > 0,
      // so entries[cursor - 1] is always defined.
      return stack.entries[stack.cursor - 1].pathname;
    }

    // cursor === 0: check implicit default (no caller-specific defaultHref)
    const implicitDefault = getEffectiveDefault();
    const rootEntry = stack.entries[0];
    if (entryToPath(rootEntry) === implicitDefault) {
      return undefined; // already at the implicit default → blocked
    }

    return implicitDefault;
  };

  /**
   * Build a `CurrentRouteInfo` object from an entering NavEntry, the
   * leaving route info, and the navigation context (direction, animation).
   *
   * This is the bridge between the context-history model (NavEntry) and
   * the route-info model consumed by IonRouterOutlet for transition logic.
   *
   * Animation precedence: explicit override > entering entry's animation
   * (for forward) or leaving route's animation (for back). Back uses the
   * leaving entry's animation because that animation was used to push the
   * leaving page — reversing it produces the correct back transition.
   *
   * `delta` is always undefined. Browser navigations are converted to
   * programmatic single-step goBack/goForward calls — the browser's delta
   * is consumed in beforeEach and not propagated to CurrentRouteInfo.
   *
   * `tab` is always the activeContext ID. IonTabBar does NOT read this
   * field — it determines the active tab via pathname.startsWith(href)
   * matching against registered tab buttons. The field exists for internal
   * context tracking and for registerHistoryChangeListener callbacks.
   *
   * @param entering - The NavEntry being navigated to
   * @param leaving  - The current route info being navigated away from
   * @param navCtx   - Direction, animation, and optional action override
   */
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

  // App startup timing gap: the initial route is processed by afterEach
  // before IonTabBar mounts, so it goes to the default context. When
  // IonTabBar calls handleSetCurrentTab, matching entries are moved from
  // the default context to the correct tab context. In practice, this
  // moves exactly one entry (the initial route). The CurrentRouteInfo.tab
  // field may be stale for one cycle ("default" instead of the tab name),
  // but IonTabBar determines the active tab from pathname matching, not
  // from the tab field, so there is no visible glitch.
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

  const ensureTabRegistration = (tab: string, href: string): void => {
    if (registrations.has(tab)) {
      return;
    }

    const prefix = normalizePrefix(href.split("?", 1)[0]);
    registerContext(tab, prefix, TAB_CONTEXT_CONFIG);
    migrateDefaultEntriesToTab(tab);
  };

  /**
   * Register a tab context if not already registered, and store the tab's
   * root href for fallback-to-default back navigation.
   *
   * @param tab - Tab context identifier (e.g. "feed")
   * @param rootHref - The tab button's original href (e.g. "/tabs/feed").
   *   Used as both the prefix for context matching and the fallback target
   *   when back reaches cursor 0 in this tab context.
   */
  const handleSetCurrentTab = (tab: string, rootHref: string): void => {
    ensureTabRegistration(tab, rootHref);

    const stack = contexts.get(tab);
    if (stack) {
      stack.rootHref = rootHref;
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
    animation: PreparedPlan["animation"],
    generation: number
  ): PreparedPlan["commit"] => {
    return (resolved) => {
      if (generation <= lastCommittedGeneration) {
        const s = ensureContextStack(contextId);
        return s.entries[s.cursor] ?? createNavEntry(contextId, parseRouteInput(resolved), { originContext: null, routerAnimation: animation });
      }
      lastCommittedGeneration = generation;

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
   * All back plans use `transport: 'replace'`. This is critical for the
   * loop-avoidance rule: fallback-to-default must use replace semantics,
   * never push, to prevent deep-link entry from creating a back/default
   * ping-pong loop. The design doc amendment explicitly calls out the
   * semantic bug where the old code used `transport='push'` paired with
   * `routerDirection='back'`, which retained the leaving page while
   * running a destructive back transition on it.
   *
   * Returns null if back is blocked (already at the effective default).
   */
  const prepareBack = (defaultHref?: string, animation?: PreparedPlan["animation"]): PreparedPlan | null => {
    const stack = ensureContextStack(activeContext);
    if (stack.entries.length === 0) {
      return null;
    }

    const currentCtx = activeContext;
    const gen = ++prepareGeneration;

    if (stack.cursor > 0) {
      // Cursor move: target is the entry one position back
      const targetEntry = stack.entries[stack.cursor - 1];
      const target = entryToPath(targetEntry);
      const finalCursor = stack.cursor - 1;

      return {
        transport: "replace",
        target,
        direction: "back",
        action: "pop",
        expectedComparableTarget: target,
        animation,
        commit: () => {
          if (gen < prepareGeneration || gen <= lastCommittedGeneration) {
            const s = ensureContextStack(currentCtx);
            return s.entries[s.cursor];
          }
          lastCommittedGeneration = gen;

          const s = ensureContextStack(currentCtx);
          s.cursor = finalCursor;
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
      commit: buildReplaceCommit(currentCtx, animation, gen),
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
    const gen = ++prepareGeneration;
    const finalCursor = stack.cursor + 1;
    const targetEntry = stack.entries[finalCursor];
    const target = entryToPath(targetEntry);

    return {
      transport: "replace",
      target,
      direction: "forward",
      action: "push",
      expectedComparableTarget: target,
      animation,
      commit: () => {
        if (gen < prepareGeneration || gen <= lastCommittedGeneration) {
          const s = ensureContextStack(currentCtx);
          return s.entries[s.cursor];
        }
        lastCommittedGeneration = gen;

        const s = ensureContextStack(currentCtx);
        s.cursor = finalCursor;
        activeContext = currentCtx;
        return s.entries[s.cursor];
      },
    };
  };

  /**
   * Prepare a multi-step traversal plan without mutating state.
   *
   * `go(delta)` is a thin repeated-step wrapper with no special fallback
   * semantics of its own: negative deltas simulate repeated back steps,
   * positive deltas simulate repeated forward steps. Stops at the first
   * blocked step. If blocked on the very first step, returns null.
   * Otherwise returns the final reached target after completed steps
   * (partial completion semantics).
   *
   * The fallback step (cursor 0 → default target) is terminal: the loop
   * breaks after the fallback because there is nothing further to go
   * back to. This prevents fallback-induced infinite loops.
   *
   * Simulates the steps to find the final target, then the commit function
   * replays the actual mutations.
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
    const gen = ++prepareGeneration;

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
          ? buildReplaceCommit(currentCtx, animation, gen)
          : () => {
              if (gen < prepareGeneration || gen <= lastCommittedGeneration) {
                const s = ensureContextStack(currentCtx);
                return s.entries[s.cursor];
              }
              lastCommittedGeneration = gen;

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
        if (gen < prepareGeneration || gen <= lastCommittedGeneration) {
          const s = ensureContextStack(currentCtx);
          return s.entries[s.cursor];
        }
        lastCommittedGeneration = gen;

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
   * Uses `transport: 'push'` because tab switches create browser history
   * entries via `router.push()`. Browser back from a tab root is
   * intentionally blocked (tab contexts have cursor-0 back blocked when
   * rootHref matches the root entry), which matches native mobile tab
   * patterns (iOS/Android) where tab switches are not part of the back
   * stack. Over many tab switches, the browser history accumulates entries
   * that all map to blocked back operations — this is accepted because
   * browser history is not a source of truth (design principle #6).
   *
   * Returns a plan whose commit switches the active context and
   * potentially synthesizes a first entry for an empty tab.
   */
  const prepareChangeTab = (tab: string, defaultHref: string): PreparedPlan => {
    // Note: ensureTabRegistration is a setup side-effect (idempotent),
    // not a navigation mutation. Registration must happen before reading
    // the stack so the context and prefix exist for matching.
    ensureTabRegistration(tab, defaultHref);
    const gen = ++prepareGeneration;
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
        if (gen < prepareGeneration || gen <= lastCommittedGeneration) {
          const stack = ensureContextStack(tab);
          return stack.entries[stack.cursor] ?? createNavEntry(tab, parseRouteInput(resolved), { originContext: null, routerAnimation: undefined });
        }
        lastCommittedGeneration = gen;

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

    const gen = ++prepareGeneration;

    return {
      transport: "replace",
      target: targetPath,
      direction: "back",
      action: "pop",
      expectedComparableTarget: targetPath,
      commit: (resolved) => {
        if (gen < prepareGeneration || gen <= lastCommittedGeneration) {
          const stack = ensureContextStack(tab);
          return stack.entries[stack.cursor] ?? createNavEntry(tab, parseRouteInput(resolved), { originContext: null, routerAnimation: undefined });
        }
        lastCommittedGeneration = gen;

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
    const gen = ++prepareGeneration;

    return {
      transport: "replace",
      target: redirectTo,
      direction: "root",
      action: "replace",
      expectedComparableTarget: redirectTo,
      commit: (resolved) => {
        if (gen < prepareGeneration || gen <= lastCommittedGeneration) {
          const s = ensureContextStack(activeContext);
          return s.entries[s.cursor] ?? createNavEntry(activeContext, parseRouteInput(resolved), { originContext: null, routerAnimation: undefined });
        }
        lastCommittedGeneration = gen;

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
    getRetainedPathnames,
    derivePushedByRoute,
    produceCurrentRouteInfo,
    handleSetCurrentTab,
    snapshot,
    currentEntry,
    canGoBack,
    canGoForward,
    // Prepared (non-mutating) methods for use with router's
    // prepare+commit lifecycle. All commit() closures are guarded
    // by a generation counter — see prepareGeneration/lastCommittedGeneration.
    prepareBack,
    prepareForward,
    prepareGo,
    prepareChangeTab,
    prepareResetTab,
    prepareResetAll,
  };
};
