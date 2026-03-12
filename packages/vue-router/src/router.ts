import type { AnimationBuilder } from "@ionic/vue";
import type {
  NavigationFailure,
  RouteLocationNormalized,
  RouteLocationRaw,
  Router,
} from "vue-router";
import { NavigationFailureType } from "vue-router";

import { createContextHistory } from "./contextHistory";
import type {
  CurrentRouteInfo,
  ExternalNavigationOptions,
  IonicVueRouterOptions,
  PreparedPlan,
  RouteAction,
  RouteDirection,
  RouteInfo,
} from "./types";

// ── Debug logging ─────────────────────────────────────────────────────
// Set to true to enable verbose navigation tracing in the console.
// Logs every hook entry/exit, plan lifecycle, and context-history snapshot.
const DEBUG_NAV = true;

let dbgSeq = 0;
const dbg = (label: string, data?: Record<string, unknown>) => {
  if (!DEBUG_NAV) return;
  dbgSeq += 1;
  const tag = `[IonicNav #${dbgSeq}] ${label}`;
  if (data) {
    console.debug(tag, data);
  } else {
    console.debug(tag);
  }
};

type PendingNavigation = {
  plan: PreparedPlan;
  animation?: AnimationBuilder;
};

type PendingExternalHint = {
  direction?: RouteDirection;
  animation?: AnimationBuilder;
  action?: RouteAction;
};

/**
 * Extract the search/query portion from a Vue Router fullPath,
 * stripping hash fragments. Hash changes do not trigger Ionic page
 * transitions, so they are excluded from route comparison.
 *
 * Note on hash stripping: `parseRouteInput` in contextHistory.ts also
 * drops hash fragments for the same reason. Hashes are intentionally
 * not part of the navigation model — they are purely client-side anchors.
 */
const getSearchFromFullPath = (fullPath: string): string => {
  const [pathAndSearch] = fullPath.split("#", 1);
  const [, search = ""] = pathAndSearch.split("?", 2);
  return search;
};

type ParsedQueryValue = string | null | Array<string | null>;
type ParsedQuery = Record<string, ParsedQueryValue>;

// Minimal query parser (compatible with Vue Router's default parseQuery).
// Needed to build a { path, query, replace } redirect object without
// embedding "?" in `path` (Vue Router would drop it otherwise).
const parseQuery = (search: string): ParsedQuery => {
  const query: ParsedQuery = {};
  if (search === "" || search === "?") {
    return query;
  }

  const parts = (search[0] === "?" ? search.slice(1) : search).split("&");
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i].replace(/\+/g, " ");
    const eqPos = raw.indexOf("=");
    const rawKey = eqPos < 0 ? raw : raw.slice(0, eqPos);
    const rawValue = eqPos < 0 ? null : raw.slice(eqPos + 1);

    let key = rawKey;
    let value: string | null = rawValue;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      // Keep raw key on decode failure.
    }
    if (rawValue !== null) {
      try {
        value = decodeURIComponent(rawValue);
      } catch {
        value = rawValue;
      }
    }

    if (Object.prototype.hasOwnProperty.call(query, key)) {
      const existing = query[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query[key] = [existing, value];
      }
    } else {
      query[key] = value;
    }
  }

  return query;
};

const buildGuardRedirect = (target: string, replace: boolean): RouteLocationRaw => {
  const [pathWithSearch] = target.split("#", 1);
  const [path, search = ""] = pathWithSearch.split("?", 2);
  const query = search ? parseQuery(search) : undefined;

  return {
    path,
    query,
    replace,
  } as any;
};

/**
 * Build a comparable path string (pathname + query, no hash) from a
 * Vue Router resolved route. Used for deduplication and plan matching.
 */
const toComparablePath = (route: RouteLocationNormalized): string => {
  const search = getSearchFromFullPath(route.fullPath);
  return search ? `${route.path}?${search}` : route.path;
};

const routeInfoToComparablePath = (routeInfo?: RouteInfo): string | undefined => {
  if (!routeInfo?.pathname) {
    return undefined;
  }

  return routeInfo.search
    ? `${routeInfo.pathname}?${routeInfo.search}`
    : routeInfo.pathname;
};

