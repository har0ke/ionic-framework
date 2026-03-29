/** @jest-environment jsdom */

import { NavigationFailureType } from "vue-router";

import { createIonRouter } from "../src/router";

type MockRoute = {
  path: string;
  fullPath: string;
  params: Record<string, any>;
};

/** Build a mock Vue Router resolved route from a URL string. Hash is stripped from path. */
const createRoute = (url: string): MockRoute => {
  const [pathWithSearchAndHash] = url.split("#", 1);
  const [path] = pathWithSearchAndHash.split("?", 1);

  return {
    path,
    fullPath: url,
    params: {},
  };
};

const stringifyQuery = (query: Record<string, any>): string => {
  let search = "";
  for (const key in query) {
    const value = query[key];
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      search += (search.length ? "&" : "") + key;
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    values.forEach((v) => {
      if (v === undefined) {
        return;
      }
      search += (search.length ? "&" : "") + key;
      if (v !== null) {
        search += `=${String(v)}`;
      }
    });
  }
  return search;
};

const locationToUrl = (location: any): string => {
  if (typeof location === "string") {
    return location;
  }

  if (!location || typeof location !== "object") {
    throw new Error("Invalid redirect location");
  }

  const path = typeof location.path === "string" ? location.path : "";
  const query = location.query as Record<string, any> | undefined;
  const hash = typeof location.hash === "string" ? location.hash : "";
  const search = query && Object.keys(query).length ? stringifyQuery(query) : "";
  const fullPath = search ? `${path}?${search}` : path;
  return hash ? `${fullPath}${hash}` : fullPath;
};

/**
 * Create a test harness that mocks Vue Router and wires up createIonRouter.
 *
 * Simulates the Vue Router lifecycle (beforeEach guard, afterEach hook,
 * popstate listener) without a real DOM or history API. Key methods:
 *
 * - `commitNavigation(url, opts?)` — simulate a full beforeEach+afterEach
 *   cycle. Updates `router.currentRoute` and `history.state.replaced` on
 *   success. With `failureType`, fires afterEach with a failure without
 *   updating currentRoute.
 * - `emitBrowserDelta(delta)` — simulate a browser popstate event by
 *   calling the `opts.history.listen` callback with the given delta.
 * - `runBeforeEachOnly(url)` — run only the beforeEach guard and return
 *   the `next()` argument (undefined = passed, object/string = redirected).
 * - `runAfterEachOnly(to, from, failure?)` — run afterEach in isolation
 *   without updating router state (useful for failure scenarios).
 */
const createRouterHarness = (initialPath = "/") => {
  let beforeEachGuard:
    | ((to: any, from: any, next: (value?: any) => void) => void)
    | undefined;
  let afterEachHook:
    | ((to: any, from: any, failure?: any) => void)
    | undefined;
  let historyListener: ((to: any, from: any, info: any) => void) | undefined;

  const history = {
    state: {
      replaced: false,
    },
    listen: jest.fn((cb: any) => {
      historyListener = cb;
    }),
  };

  const router = {
    currentRoute: {
      value: createRoute(initialPath),
    },
    beforeEach: jest.fn((cb: any) => {
      beforeEachGuard = cb;
    }),
    afterEach: jest.fn((cb: any) => {
      afterEachHook = cb;
    }),
    push: jest.fn(),
    replace: jest.fn(),
    go: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
  };

  const nav = createIonRouter({ history } as any, router as any);

  const commitNavigation = (
    toUrl: string,
    options?: {
      replaced?: boolean;
      failureType?: NavigationFailureType;
    }
  ) => {
    const to = createRoute(toUrl);
    const from = router.currentRoute.value;

    let nextArg: any = undefined;
    beforeEachGuard?.(to, from, (value?: any) => {
      nextArg = value;
    });

    if (nextArg === false) {
      afterEachHook?.(to, from, { type: NavigationFailureType.aborted });
      return nextArg;
    }

    if (nextArg !== undefined) {
      const redirectedUrl = locationToUrl(nextArg);
      const redirectedTo = createRoute(redirectedUrl);
      const replaced =
        typeof nextArg === "object" && nextArg !== null
          ? Boolean((nextArg as any).replace)
          : false;

      history.state.replaced = replaced;
      router.currentRoute.value = redirectedTo;
      afterEachHook?.(redirectedTo, from);
      return nextArg;
    }

    if (options?.failureType !== undefined) {
      afterEachHook?.(to, from, { type: options.failureType });
      return nextArg;
    }

    history.state.replaced = Boolean(options?.replaced);
    router.currentRoute.value = to;
    afterEachHook?.(to, from);

    return nextArg;
  };

  const emitBrowserDelta = (delta: number) => {
    historyListener?.(undefined, undefined, { delta });
  };

  const runBeforeEachOnly = (toUrl: string) => {
    const to = createRoute(toUrl);
    const from = router.currentRoute.value;
    let nextArg: any;
    beforeEachGuard?.(to, from, (value?: any) => {
      nextArg = value;
    });
    return nextArg;
  };

  const runAfterEachOnly = (
    toUrl: string,
    fromUrl: string,
    failureType?: NavigationFailureType
  ) => {
    const to = createRoute(toUrl);
    const from = createRoute(fromUrl);
    afterEachHook?.(
      to,
      from,
      failureType === undefined ? undefined : { type: failureType }
    );
  };

  return {
    history,
    nav,
    router,
    commitNavigation,
    emitBrowserDelta,
    runBeforeEachOnly,
    runAfterEachOnly,
  };
};