/**
 * Create the Ionic Vue Router integration layer.
 *
 * Wraps a Vue Router instance with context-aware navigation (tabs, back
 * fallback, prepare+commit lifecycle). Installs `beforeEach`/`afterEach`
 * hooks for browser-history interception and plan verification.
 *
 * Returned methods are injected as `"navManager"` for use by IonTabBar,
 * IonTabButton, IonBackButton, IonRouterOutlet, and the `useIonRouter` hook.
 */
export const createIonRouter = (
  opts: IonicVueRouterOptions,
  router: Router
) => {
  const contextHistory = createContextHistory();

  // `pendingBrowserDelta` replaces the old multi-field `currentNavigationInfo`
  // object. A single nullable number is sufficient because the only
  // information needed from `opts.history.listen` is the delta direction
  // and magnitude. `action` and `direction` are no longer needed — they are
  // determined by the calling method (via pendingPlan/pendingHint) or by
  // `opts.history.state.replaced` for external navigations.
  let pendingBrowserDelta: number | null = null;

  // Pending state: either a prepared plan (Ionic-initiated) or an external
  // hint (handleNavigate direction/animation). These two slots replace
  // the old `incomingRouteParams` global with a single-assignment semantic:
  // each executePlan/handleNavigate call overwrites any previous pending.
  //
  // - pendingPlan: set by executePlan() for prepare+commit navigations
  //   (goBack, goForward, go, changeTab, resetTab, resetAll). The plan
  //   contains commit() to mutate context history on afterEach success.
  //
  // - pendingHint: set by handleNavigate() for external navigations that
  //   go through push/replace on context history directly in afterEach.
  //   Contains direction/animation/action hints for CurrentRouteInfo
  //   production.
  let pendingPlan: PendingNavigation | null = null;
  let pendingHint: PendingExternalHint | null = null;

  let currentRouteInfo: CurrentRouteInfo | undefined;
  let leavingRouteInfo: CurrentRouteInfo | undefined;

  const historyChangeListeners: Array<() => void> = [];
  const warnedTraversalMethods = new Set<string>();

  const clearPending = (): { plan: PendingNavigation | null; hint: PendingExternalHint | null } => {
    const result = { plan: pendingPlan, hint: pendingHint };
    pendingPlan = null;
    pendingHint = null;
    return result;
  };

  const notifyHistoryChange = (): void => {
    historyChangeListeners.forEach((cb) => cb());
  };

  const warnPatchedTraversalMethod = (
    method: "go" | "back" | "forward",
    delta?: number
  ): void => {
    if (warnedTraversalMethods.has(method)) {
      return;
    }

    warnedTraversalMethods.add(method);

    if (typeof console === "undefined" || typeof console.warn !== "function") {
      return;
    }

    const invocation =
      method === "go" ? `router.go(${delta ?? 0})` : `router.${method}()`;

    console.warn(
      `[Ionic Vue Router] ${invocation} is overridden to use Ionic context history instead of native browser history. This is a compatibility hack; prefer Ionic navigation APIs such as useIonRouter() and IonBackButton. Calls to these raw Vue Router traversal methods should be rare in production.`
    );
  };

  /**
   * Execute a prepared plan: store it as pending and dispatch the router call.
   *
   * Same-URL short-circuit: if the plan's target matches the current browser
   * URL, Vue Router would reject the navigation as `duplicated`. This happens
   * when duplicate entries exist in the context stack (e.g. rapid-fire deep
   * links pushed the same URL multiple times). Instead of dispatching through
   * Vue Router and having the plan's commit() never called, we commit directly,
   * produce CurrentRouteInfo, and notify listeners. The browser URL is already
   * correct so no routing is needed — only the cursor position changes.
   */
  const executePlan = (plan: PreparedPlan, animation?: AnimationBuilder): void => {
    dbg("executePlan", {
      target: plan.target,
      transport: plan.transport,
      direction: plan.direction,
      action: plan.action,
      expectedComparableTarget: plan.expectedComparableTarget,
      snapshot: contextHistory.snapshot(),
    });

    // Same-URL short-circuit: commit directly when the target URL matches
    // the current browser URL, avoiding a Vue Router "duplicated" rejection.
    const currentPath = toComparablePath(router.currentRoute.value);
    if (currentPath === plan.expectedComparableTarget) {
      dbg("executePlan → SAME-URL short-circuit, committing directly", {
        currentPath,
        direction: plan.direction,
        action: plan.action,
      });

      const resolvedPayload = {
        pathname: router.currentRoute.value.path,
        search: getSearchFromFullPath(router.currentRoute.value.fullPath),
        params: router.currentRoute.value.params as Record<string, any> | undefined,
      };

      const effectiveAnimation = animation ?? plan.animation;
      const leaving = currentRouteInfo;
      const entering = plan.commit(resolvedPayload);

      currentRouteInfo = contextHistory.produceCurrentRouteInfo(
        entering,
        leaving,
        {
          direction: plan.direction,
          action: plan.action,
          animation: effectiveAnimation,
        }
      );
      leavingRouteInfo = leaving;

      dbg("executePlan → SAME-URL committed", {
        entering: entering.pathname,
        snapshot: contextHistory.snapshot(),
      });

      notifyHistoryChange();
      return;
    }

    pendingPlan = { plan, animation: animation ?? plan.animation };

    // void: afterEach handles all navigation outcomes (success, failure,
    // redirect). The promise is intentionally not awaited.
    if (plan.transport === "replace") {
      void router.replace(plan.target);
    } else {
      void router.push(plan.target);
    }
  };

  /**
   * Navigate forward or backward by `delta` steps using context-aware
   * traversal. Negative = back, positive = forward. Dispatches via
   * prepare+commit pattern through Vue Router.
   */
  const go = (delta: number, routerAnimation?: AnimationBuilder) => {
    dbg("go()", { delta, snapshot: contextHistory.snapshot() });
    const plan = contextHistory.prepareGo(delta);
    if (plan === null) {
      dbg("go() → prepareGo returned null (blocked)");
      return;
    }

    dbg("go() → plan ready", { target: plan.target, direction: plan.direction });
    executePlan(plan, routerAnimation);
  };

  /**
   * Navigate one step back in the active context. At cursor 0, falls
   * back to rootHref (tab) or "/" (default). Uses replace semantics.
   * Called by `useIonRouter().back()` and the `ionBackButton` handler.
   */
  const goBack = (routerAnimation?: AnimationBuilder) => {
    dbg("goBack()");
    const plan = contextHistory.prepareBack();
    if (plan === null) {
      dbg("goBack() → prepareBack returned null (blocked)");
      return;
    }

    executePlan(plan, routerAnimation);
  };

  /**
   * Navigate one step forward in the active context. No-op if there
   * are no forward entries. Uses replace semantics.
   */
  const goForward = (routerAnimation?: AnimationBuilder) => {
    dbg("goForward()");
    const plan = contextHistory.prepareForward();
    if (plan === null) {
      dbg("goForward() → prepareForward returned null (blocked)");
      return;
    }

    executePlan(plan, routerAnimation);
  };

  // HACK: Vue Router's raw history traversal methods use the native session
  // history as transport. Once Ionic intercepts a pop navigation and re-syncs
  // the URL with router.replace(), the browser's own forward/back transport no
  // longer matches the context-history cursor model. Patch the imperative
  // router methods here so explicit router.go()/back()/forward() replay
  // context-aware steps directly. Keep this localized and revisit if the hack
  // can be moved down to the history transport layer instead.
  router.go = (delta: number) => {
    if (!Number.isFinite(delta)) {
      return;
    }

    warnPatchedTraversalMethod("go", delta);
    go(Math.trunc(delta));
  };

  router.back = () => {
    warnPatchedTraversalMethod("back");
    goBack();
  };

  router.forward = () => {
    warnPatchedTraversalMethod("forward");
    goForward();
  };

  // `opts.history.listen` fires on `popstate` events only (browser
  // back/forward, raw `history.go()` calls). It does NOT fire on
  // programmatic `router.push()` / `router.replace()`. The wrapped
  // `router.go/back/forward` also bypass this listener and call the
  // context-aware `go(delta)` path directly. So pendingBrowserDelta
  // is only populated by browser/native history events.
  opts.history.listen((_to: any, _from: any, info: any) => {
    pendingBrowserDelta = typeof info?.delta === "number" ? info.delta : null;
    dbg("popstate (history.listen)", {
      delta: pendingBrowserDelta,
      to: _to,
      from: _from,
      browserUrl: typeof location !== "undefined" ? location.href : "n/a",
    });
  });

  // The guard's only job: detect browser back/forward and translate it into
  // a context-aware prepared plan.
  //
  // Important: Do NOT use `next(false)` for popstate interception. Aborting a
  // popstate navigation makes Vue Router schedule an async history.go()
  // restoration to undo the URL change. That restoration can race with Ionic's
  // own replace-based re-sync and snap the address bar back to the leaving URL.
  //
  // Why intercept? Browser history diverges from the context-history
  // model (design principle #6). A raw browser back would navigate to
  // a URL that doesn't correspond to the correct context cursor position.
  // By preparing a context-history plan (and redirecting when needed),
  // the navigation follows the context-aware back/forward algorithms.
  //
  // pendingBrowserDelta is cleared BEFORE calling next() to prevent
  // re-read when the redirect triggers another beforeEach cycle.
  router.beforeEach((_to, _from, next) => {
    const delta = pendingBrowserDelta;
    pendingBrowserDelta = null;

    dbg("beforeEach", {
      to: _to.path,
      from: _from.path,
      delta,
      hasPendingPlan: pendingPlan !== null,
      hasPendingHint: pendingHint !== null,
      browserUrl: typeof location !== "undefined" ? location.href : "n/a",
    });

    if (delta !== null && delta !== 0) {
      dbg("beforeEach → POPSTATE", { delta });

      const plan = contextHistory.prepareGo(delta);
      if (plan === null) {
        // Blocked: keep the app on the current route. Using a replace redirect
        // avoids Vue Router's abort restoration race.
        dbg("beforeEach → POPSTATE blocked, restoring from via replace", {
          from: _from.fullPath,
        });
        next(buildGuardRedirect(_from.fullPath, true));
        return;
      }

      // Popstate navigations are handled through the same prepare+commit
      // lifecycle as Ionic-initiated navigations: store the plan, then let the
      // navigation complete (or redirect it) so afterEach can commit.
      pendingPlan = { plan, animation: plan.animation };
      pendingHint = null;

      const toPath = toComparablePath(_to);
      if (toPath === plan.expectedComparableTarget) {
        dbg("beforeEach → POPSTATE already at plan target", { toPath });
        next();
        return;
      }

      dbg("beforeEach → POPSTATE redirect to plan target", {
        expected: plan.expectedComparableTarget,
        toPath,
        redirectTo: plan.target,
      });
      next(buildGuardRedirect(plan.target, plan.transport === "replace"));
      return;
    }

    dbg("beforeEach → PASS");
    next();
  });

  // ── afterEach: Vue Router redirect/cancellation behavior ──────────
  //
  // Vue Router 4 has two redirect mechanisms with different afterEach
  // implications:
  //
  // 1. Guard redirect (return "/other" or next("/other")):
  //    Vue Router handles this internally as NAVIGATION_GUARD_REDIRECT
  //    (error type 2, not publicly exposed). It recursively calls
  //    pushWithRedirect and fires afterEach ONLY ONCE for the final
  //    resolved destination, with failure = undefined (success).
  //    Our afterEach never sees the original navigation at all.
  //    The expectedComparableTarget mismatch catches this: the plan
  //    was for "/a" but we arrived at "/b", so the plan is dropped
  //    and the navigation is treated as external.
  //
  // 2. Imperative router.push/replace inside a guard:
  //    This starts a separate navigation. Vue Router detects the
  //    pendingLocation changed via checkCanceledNavigation and fires
  //    afterEach for the ORIGINAL navigation with failure.type ===
  //    NavigationFailureType.cancelled. Then the replacement
  //    navigation gets its own afterEach (success or failure).
  //    We preserve pendingPlan on cancelled so the replacement
  //    navigation's afterEach can consume it. This is safe because:
  //    - If the replacement is from user code (not executePlan),
  //      no new pendingPlan is set, and the stale plan's
  //      expectedComparableTarget will mismatch → plan dropped.
  //    - If the replacement IS from executePlan (rapid-fire,
  //      unsupported), executePlan already overwrote pendingPlan
  //      with the new plan before dispatching.
  //
  // 3. NavigationFailureType.duplicated:
  //    Navigating to the current URL. No state change needed.
  //    We clear pending.
  //
  // In all cases, the prepare+commit pattern guarantees no context
  // history state was mutated before afterEach confirms success.
  // ────────────────────────────────────────────────────────────────────

  router.afterEach(
    (
      to: RouteLocationNormalized,
      _from: RouteLocationNormalized,
      failure?: NavigationFailure
    ) => {
      const failureLabel = failure
        ? failure.type === NavigationFailureType.aborted ? "aborted"
        : failure.type === NavigationFailureType.cancelled ? "cancelled"
        : failure.type === NavigationFailureType.duplicated ? "duplicated"
        : `unknown(${failure.type})`
        : undefined;

      dbg("afterEach ENTER", {
        to: to.path,
        from: _from.path,
        failure: failureLabel ?? "none",
        hasPendingPlan: pendingPlan !== null,
        pendingPlanTarget: pendingPlan?.plan.expectedComparableTarget,
        hasPendingHint: pendingHint !== null,
        currentRouteInfo: currentRouteInfo?.pathname,
        browserUrl: typeof location !== "undefined" ? location.href : "n/a",
      });

      if (failure) {
        if (failure.type === NavigationFailureType.aborted) {
          // No rollback needed: prepare+commit means no state was mutated.
          dbg("afterEach → abort, clearing pending");
          clearPending();
        } else if (failure.type === NavigationFailureType.cancelled) {
          // Preserve pending — see comment block above for rationale.
          dbg("afterEach → cancelled, preserving pending");
        } else {
          // duplicated or unknown failure types.
          dbg("afterEach → duplicated/unknown failure, clearing pending");
          clearPending();
        }

        return;
      }

      const { plan: consumedPlan, hint: consumedHint } = clearPending();
      const leaving = currentRouteInfo;

      const leavingPath = routeInfoToComparablePath(leaving);
      const toPath = toComparablePath(to);

      dbg("afterEach SUCCESS", {
        toPath,
        leavingPath,
        hasPlan: consumedPlan !== null,
        planTarget: consumedPlan?.plan.expectedComparableTarget,
        hasHint: consumedHint !== null,
        hintAction: consumedHint?.action,
        hintDirection: consumedHint?.direction,
      });

      // Deduplicate: if the resolved URL matches the current route, skip.
      if (
        leaving !== undefined &&
        leavingPath === toPath
      ) {
        dbg("afterEach → DEDUP (leaving === to), skipping", { leavingPath, toPath });
        notifyHistoryChange();
        return;
      }

      // ── Prepared plan path ──────────────────────────────────────────
      if (consumedPlan !== null) {
        const resolvedPath = toPath;

        if (resolvedPath === consumedPlan.plan.expectedComparableTarget) {
          // Plan matches: commit to mutate context history state.
          dbg("afterEach → PLAN MATCH, committing", {
            resolvedPath,
            direction: consumedPlan.plan.direction,
            action: consumedPlan.plan.action,
          });

          const resolvedPayload = {
            pathname: to.path,
            search: getSearchFromFullPath(to.fullPath),
            params: to.params as Record<string, any> | undefined,
          };

          const entering = consumedPlan.plan.commit(resolvedPayload);
          currentRouteInfo = contextHistory.produceCurrentRouteInfo(
            entering,
            leaving,
            {
              direction: consumedPlan.plan.direction,
              action: consumedPlan.plan.action,
              animation: consumedPlan.animation ?? consumedPlan.plan.animation,
            }
          );
          leavingRouteInfo = leaving;

          dbg("afterEach → PLAN COMMITTED", {
            entering: entering.pathname,
            currentRouteInfo: currentRouteInfo.pathname,
            snapshot: contextHistory.snapshot(),
            browserUrl: typeof location !== "undefined" ? location.href : "n/a",
          });

          notifyHistoryChange();
          return;
        }

        // Plan does not match resolved route (e.g. guard redirect).
        dbg("afterEach → PLAN MISMATCH, falling through to external path", {
          resolvedPath,
          expectedTarget: consumedPlan.plan.expectedComparableTarget,
        });
        // Fall through to external navigation path below.
      }

      // ── External / unplanned navigation path ────────────────────────
      const inferredAction: RouteAction = opts.history.state.replaced
        ? "replace"
        : "push";

      dbg("afterEach → EXTERNAL path", {
        inferredAction,
        historyStateReplaced: !!opts.history.state.replaced,
      });

      const routePayload = {
        pathname: to.path,
        search: getSearchFromFullPath(to.fullPath),
        params: to.params as Record<string, any>,
      };

      const entering =
        inferredAction === "replace"
          ? contextHistory.replace(routePayload, {
              routerAnimation: consumedHint?.animation,
            })
          : contextHistory.push(routePayload, {
              routerAnimation: consumedHint?.animation,
            });

      currentRouteInfo = contextHistory.produceCurrentRouteInfo(entering, leaving, {
        direction: consumedHint?.direction,
        animation: consumedHint?.animation,
        action: consumedHint?.action ?? inferredAction,
      });

      leavingRouteInfo = leaving;

      dbg("afterEach → EXTERNAL committed", {
        entering: entering.pathname,
        action: consumedHint?.action ?? inferredAction,
        direction: consumedHint?.direction,
        currentRouteInfo: currentRouteInfo.pathname,
        snapshot: contextHistory.snapshot(),
        browserUrl: typeof location !== "undefined" ? location.href : "n/a",
      });

      notifyHistoryChange();
    }
  );

  /**
   * Navigate back using the IonBackButton / swipe-back contract.
   *
   * Uses `prepareBack(defaultHref)` which respects rootHref for tab
   * contexts and falls back to `defaultHref > "/"` for the default
   * context. Always uses replace semantics (no push-for-back).
   * No-op if back is fully blocked (already at effective default).
   *
   * The exclusive use of replace here is an intentional fix for the
   * semantic bug in the old code: fallback back used `router.push()`
   * paired with `routerDirection='back'`, which created a new history
   * entry while running a destructive back transition — retaining the
   * leaving page when it should have been replaced. Replace semantics
   * avoid the back/default ping-pong loop that push would cause with
   * deep-link entry points.
   *
   * @param defaultHref     - Fallback URL from `IonBackButton.defaultHref`
   * @param routerAnimation - Transition animation override
   */
  const handleNavigateBack = (
    defaultHref?: string,
    routerAnimation?: AnimationBuilder
  ) => {
    dbg("handleNavigateBack", { defaultHref, snapshot: contextHistory.snapshot() });
    const plan = contextHistory.prepareBack(defaultHref, routerAnimation);

    if (plan !== null) {
      executePlan(plan, routerAnimation);
      return;
    }

    dbg("handleNavigateBack → blocked (already at effective default)");
    // Back is fully blocked (already at the effective default target).
    // Nothing to do.
  };

  /**
   * Navigate to a path with explicit action and direction hints.
   *
   * This is the "external navigation" entry point — it does NOT use the
   * prepare+commit pattern. Instead it stores a `pendingHint` with the
   * caller's direction/animation/action, and the afterEach classifies
   * the navigation via push/replace on the context history.
   *
   * Why not prepare+commit? This method does not need pre-computed targets
   * or commit guards — it delegates context matching and stack mutation
   * entirely to afterEach. The `routerAction` hint determines push vs
   * replace, and `opts.history.state.replaced` provides a secondary signal.
   *
   * Called by `useIonRouter().push/replace/navigate()` and IonRouterOutlet.
   *
   * @param path             - Vue Router route location (string or object)
   * @param routerAction     - "push" or "replace" (default "push")
   * @param routerDirection  - "forward", "back", "root", or "none" (default "forward")
   * @param routerAnimation  - Transition animation override
   */
  const handleNavigate = (
    path: RouteLocationRaw,
    routerAction: RouteAction = "push",
    routerDirection: RouteDirection = "forward",
    routerAnimation?: AnimationBuilder
  ) => {
    dbg("handleNavigate", { path, routerAction, routerDirection });

    pendingHint = {
      direction: routerDirection,
      animation: routerAnimation,
      action: routerAction,
    };

    // void: afterEach handles all navigation outcomes.
    if (routerAction === "replace") {
      void router.replace(path);
    } else {
      void router.push(path);
    }
  };

  /**
   * Convenience wrapper over `handleNavigate` accepting an options object.
   * Destructures `ExternalNavigationOptions` and delegates.
   *
   * Unused in the app but kept for third-party consumers that may use the
   * `navManager` directly. Behavioral fix from the old code: the old
   * implementation ignored `routerAction` and always used `router.push()`.
   * This version respects `routerAction`, so `routerAction: 'replace'`
   * now correctly triggers a replace.
   */
  const navigate = (navigationOptions: ExternalNavigationOptions) => {
    const { routerAnimation, routerDirection, routerLink, routerAction } =
      navigationOptions;

    dbg("navigate (ExternalNavigationOptions)", { routerLink, routerAction, routerDirection });

    handleNavigate(
      routerLink,
      routerAction ?? "push",
      routerDirection,
      routerAnimation
    );
  };

  /**
   * Switch to a tab context via prepare+commit. The plan navigates to the
   * tab's last-visited entry, or synthesizes one from `path` if the tab
   * stack is empty. No-op if `path` is falsy.
   *
   * Called by IonTabButton when the user taps a different tab.
   *
   * @param tab  - Tab context identifier
   * @param path - Fallback URL / current href for the tab
   */
  const changeTab = (tab: string, path?: string) => {
    dbg("changeTab", { tab, path, snapshot: contextHistory.snapshot() });
    if (!path) {
      dbg("changeTab → no path, skipping");
      return;
    }

    const plan = contextHistory.prepareChangeTab(tab, path);
    executePlan(plan);
  };

  /**
   * Reset a tab to its root entry via prepare+commit. Truncates child-page
   * history. No-op if the tab is not the active context.
   *
   * Called by IonTabButton when the user taps the already-active tab.
   *
   * @param tab         - Tab context identifier
   * @param defaultHref - Expected root URL for the tab
   */
  const resetTab = (tab: string, defaultHref?: string) => {
    dbg("resetTab", { tab, defaultHref });
    const plan = contextHistory.prepareResetTab(tab, defaultHref);
    if (plan === null) {
      dbg("resetTab → null plan (not active or empty)");
      return;
    }

    executePlan(plan);
  };

  /**
   * Clear all navigation history across all contexts and navigate to
   * `redirectTo`. Used for hard-reset scenarios (e.g. logout).
   */
  const resetAll = (redirectTo: string) => {
    dbg("resetAll", { redirectTo });
    const plan = contextHistory.prepareResetAll(redirectTo);
    executePlan(plan);
  };

  /** Return the current route metadata, or undefined before first navigation. */
  const getCurrentRouteInfo = (): RouteInfo | undefined => currentRouteInfo;

  /**
   * Return the route info for the page being navigated away from.
   * Falls back to `currentRouteInfo` if no leaving info has been set yet
   * (i.e. before the first navigation completes).
   *
   * Uses a cached value set when `CurrentRouteInfo` is produced, which is
   * simpler than a live lookup and always reflects navigation-time state.
   */
  const getLeavingRouteInfo = (): RouteInfo | undefined =>
    leavingRouteInfo ?? currentRouteInfo;

  /**
   * Check whether going back `deep` steps is possible in the active context.
   * Uses implicit defaults only (rootHref for tabs, "/" otherwise).
   * Does NOT accept a `defaultHref` — the public API is context-aware only.
   */
  const canGoBack = (deep = 1): boolean => contextHistory.canGoBack(deep);

  /**
   * Check whether going forward `deep` steps is possible in the active context.
   */
  const canGoForward = (deep = 1): boolean => contextHistory.canGoForward(deep);

  /**
   * Register a tab context and store its root href for back-fallback.
   *
   * @param tab - Tab context identifier
   * @param rootHref - The tab button's original href (source of truth for
   *   context matching prefix and back-fallback at cursor 0).
   */
  const handleSetCurrentTab = (tab: string, rootHref: string) => {
    dbg("handleSetCurrentTab", { tab, rootHref, snapshotBefore: contextHistory.snapshot() });
    contextHistory.handleSetCurrentTab(tab, rootHref);
    dbg("handleSetCurrentTab done", { snapshotAfter: contextHistory.snapshot() });
  };

  /**
   * Register a callback that fires after every successful navigation.
   * Used by IonTabBar to re-check active tab state.
   */
  const registerHistoryChangeListener = (cb: () => void) => {
    historyChangeListeners.push(cb);
  };

  /**
   * Return a read-only snapshot of the context-history model for debugging
   * and devtools. Not part of the navigation correctness story.
   */
  const getContextSnapshot = () => contextHistory.snapshot();

  /**
   * Return the set of pathnames that should be retained in the DOM by
   * IonRouterOutlet (entries at or before cursor in every context).
   */
  const getRetainedPathnames = () => contextHistory.getRetainedPathnames();

  if (typeof document !== "undefined") {
    document.addEventListener("ionBackButton", (ev: Event) => {
      (ev as any).detail.register(0, (processNextHandler: () => void) => {
        goBack();
        processNextHandler();
      });
    });
  }

  return {
    handleNavigate,
    getLeavingRouteInfo,
    handleNavigateBack,
    handleSetCurrentTab,
    getCurrentRouteInfo,
    canGoBack,
    canGoForward,
    navigate,
    resetTab,
    resetAll,
    changeTab,
    registerHistoryChangeListener,
    goBack,
    goForward,
    getContextSnapshot,
    getRetainedPathnames,
  };
};