describe("createIonRouter integration", () => {
  it("supports handleNavigate/goBack/goForward/handleNavigateBack flows", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    expect(h.router.push).toHaveBeenCalledWith("/a");
    h.commitNavigation("/a");

    h.nav.handleNavigate("/b", "push", "forward");
    expect(h.router.push).toHaveBeenCalledWith("/b");
    h.commitNavigation("/b");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/b");
    expect(h.nav.canGoBack()).toBe(true);

    h.nav.goBack();
    expect(h.router.replace).toHaveBeenLastCalledWith("/a");
    h.commitNavigation("/a", { replaced: true });
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("pop");

    h.nav.goForward();
    expect(h.router.replace).toHaveBeenLastCalledWith("/b");
    h.commitNavigation("/b", { replaced: true });
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("forward");

    h.nav.handleNavigateBack("/fallback");
    expect(h.router.replace).toHaveBeenLastCalledWith("/a");
    h.commitNavigation("/a", { replaced: true });

    // At cursor 0 in default context, performBack("/fallback") returns
    // "/fallback" (the caller-supplied defaultHref) since root "/a" != "/fallback"
    h.nav.handleNavigateBack("/fallback");
    expect(h.router.replace).toHaveBeenLastCalledWith("/fallback");
    h.commitNavigation("/fallback", { replaced: true });
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/fallback");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("pop");
  });

  it("intercepts browser back/forward in beforeEach", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    h.emitBrowserDelta(-1);
    h.commitNavigation("/a");
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("pop");
    expect(h.router.replace).not.toHaveBeenCalled();

    h.emitBrowserDelta(1);
    h.commitNavigation("/b");
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/b");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("forward");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("push");
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("replays deep history deltas through context-aware go steps", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");
    h.nav.handleNavigate("/c", "push", "forward");
    h.commitNavigation("/c");

    h.emitBrowserDelta(-2);
    h.commitNavigation("/a");
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("pop");
    // Default context at cursor 0: '/a' != '/' → fallback-to-default adds +1
    expect(h.nav.canGoBack()).toBe(true);
    expect(h.nav.canGoBack(2)).toBe(false);
    expect(h.nav.canGoForward(2)).toBe(true);

    h.emitBrowserDelta(2);
    h.commitNavigation("/c");
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/c");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("forward");
    expect(h.nav.canGoBack(2)).toBe(true);
  });

  it("wraps router.go to replay deep context-aware steps directly", () => {
    const h = createRouterHarness("/");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      h.nav.handleNavigate("/a", "push", "forward");
      h.commitNavigation("/a");
      h.nav.handleNavigate("/b", "push", "forward");
      h.commitNavigation("/b");
      h.nav.handleNavigate("/c", "push", "forward");
      h.commitNavigation("/c");

      h.router.go(-2);
      expect(h.router.replace).toHaveBeenLastCalledWith("/a");
      h.commitNavigation("/a", { replaced: true });

      expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
      // Default context at cursor 0: '/a' != '/' → canGoBack true
      expect(h.nav.canGoBack()).toBe(true);
      expect(h.nav.canGoForward(2)).toBe(true);

      h.router.go(2);
      expect(h.router.replace).toHaveBeenLastCalledWith("/c");
      h.commitNavigation("/c", { replaced: true });

      expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/c");
      expect(h.nav.canGoBack(2)).toBe(true);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("router.go(-2)");
    } finally {
      warn.mockRestore();
    }
  });

  it("exposes retained pathnames from context history", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");
    h.nav.handleNavigate("/c", "push", "forward");
    h.commitNavigation("/c");

    h.nav.goBack();
    h.commitNavigation("/b", { replaced: true });

    expect(Array.from(h.nav.getRetainedPathnames()).sort()).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("warns once per overridden traversal method", () => {
    const h = createRouterHarness("/");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      h.router.back();
      h.router.back();
      h.router.forward();
      h.router.forward();
      h.router.go(-1);
      h.router.go(1);

      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[0][0]).toContain("router.back()");
      expect(warn.mock.calls[1][0]).toContain("router.forward()");
      expect(warn.mock.calls[2][0]).toContain("router.go(-1)");
    } finally {
      warn.mockRestore();
    }
  });

  it("blocks browser popstate when no context plan exists", () => {
    const h = createRouterHarness("/");

    // Initial navigation to implicit default.
    h.commitNavigation("/");
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/");
    expect(h.nav.canGoBack()).toBe(false);

    h.emitBrowserDelta(-1);
    // Simulate the browser trying to navigate elsewhere; Ionic should
    // restore the current URL via a replace redirect.
    h.commitNavigation("/somewhere");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/");
    expect(h.nav.canGoBack()).toBe(false);
  });

  it("aborted plan has no effect on context history state", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    // goBack prepares a plan but does not mutate context history.
    // When the navigation is aborted, the plan is discarded.
    h.nav.goBack();
    expect(h.router.replace).toHaveBeenLastCalledWith("/a");
    h.runAfterEachOnly("/a", "/b", NavigationFailureType.aborted);

    // State unchanged: still at /b, no forward entries.
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/b");
    expect(h.nav.canGoForward()).toBe(false);

    // Subsequent navigation works normally after the abort.
    h.nav.goBack();
    expect(h.router.replace).toHaveBeenLastCalledWith("/a");
    h.commitNavigation("/a", { replaced: true });

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
    expect(h.nav.canGoForward()).toBe(true);
  });

  it("skips same-URL mutation but still notifies listeners", () => {
    const h = createRouterHarness("/");
    const listener = jest.fn();

    h.nav.registerHistoryChangeListener(listener);
    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    const previousRouteInfo = h.nav.getCurrentRouteInfo();

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(h.nav.getCurrentRouteInfo()).toBe(previousRouteInfo);
    // Only entry is "/a" in default context, root '/a' != '/' → canGoBack true
    expect(h.nav.canGoBack()).toBe(true);
  });

  it("produces initial route info even when the first confirmed route matches the current URL", () => {
    const h = createRouterHarness("/");

    h.commitNavigation("/");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("push");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("forward");
  });

  it("exposes current/backTarget/canGoBack and tab registration snapshot", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/tabs/feed", "push", "forward");
    h.commitNavigation("/tabs/feed");
    h.nav.handleNavigate("/tabs/feed/details", "push", "forward");
    h.commitNavigation("/tabs/feed/details");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/tabs/feed/details");
    // getBackTarget() is live-computed from the cursor: at cursor 1,
    // back target is entries[0] = "/tabs/feed"
    expect(h.nav.getBackTarget()).toBe("/tabs/feed");
    expect(h.nav.canGoBack()).toBe(true);

    h.nav.handleSetCurrentTab("feed", "/tabs/feed");

    const snapshot = h.nav.getContextSnapshot();
    expect(snapshot.contexts.feed).toBeDefined();
    expect(snapshot.contexts.feed.entries[0].url).toBe("/tabs/feed");
  });

  it("delegates navigate, changeTab, resetTab, resetAll and canGoForward", () => {
    const h = createRouterHarness("/");

    h.nav.navigate({ routerLink: "/a", routerAction: "replace", routerDirection: "root" });
    expect(h.router.replace).toHaveBeenCalledWith("/a");
    h.commitNavigation("/a", { replaced: true });

    h.nav.handleNavigate("/tabs/feed", "push", "forward");
    h.commitNavigation("/tabs/feed");
    h.nav.handleSetCurrentTab("feed", "/tabs/feed");

    h.nav.changeTab("feed", "/tabs/feed");
    expect(h.router.push).toHaveBeenLastCalledWith("/tabs/feed");
    h.commitNavigation("/tabs/feed");

    h.nav.handleNavigate("/tabs/feed/page2", "push", "forward");
    h.commitNavigation("/tabs/feed/page2");

    h.nav.resetTab("feed", "/tabs/feed");
    expect(h.router.replace).toHaveBeenLastCalledWith("/tabs/feed");
    h.commitNavigation("/tabs/feed", { replaced: true });

    h.nav.handleNavigate("/tabs/feed/page2", "push", "forward");
    h.commitNavigation("/tabs/feed/page2");
    h.nav.goBack();
    h.commitNavigation("/tabs/feed", { replaced: true });
    expect(h.nav.canGoForward()).toBe(true);

    h.nav.resetAll("/login");
    expect(h.router.replace).toHaveBeenLastCalledWith("/login");
    h.commitNavigation("/login", { replaced: true });
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("root");
  });

  it("lazy-registers a tab context on first changeTab", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/tabs/tab1", "push", "forward");
    h.commitNavigation("/tabs/tab1");

    h.nav.changeTab("tab2", "/tabs/tab2");
    expect(h.router.push).toHaveBeenLastCalledWith("/tabs/tab2");

    h.commitNavigation("/tabs/tab2");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/tabs/tab2");
    expect(h.nav.getContextSnapshot().contexts.tab2).toBeDefined();
  });

  it("handles ionBackButton by calling goBack path", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    let registeredHandler: ((processNextHandler: () => void) => void) | undefined;
    const register = jest.fn(
      (_priority: number, handler: (processNextHandler: () => void) => void) => {
        registeredHandler = handler;
      }
    );

    document.dispatchEvent(
      new CustomEvent("ionBackButton", {
        detail: { register },
      })
    );

    expect(register).toHaveBeenCalled();

    const processNextHandler = jest.fn();
    registeredHandler?.(processNextHandler);

    expect(h.router.replace).toHaveBeenLastCalledWith("/a");
    expect(processNextHandler).toHaveBeenCalled();
  });

  it("handleNavigateBack is a no-op when back is fully blocked", () => {
    const h = createRouterHarness("/");

    // Push '/' as the only entry — already at default target, back is blocked
    h.nav.handleNavigate("/", "push", "forward");
    h.commitNavigation("/");

    const pushCalls = (h.router.push as jest.Mock).mock.calls.length;
    const replaceCalls = (h.router.replace as jest.Mock).mock.calls.length;

    // Call handleNavigateBack — should be a no-op
    h.nav.handleNavigateBack();

    // No new router calls were made
    expect((h.router.push as jest.Mock).mock.calls.length).toBe(pushCalls);
    expect((h.router.replace as jest.Mock).mock.calls.length).toBe(replaceCalls);

    // Route info unchanged
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/");
  });

  it("handleNavigate forwards action on pendingHint", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "replace", "root");
    h.commitNavigation("/a", { replaced: true });

    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("replace");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("root");
  });

  it("changeTab with undefined path is a no-op", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");

    const pushCalls = (h.router.push as jest.Mock).mock.calls.length;
    const replaceCalls = (h.router.replace as jest.Mock).mock.calls.length;

    // Call changeTab with undefined path
    h.nav.changeTab("feed", undefined);

    // No new router calls
    expect((h.router.push as jest.Mock).mock.calls.length).toBe(pushCalls);
    expect((h.router.replace as jest.Mock).mock.calls.length).toBe(replaceCalls);
  });

  it("tab round-trip: tabA -> tabB -> tabA preserves each tab's cursor", () => {
    const h = createRouterHarness("/");

    // Navigate to tab A
    h.nav.handleNavigate("/tabs/tabA", "push", "forward");
    h.commitNavigation("/tabs/tabA");
    h.nav.handleSetCurrentTab("tabA", "/tabs/tabA");

    // Push a child page in tab A
    h.nav.handleNavigate("/tabs/tabA/detail", "push", "forward");
    h.commitNavigation("/tabs/tabA/detail");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/tabs/tabA/detail");

    // Switch to tab B
    h.nav.changeTab("tabB", "/tabs/tabB");
    h.commitNavigation("/tabs/tabB");
    h.nav.handleSetCurrentTab("tabB", "/tabs/tabB");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/tabs/tabB");

    // Push a child page in tab B
    h.nav.handleNavigate("/tabs/tabB/settings", "push", "forward");
    h.commitNavigation("/tabs/tabB/settings");

    // Switch back to tab A — should restore to /tabs/tabA/detail
    h.nav.changeTab("tabA", "/tabs/tabA");
    h.commitNavigation("/tabs/tabA/detail");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/tabs/tabA/detail");

    // Switch back to tab B — should restore to /tabs/tabB/settings
    h.nav.changeTab("tabB", "/tabs/tabB");
    h.commitNavigation("/tabs/tabB/settings");

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/tabs/tabB/settings");
  });

  it("aborted plan clears pending state without corrupting context history", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    // Initiate goBack which sets pendingPlan
    h.nav.goBack();

    // Simulate Vue Router aborting the navigation (guard returned false)
    h.runAfterEachOnly("/a", "/b", NavigationFailureType.aborted);

    // Pending should be cleared, route info unchanged
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/b");

    // Next navigation should work normally
    h.nav.handleNavigate("/c", "push", "forward");
    h.commitNavigation("/c");
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/c");
  });

  it("plan mismatch (guard redirect) falls through to external navigation", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");

    // Initiate goBack — expects to land at "/"
    h.nav.goBack();

    // Vue Router resolves to a different URL (guard redirected)
    // The afterEach fires with success but at "/login" not "/"
    h.commitNavigation("/login");

    // Plan mismatch → treated as external push to /login
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/login");
  });

  // ─── Guard redirect scenarios ──────────────────────────────────────
  //
  // Vue Router guard redirects (return "/other" or next("/other")) fire
  // afterEach ONLY ONCE for the final resolved destination with
  // failure = undefined (success). The original navigation is never
  // seen by afterEach. The expectedComparableTarget mismatch catches
  // this: the plan was for "/a" but we arrived at "/b", so the plan
  // is dropped and the navigation is treated as external.

  it("guard redirect on goForward drops plan and treats as external", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    // Go back, then prepare a forward plan
    h.nav.goBack();
    h.commitNavigation("/a", { replaced: true });

    h.nav.goForward();
    // Plan expects "/b" but guard redirects to "/c"
    h.commitNavigation("/c");

    // Plan mismatch → treated as external push
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/c");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("push");
  });

  it("guard redirect on changeTab drops plan and treats as external", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/tabs/feed", "push", "forward");
    h.commitNavigation("/tabs/feed");
    h.nav.handleSetCurrentTab("feed", "/tabs/feed");

    // changeTab prepares a plan for "/tabs/feed"
    h.nav.changeTab("tab2", "/tabs/tab2");
    // Guard redirects to "/login" instead
    h.commitNavigation("/login");

    // Plan mismatch → treated as external push to /login
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/login");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("push");
  });

  it("guard redirect on resetTab drops plan and treats as external", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/tabs/feed", "push", "forward");
    h.commitNavigation("/tabs/feed");
    h.nav.handleSetCurrentTab("feed", "/tabs/feed");
    h.nav.handleNavigate("/tabs/feed/page2", "push", "forward");
    h.commitNavigation("/tabs/feed/page2");

    // resetTab prepares a plan for "/tabs/feed"
    h.nav.resetTab("feed", "/tabs/feed");
    // Guard redirects to "/auth"
    h.commitNavigation("/auth");

    // Plan mismatch → treated as external push
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/auth");
  });

  it("guard redirect on resetAll drops plan and treats as external", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");

    // resetAll prepares a plan for "/login"
    h.nav.resetAll("/login");
    // Guard redirects to "/setup"
    h.commitNavigation("/setup");

    // Plan mismatch → treated as external push
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/setup");
  });

  it("guard redirect on handleNavigate (hint path) applies hint to redirected URL", () => {
    const h = createRouterHarness("/");

    // handleNavigate sets pendingHint, not pendingPlan
    h.nav.handleNavigate("/protected", "push", "forward");
    // Guard redirects to "/login"
    h.commitNavigation("/login");

    // Hint is consumed: direction/action from hint apply to the
    // redirected URL since handleNavigate uses the external nav path
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/login");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("forward");
  });

  // ─── Cancelled navigation scenarios ────────────────────────────────
  //
  // NavigationFailureType.cancelled fires when a new navigation starts
  // before the current one completes (imperative router.push/replace
  // inside a guard). The handler preserves pendingPlan on cancelled so
  // the replacement navigation's afterEach can consume it.

  it("cancelled failure preserves pendingPlan for subsequent success", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    // goBack prepares a plan for "/a"
    h.nav.goBack();

    // First afterEach: cancelled (another navigation took over)
    h.runAfterEachOnly("/a", "/b", NavigationFailureType.cancelled);

    // Second afterEach: success at "/a" (the plan's expected target)
    h.commitNavigation("/a", { replaced: true });

    // Plan was preserved through the cancelled event and committed on success
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("pop");
  });

  it("cancelled then success at mismatched URL treats as external", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    // goBack prepares plan targeting "/a"
    h.nav.goBack();

    // First afterEach: cancelled
    h.runAfterEachOnly("/a", "/b", NavigationFailureType.cancelled);

    // Second afterEach: success but at "/other" (not "/a")
    h.commitNavigation("/other");

    // Plan mismatch → external push
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/other");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("push");
  });

  // ─── Duplicated navigation scenarios ───────────────────────────────
  //
  // NavigationFailureType.duplicated fires when navigating to the
  // current URL. No state change needed — pending is cleared.

  it("duplicated failure clears pending and is a no-op", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");

    // handleNavigate to the same URL — Vue Router fires duplicated
    h.nav.handleNavigate("/a", "push", "forward");
    h.runAfterEachOnly("/a", "/a", NavigationFailureType.duplicated);

    // State unchanged
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
    expect(h.nav.canGoBack()).toBe(true); // /a != / → fallback offset
    expect(h.nav.canGoBack(2)).toBe(false);
  });

  it("duplicated failure after handleNavigate clears hint", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");

    // Set a hint via handleNavigate, then duplicated clears it
    h.nav.handleNavigate("/a", "replace", "root");
    h.runAfterEachOnly("/a", "/a", NavigationFailureType.duplicated);

    // Next navigation should not pick up stale hint
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("forward");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("push");
  });

  // ─── Browser interception edge cases ───────────────────────────────

  it("browser delta of 0 passes through without interception", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");

    // Delta 0 should not trigger interception
    h.emitBrowserDelta(0);

    // Normal navigation should pass through beforeEach
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/b");
  });

  it("browser interception with deep forward delta", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");
    h.nav.handleNavigate("/c", "push", "forward");
    h.commitNavigation("/c");

    // Go back 2
    h.nav.goBack();
    h.commitNavigation("/b", { replaced: true });
    h.nav.goBack();
    h.commitNavigation("/a", { replaced: true });

    // Browser forward +2
    h.emitBrowserDelta(2);
    h.commitNavigation("/c");
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/c");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("forward");
  });

  // ─── Query and hash handling ───────────────────────────────────────

  it("plan with query params matches correctly via expectedComparableTarget", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a?q=1", "push", "forward");
    h.commitNavigation("/a?q=1");
    h.nav.handleNavigate("/b?filter=x", "push", "forward");
    h.commitNavigation("/b?filter=x");

    // goBack should target "/a?q=1"
    h.nav.goBack();
    h.commitNavigation("/a?q=1", { replaced: true });
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
    expect(h.nav.getCurrentRouteInfo()?.search).toBe("q=1");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
  });

  it("hash fragments are stripped from route comparison", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");

    // Navigate to /a#section — hash stripped, matches current → dedup skip
    h.nav.handleNavigate("/a#section", "push", "forward");
    h.commitNavigation("/a#section");

    // Should be deduped — no new entry
    expect(h.nav.canGoBack()).toBe(true); // /a != / → fallback offset
    expect(h.nav.canGoBack(2)).toBe(false);
  });

  it("goBack to entry with query preserves it through the plan", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/search?q=hello", "push", "forward");
    h.commitNavigation("/search?q=hello");
    h.nav.handleNavigate("/detail/1", "push", "forward");
    h.commitNavigation("/detail/1");

    h.nav.goBack();
    expect(h.router.replace).toHaveBeenLastCalledWith("/search?q=hello");
    h.commitNavigation("/search?q=hello", { replaced: true });

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/search");
    expect(h.nav.getCurrentRouteInfo()?.search).toBe("q=hello");
  });

  // ─── handleNavigate replace vs push ────────────────────────────────

  it("handleNavigate with replace uses router.replace", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");

    h.nav.handleNavigate("/b", "replace", "none");
    expect(h.router.replace).toHaveBeenLastCalledWith("/b");
    h.commitNavigation("/b", { replaced: true });

    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("replace");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("none");
  });

  // ─── Initial state / edge cases ────────────────────────────────────

  it("getCurrentRouteInfo returns undefined before first navigation", () => {
    const h = createRouterHarness("/");

    // Before any navigation completes, currentRouteInfo is undefined
    expect(h.nav.getCurrentRouteInfo()).toBeUndefined();
  });

  it("getLeavingRouteInfo (deprecated) always returns currentRouteInfo", () => {
    const h = createRouterHarness("/");

    // Before any navigation, both are undefined
    expect(h.nav.getLeavingRouteInfo()).toBeUndefined();

    // After first navigation, returns current
    h.commitNavigation("/");
    expect(h.nav.getLeavingRouteInfo()?.pathname).toBe("/");

    // After second navigation, still returns current (not previous)
    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    expect(h.nav.getLeavingRouteInfo()?.pathname).toBe("/a");
  });

  it("getBackTarget returns undefined before first navigation", () => {
    const h = createRouterHarness("/");
    expect(h.nav.getBackTarget()).toBeUndefined();
  });

  it("getBackTarget returns previous entry when cursor > 0", () => {
    const h = createRouterHarness("/");

    h.commitNavigation("/");
    h.nav.handleNavigate("/page2", "push", "forward");
    h.commitNavigation("/page2");

    // cursor = 1, entries = ["/", "/page2"] → back target = "/"
    expect(h.nav.getBackTarget()).toBe("/");
  });

  it("getBackTarget returns undefined at tab root (cursor 0, entry matches rootHref)", () => {
    const h = createRouterHarness("/tabs/feed");

    h.nav.handleSetCurrentTab("feed", "/tabs/feed");
    h.commitNavigation("/tabs/feed");

    // cursor = 0, entry = "/tabs/feed", rootHref = "/tabs/feed" → blocked
    expect(h.nav.getBackTarget()).toBeUndefined();
  });

  it("getBackTarget returns rootHref when cursor 0 entry differs from rootHref", () => {
    const h = createRouterHarness("/tabs/feed/deep-link");

    h.nav.handleSetCurrentTab("feed", "/tabs/feed");
    h.commitNavigation("/tabs/feed/deep-link");

    // cursor = 0, entry = "/tabs/feed/deep-link", rootHref = "/tabs/feed"
    // entry ≠ rootHref → back target = rootHref
    expect(h.nav.getBackTarget()).toBe("/tabs/feed");
  });

  it("getBackTarget reflects cursor position after goBack", () => {
    const h = createRouterHarness("/");

    h.commitNavigation("/");
    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    // cursor = 2, entries = ["/", "/a", "/b"] → back target = "/a"
    expect(h.nav.getBackTarget()).toBe("/a");

    h.nav.goBack();
    h.commitNavigation("/a");

    // cursor = 1, entries = ["/", "/a", "/b"] → back target = "/"
    expect(h.nav.getBackTarget()).toBe("/");
  });

  it("multiple registerHistoryChangeListener callbacks all fire", () => {
    const h = createRouterHarness("/");
    const listener1 = jest.fn();
    const listener2 = jest.fn();
    const listener3 = jest.fn();

    h.nav.registerHistoryChangeListener(listener1);
    h.nav.registerHistoryChangeListener(listener2);
    h.nav.registerHistoryChangeListener(listener3);

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener3).toHaveBeenCalledTimes(1);
  });

  it("patched router.go ignores non-finite values", () => {
    const h = createRouterHarness("/");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      h.nav.handleNavigate("/a", "push", "forward");
      h.commitNavigation("/a");

      const replaceCalls = (h.router.replace as jest.Mock).mock.calls.length;

      // Non-finite values should be ignored
      h.router.go(NaN);
      h.router.go(Infinity);
      h.router.go(-Infinity);

      expect((h.router.replace as jest.Mock).mock.calls.length).toBe(replaceCalls);
    } finally {
      warn.mockRestore();
    }
  });

  it("patched router.go truncates fractional values", () => {
    const h = createRouterHarness("/");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      h.nav.handleNavigate("/a", "push", "forward");
      h.commitNavigation("/a");
      h.nav.handleNavigate("/b", "push", "forward");
      h.commitNavigation("/b");

      // 1.7 is truncated to 1, but no forward entries → no-op
      // -1.9 is truncated to -1, which should go back to /a
      h.router.go(-1.9);
      h.commitNavigation("/a", { replaced: true });
      expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
    } finally {
      warn.mockRestore();
    }
  });

  // ─── resetTab / resetAll edge cases ────────────────────────────────

  it("resetTab on non-active tab is a no-op at the router level", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/tabs/feed", "push", "forward");
    h.commitNavigation("/tabs/feed");
    h.nav.handleSetCurrentTab("feed", "/tabs/feed");

    h.nav.handleNavigate("/tabs/feed/page2", "push", "forward");
    h.commitNavigation("/tabs/feed/page2");

    // Switch to another context
    h.nav.handleNavigate("/other", "push", "forward");
    h.commitNavigation("/other");

    const replaceCalls = (h.router.replace as jest.Mock).mock.calls.length;
    const pushCalls = (h.router.push as jest.Mock).mock.calls.length;

    // resetTab on feed — feed is not active context → returns null → no-op
    h.nav.resetTab("feed", "/tabs/feed");

    expect((h.router.replace as jest.Mock).mock.calls.length).toBe(replaceCalls);
    expect((h.router.push as jest.Mock).mock.calls.length).toBe(pushCalls);

    // But the tab was reset internally — switching back shows the root
    h.nav.changeTab("feed", "/tabs/feed");
    h.commitNavigation("/tabs/feed");
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/tabs/feed");
  });

  it("resetAll always navigates (never null)", () => {
    const h = createRouterHarness("/");

    // Even on empty state, resetAll produces a plan
    h.nav.resetAll("/start");
    expect(h.router.replace).toHaveBeenLastCalledWith("/start");
    h.commitNavigation("/start", { replaced: true });

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/start");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("root");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("replace");
  });

  // ─── handleNavigateBack edge cases ─────────────────────────────────

  it("handleNavigateBack at cursor 0 with defaultHref navigates to defaultHref", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/deep-link", "push", "forward");
    h.commitNavigation("/deep-link");

    // At cursor 0 in default context, root entry "/deep-link" != "/"
    // so prepareBack returns a plan targeting the implicit default "/"
    // But if defaultHref is provided, it targets defaultHref
    h.nav.handleNavigateBack("/home");
    expect(h.router.replace).toHaveBeenLastCalledWith("/home");
    h.commitNavigation("/home", { replaced: true });

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/home");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("pop");
  });

  it("handleNavigateBack at cursor 0 without defaultHref navigates to /", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/deep-link", "push", "forward");
    h.commitNavigation("/deep-link");

    // No defaultHref → implicit default "/" is used
    h.nav.handleNavigateBack();
    expect(h.router.replace).toHaveBeenLastCalledWith("/");
    h.commitNavigation("/", { replaced: true });

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
  });

  it("handleNavigateBack in tab context uses rootHref, ignoring defaultHref", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/tabs/feed/deep", "push", "forward");
    h.commitNavigation("/tabs/feed/deep");
    h.nav.handleSetCurrentTab("feed", "/tabs/feed");

    // rootHref wins over caller-supplied defaultHref
    h.nav.handleNavigateBack("/fallback");
    expect(h.router.replace).toHaveBeenLastCalledWith("/tabs/feed");
    h.commitNavigation("/tabs/feed", { replaced: true });

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/tabs/feed");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("back");
  });

  // ─── Aborted goForward ─────────────────────────────────────────────

  it("aborted goForward has no effect on context history state", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");
    h.nav.handleNavigate("/b", "push", "forward");
    h.commitNavigation("/b");

    h.nav.goBack();
    h.commitNavigation("/a", { replaced: true });

    // goForward prepares plan but navigation is aborted
    h.nav.goForward();
    h.runAfterEachOnly("/b", "/a", NavigationFailureType.aborted);

    // State unchanged: still at /a with forward available
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a");
    expect(h.nav.canGoForward()).toBe(true);

    // Subsequent forward works normally
    h.nav.goForward();
    h.commitNavigation("/b", { replaced: true });
    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/b");
  });

  // ─── Replace via external path ─────────────────────────────────────

  it("external replace via history.state.replaced updates entry in place", () => {
    const h = createRouterHarness("/");

    h.nav.handleNavigate("/a", "push", "forward");
    h.commitNavigation("/a");

    // External replace (e.g. redirect guard, no hint/plan)
    h.commitNavigation("/a-v2", { replaced: true });

    expect(h.nav.getCurrentRouteInfo()?.pathname).toBe("/a-v2");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("replace");
    // Only one entry (/a-v2 replaced /a in default context)
    expect(h.nav.canGoBack()).toBe(true); // /a-v2 != / → fallback
    expect(h.nav.canGoBack(2)).toBe(false);
  });

  // ─── navigate() wrapper ────────────────────────────────────────────

  it("navigate wrapper correctly forwards all options including defaults", () => {
    const h = createRouterHarness("/");

    // With explicit options
    h.nav.navigate({
      routerLink: "/a",
      routerAction: "push",
      routerDirection: "forward",
    });
    h.commitNavigation("/a");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("push");
    expect(h.nav.getCurrentRouteInfo()?.routerDirection).toBe("forward");

    // With defaults (routerAction defaults to "push")
    h.nav.navigate({ routerLink: "/b" });
    h.commitNavigation("/b");
    expect(h.nav.getCurrentRouteInfo()?.routerAction).toBe("push");
  });
});
