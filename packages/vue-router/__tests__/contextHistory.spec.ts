import { createContextHistory } from "../src/contextHistory";
import type { PreparedPlan } from "../src/types";

/**
 * Helpers that mirror the old immediate APIs via prepare+commit.
 * Used by tests that verify navigation behavior through the public API.
 */
const commitPlan = (plan: PreparedPlan | null): string | null => {
  if (plan === null) return null;
  const entry = plan.commit({ pathname: plan.target.split("?")[0], search: plan.target.includes("?") ? plan.target.split("?")[1] : "" });
  return entry.search ? `${entry.pathname}?${entry.search}` : entry.pathname;
};

const doBack = (ctx: ReturnType<typeof createContextHistory>, defaultHref?: string): string | null => {
  return commitPlan(ctx.prepareBack(defaultHref));
};

const doForward = (ctx: ReturnType<typeof createContextHistory>): string | null => {
  return commitPlan(ctx.prepareForward());
};

const doGo = (ctx: ReturnType<typeof createContextHistory>, delta: number, defaultHref?: string): string | null => {
  return commitPlan(ctx.prepareGo(delta, defaultHref));
};

describe("Context History (registry + matching)", () => {
  it("default context exists: matchContext('/anything') === 'default'", () => {
    const ctx = createContextHistory();
    expect(ctx.matchContext("/anything")).toEqual("default");
  });

  it("registers a single tab prefix and matches exact + nested (trailing slash normalized)", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed/");

    expect(ctx.matchContext("/tabs/feed")).toEqual("feed");
    expect(ctx.matchContext("/tabs/feed/1")).toEqual("feed");
  });

  it("registers a single tab prefix and matches exact + nested (no trailing slash)", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");

    expect(ctx.matchContext("/tabs/feed")).toEqual("feed");
    expect(ctx.matchContext("/tabs/feed/1")).toEqual("feed");
  });

  it("chooses the longest matching prefix when multiple contexts overlap", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.registerContext("feed-settings", "/tabs/feed/settings");

    expect(ctx.matchContext("/tabs/feed/123")).toEqual("feed");
    expect(ctx.matchContext("/tabs/feed/settings")).toEqual("feed-settings");
    expect(ctx.matchContext("/tabs/feed/settings/profile")).toEqual("feed-settings");
  });

  it("boundary match: '/tabs/feed' does NOT match '/tabs/feedback'", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");

    expect(ctx.matchContext("/tabs/feedback")).toEqual("default");
  });

  it("re-registering the same id is a no-op", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.registerContext("feed", "/other");

    expect(ctx.matchContext("/tabs/feed")).toEqual("feed");
    expect(ctx.matchContext("/other")).toEqual("default");
  });

  it("unmatched route returns default", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");

    expect(ctx.matchContext("/does-not-match")).toEqual("default");
  });
});

describe("Context History (Chunk B stack operations)", () => {
  it("same-context push sets currentEntry pathname and context", () => {
    const ctx = createContextHistory();

    ctx.push("/login/");

    expect(ctx.currentEntry()?.pathname).toEqual("/login/");
    expect(ctx.currentEntry()?.context).toEqual("default");
  });

  it("cross-context push switches current entry context and sets originContext", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");

    ctx.push("/login/");
    ctx.push("/tabs/feed/");

    expect(ctx.currentEntry()?.pathname).toEqual("/tabs/feed/");
    expect(ctx.currentEntry()?.context).toEqual("feed");
    expect(ctx.currentEntry()?.originContext).toEqual("default");
  });

  it("cross-context push preserves default context entries", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.registerContext("discover", "/tabs/discover");

    ctx.push("/login/");
    ctx.push("/signup/");
    ctx.push("/tabs/feed/");
    ctx.push("/tabs/discover/");
    ctx.push("/login-new/");

    expect(ctx.currentEntry()?.pathname).toEqual("/login-new/");
    expect(ctx.currentEntry()?.context).toEqual("default");
    // Default context entries are preserved across cross-context pushes.
    // /login/, /signup/ still exist + /login-new/ at cursor.
    // root entry '/login/' != fallback '/' → offset 1 → effectiveDepth = 3
    expect(ctx.canGoBack(1)).toBe(true);
    expect(ctx.canGoBack(3)).toBe(true);
    expect(ctx.canGoBack(4)).toBe(false);
  });

  it("replace in same context updates pathname but keeps routerAnimation", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    const customAnimation = (() => undefined) as any;

    ctx.push("/tabs/feed/", { routerAnimation: customAnimation });
    ctx.replace("/tabs/feed/updated/");

    expect(ctx.currentEntry()?.pathname).toEqual("/tabs/feed/updated/");
    expect(ctx.currentEntry()?.routerAnimation).toBe(customAnimation);
  });

  it("replace cross-context behaves as push into target context", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.registerContext("discover", "/tabs/discover");

    ctx.push("/tabs/feed/");
    ctx.replace("/tabs/discover/profile/");

    expect(ctx.currentEntry()?.pathname).toEqual("/tabs/discover/profile/");
    expect(ctx.currentEntry()?.context).toEqual("discover");
    expect(ctx.currentEntry()?.originContext).toEqual("feed");
  });

  it("canGoBack accounts for cursor and fallback-to-default offset", () => {
    const ctx = createContextHistory();

    ctx.push("/a/");
    ctx.push("/b/");
    ctx.push("/c/");

    // cursor=2, root entry '/a/' != default '/' → offset=1 → effectiveDepth=3
    expect(ctx.canGoBack(1)).toBe(true);
    expect(ctx.canGoBack(2)).toBe(true);
    expect(ctx.canGoBack(3)).toBe(true);
    expect(ctx.canGoBack(4)).toBe(false);
    expect(ctx.canGoForward(1)).toBe(false);
  });

  it("canGoBack with rootHref matching root entry does not add offset", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.handleSetCurrentTab("feed", "/tabs/feed/");

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/page2/");

    // cursor=1, root entry matches rootHref → no offset → effectiveDepth=1
    expect(ctx.canGoBack(1)).toBe(true);
    expect(ctx.canGoBack(2)).toBe(false);
  });

  it("replace on empty stack delegates to push", () => {
    const ctx = createContextHistory();

    // Empty stack — replace should create a first entry via push
    const entry = ctx.replace("/a/");
    expect(entry.pathname).toBe("/a/");
    expect(ctx.currentEntry()?.pathname).toBe("/a/");

    // Now replace should overwrite in place
    const entry2 = ctx.replace("/b/");
    expect(entry2.pathname).toBe("/b/");
    expect(ctx.currentEntry()?.pathname).toBe("/b/");
    // Should still have only 1 entry (replaced, not pushed)
    expect(ctx.canGoBack(1)).toBe(true); // '/b/' != '/' → fallback offset
    expect(ctx.canGoBack(2)).toBe(false); // only 1 entry
  });

  it("canGoBack(0) and canGoForward(0) always return true", () => {
    const ctx = createContextHistory();

    // Empty stack — even with no entries, deep < 1 returns true
    expect(ctx.canGoBack(0)).toBe(true);
    expect(ctx.canGoForward(0)).toBe(true);

    ctx.push("/a/");
    expect(ctx.canGoBack(0)).toBe(true);
    expect(ctx.canGoForward(0)).toBe(true);
  });

  it("canGoBack and canGoForward with negative deep return true", () => {
    const ctx = createContextHistory();
    expect(ctx.canGoBack(-1)).toBe(true);
    expect(ctx.canGoForward(-1)).toBe(true);
  });

  it("canGoBack with rootHref not matching root entry adds offset", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.handleSetCurrentTab("feed", "/tabs/feed/");

    ctx.push("/tabs/feed/deep/");

    // cursor=0, root '/tabs/feed/deep/' != rootHref '/tabs/feed/' → offset=1
    expect(ctx.canGoBack(1)).toBe(true);
    expect(ctx.canGoBack(2)).toBe(false);
  });

  it("parses search without leading question mark", () => {
    const ctx = createContextHistory();

    ctx.push("/a/?q=1");
    expect(ctx.currentEntry()?.search).toBe("q=1");

    ctx.push({ pathname: "/b/", search: "?x=2" });
    expect(ctx.currentEntry()?.search).toBe("x=2");
  });
});

describe("Context History (Chunk C navigation algorithms)", () => {
  it("back decrements cursor within context", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/details/");

    expect(doBack(ctx)).toBe("/tabs/feed/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
  });

  it("back at cursor 0 with rootHref matching current entry blocks", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.handleSetCurrentTab("feed", "/tabs/feed/");

    ctx.push("/tabs/feed/");

    // Already at tab root → blocked
    expect(doBack(ctx)).toBeNull();
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
  });

  it("back at cursor 0 falls back to rootHref for deep-linked tab page", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.handleSetCurrentTab("feed", "/tabs/feed/");

    ctx.push("/tabs/feed/deep/");

    // Deep-linked page backs to tab root
    expect(doBack(ctx)).toBe("/tabs/feed/");
  });

  it("back tab context ignores passed defaultHref (rootHref wins)", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.handleSetCurrentTab("feed", "/tabs/feed/");

    ctx.push("/tabs/feed/deep/");

    // rootHref wins — defaultHref is ignored in tab contexts
    expect(doBack(ctx, "/other/")).toBe("/tabs/feed/");
  });

  it("back at cursor 0 in non-tab context uses defaultHref", () => {
    const ctx = createContextHistory();

    ctx.push("/deep-link/");

    // Non-tab: no rootHref, falls through to defaultHref
    expect(doBack(ctx, "/home/")).toBe("/home/");
  });

  it("back at cursor 0 in non-tab context defaults to /", () => {
    const ctx = createContextHistory();

    ctx.push("/deep-link/");

    // Non-tab, no defaultHref → falls back to '/'
    expect(doBack(ctx)).toBe("/");
  });

  it("back at cursor 0 blocks when already at default target", () => {
    const ctx = createContextHistory();

    ctx.push("/");

    // Already at '/' → blocked
    expect(doBack(ctx)).toBeNull();
  });

  it("forward advances once and returns null at top", () => {
    const ctx = createContextHistory();

    ctx.push("/a/");
    ctx.push("/b/");
    ctx.push("/c/");

    doBack(ctx);
    expect(ctx.currentEntry()?.pathname).toBe("/b/");

    expect(doForward(ctx)).toBe("/c/");
    expect(doForward(ctx)).toBeNull();
  });

  it("back and forward preserve query parameters in returned paths", () => {
    const ctx = createContextHistory();

    ctx.push("/a/?q=1");
    ctx.push("/b/?q=2");

    expect(doBack(ctx)).toBe("/a/?q=1");
    expect(doForward(ctx)).toBe("/b/?q=2");
  });

  it("go(-1) and go(-N) move back with partial completion semantics", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.handleSetCurrentTab("feed", "/tabs/feed/");

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/one/");
    ctx.push("/tabs/feed/two/");

    expect(doGo(ctx, -1)).toBe("/tabs/feed/one/");
    // At cursor 0, rootHref matches root entry → back returns null → stops
    expect(doGo(ctx, -5)).toBe("/tabs/feed/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
  });

  it("go(-N) returns null with no mutation when first step is blocked", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.handleSetCurrentTab("feed", "/tabs/feed/");

    ctx.push("/tabs/feed/");

    // At tab root with matching rootHref → blocked on first step
    expect(doGo(ctx, -1)).toBeNull();
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
  });

  it("go(+N) replays forward and returns null when no movement", () => {
    const ctx = createContextHistory();

    ctx.push("/a/");
    ctx.push("/b/");
    ctx.push("/c/");

    expect(doGo(ctx, -2)).toBe("/a/");
    expect(doGo(ctx, 10)).toBe("/c/");
    expect(doGo(ctx, 1)).toBeNull();
  });

  it("go returns full path including query parameters", () => {
    const ctx = createContextHistory();

    ctx.push("/a/?q=1");
    ctx.push("/b/?q=2");
    ctx.push("/c/?q=3");

    expect(doGo(ctx, -2)).toBe("/a/?q=1");
    expect(doGo(ctx, 1)).toBe("/b/?q=2");
  });
});

describe("Context History (Chunk D tab/reset/snapshot/output)", () => {
  it("changeTab synthesizes first entry for empty context and resumes existing stacks", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    // Set rootHref so tab root back is terminal
    ctx.handleSetCurrentTab("feed", "/tabs/feed/");

    expect(ctx.changeTab("feed", "/tabs/feed/")).toBe("/tabs/feed/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
    // Tab root matches rootHref → canGoBack is false
    expect(ctx.canGoBack(1)).toBe(false);

    ctx.push("/tabs/feed/page2/");
    ctx.push("/login/");

    expect(ctx.changeTab("feed", "/tabs/feed/")).toBe("/tabs/feed/page2/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/page2/");
  });

  it("tab round-trip: tabA -> tabB -> tabA preserves cursor positions", () => {
    const ctx = createContextHistory();
    ctx.registerContext("tabA", "/tabs/tabA");
    ctx.registerContext("tabB", "/tabs/tabB");
    ctx.handleSetCurrentTab("tabA", "/tabs/tabA/");
    ctx.handleSetCurrentTab("tabB", "/tabs/tabB/");

    // Navigate in tab A
    ctx.push("/tabs/tabA/");
    ctx.push("/tabs/tabA/detail/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/tabA/detail/");

    // Switch to tab B
    expect(ctx.changeTab("tabB", "/tabs/tabB/")).toBe("/tabs/tabB/");
    ctx.push("/tabs/tabB/settings/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/tabB/settings/");

    // Switch back to tab A — should resume at detail
    expect(ctx.changeTab("tabA", "/tabs/tabA/")).toBe("/tabs/tabA/detail/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/tabA/detail/");
    expect(ctx.canGoBack(1)).toBe(true);

    // Switch back to tab B — should resume at settings
    expect(ctx.changeTab("tabB", "/tabs/tabB/")).toBe("/tabs/tabB/settings/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/tabB/settings/");
    expect(ctx.canGoBack(1)).toBe(true);
  });

  it("resetTab resets active tab to root and returns null for inactive tab", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.handleSetCurrentTab("feed", "/tabs/feed/");

    ctx.push("/login/");
    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/page2/");

    expect(ctx.resetTab("feed", "/tabs/feed/")).toBe("/tabs/feed/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/");
    // Tab root matches rootHref → back is blocked
    expect(doBack(ctx)).toBeNull();

    ctx.push("/login/again/");
    expect(ctx.resetTab("feed", "/tabs/feed/")).toBeNull();
    expect(ctx.changeTab("feed", "/tabs/feed/")).toBe("/tabs/feed/");
    expect(ctx.canGoBack(1)).toBe(false);
  });

  it("resetAll clears stacks and creates a fresh entry in matched target context", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.handleSetCurrentTab("feed", "/tabs/feed/");

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/page/");
    ctx.push("/login/");

    expect(ctx.resetAll("/login/")).toBe("/login/");
    expect(ctx.currentEntry()?.pathname).toBe("/login/");
    // Default context: '/login/' != '/' → canGoBack(1) is true (fallback to '/')
    expect(ctx.canGoBack(1)).toBe(true);

    expect(ctx.changeTab("feed", "/tabs/feed/")).toBe("/tabs/feed/");
    // Tab root matches rootHref → canGoBack is false
    expect(ctx.canGoBack(1)).toBe(false);
  });

  it("getRetainedPathnames returns entries up to cursor across all contexts", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/page2/");
    ctx.push("/login/");
    ctx.push("/signup/");

    expect(doGo(ctx, -1)).toBe("/login/");

    expect(Array.from(ctx.getRetainedPathnames()).sort()).toEqual([
      "/login/",
      "/tabs/feed/",
      "/tabs/feed/page2/",
    ]);
  });

  it("derivePushedByRoute returns previous entry, implicit default, or undefined", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");

    // Default context at cursor 0: root entry '/a/' !== implicit default '/'
    // → derivePushedByRoute returns '/' (the implicit default)
    ctx.push("/a/");
    expect(ctx.derivePushedByRoute()).toBe("/");

    ctx.push("/b/");
    // cursor > 0 → previous entry
    expect(ctx.derivePushedByRoute()).toBe("/a/");

    ctx.push("/tabs/feed/");
    // Switched to feed context. Set rootHref so tab root is recognized.
    ctx.handleSetCurrentTab("feed", "/tabs/feed/");
    // At tab root with rootHref matching → back is blocked → undefined
    expect(ctx.derivePushedByRoute()).toBeUndefined();

    ctx.push("/tabs/feed/page2/");
    // cursor > 0 → previous entry
    expect(ctx.derivePushedByRoute()).toBe("/tabs/feed/");
  });

  it("derivePushedByRoute returns undefined when root entry matches implicit default", () => {
    const ctx = createContextHistory();

    // Default context: push '/' as root. Implicit default is '/'.
    // Root entry matches → back is blocked → undefined
    ctx.push("/");
    expect(ctx.derivePushedByRoute()).toBeUndefined();

    // Push something else, then go back to cursor 0
    ctx.push("/a/");
    expect(ctx.derivePushedByRoute()).toBe("/");
  });

  it("produceCurrentRouteInfo maps fields and applies animation precedence", () => {
    const ctx = createContextHistory();
    const enteringAnimation = (() => undefined) as any;
    const leavingAnimation = (() => undefined) as any;
    const overrideAnimation = (() => undefined) as any;

    ctx.push("/a/");
    const entering = ctx.push("/b/", { routerAnimation: enteringAnimation });

    const leaving = {
      id: "leave",
      pathname: "/a/",
      search: "",
      params: undefined,
      pushedByRoute: undefined,
      routerAction: "push",
      routerDirection: "forward",
      routerAnimation: leavingAnimation,
      lastPathname: "/root/",
      prevRouteLastPathname: "/older/",
      delta: undefined,
      tab: "default",
    } as any;

    const backInfo = ctx.produceCurrentRouteInfo(entering, leaving, { direction: "back" });
    expect(backInfo.routerAction).toBe("pop");
    expect(backInfo.routerDirection).toBe("back");
    expect(backInfo.routerAnimation).toBe(leavingAnimation);
    expect(backInfo.lastPathname).toBe("/a/");
    expect(backInfo.prevRouteLastPathname).toBe("/root/");
    expect(backInfo.tab).toBe("default");
    expect(backInfo.delta).toBeUndefined();

    const rootInfo = ctx.produceCurrentRouteInfo(entering, leaving, { direction: "root" });
    expect(rootInfo.routerAction).toBe("replace");
    expect(rootInfo.routerDirection).toBe("root");

    const noneInfo = ctx.produceCurrentRouteInfo(entering, leaving, { direction: "none" });
    expect(noneInfo.routerAction).toBe("push");

    const overrideInfo = ctx.produceCurrentRouteInfo(entering, leaving, {
      direction: "none",
      animation: overrideAnimation,
      action: "replace",
    } as any);
    expect(overrideInfo.routerAction).toBe("replace");
    expect(overrideInfo.routerAnimation).toBe(overrideAnimation);
  });

  it("handleSetCurrentTab registers context, moves matching default entries, and is idempotent", () => {
    const ctx = createContextHistory();

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/page2/");
    ctx.push("/login/");
    doGo(ctx, -1);

    ctx.handleSetCurrentTab("feed", "/tabs/feed/");
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/page2/");
    expect(ctx.currentEntry()?.context).toBe("feed");
    expect(doBack(ctx)).toBe("/tabs/feed/");

    const before = JSON.stringify(ctx.snapshot());
    ctx.handleSetCurrentTab("feed", "/tabs/feed/");
    expect(JSON.stringify(ctx.snapshot())).toBe(before);
  });

  it("snapshot returns expected structure and backTarget links", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");

    ctx.push("/tabs/feed/");
    ctx.push("/tabs/feed/page2/");
    ctx.push("/login/");

    const snap = ctx.snapshot();

    expect(snap.activeContext).toBe("default");
    expect(snap.contexts.feed.entries[0].url).toBe("/tabs/feed/");
    expect(snap.contexts.feed.entries[0].backTarget).toBeNull();
    expect(snap.contexts.feed.entries[1].backTarget).toEqual({ context: "feed", cursor: 0 });
    // Default context entry at cursor 0: back is blocked (no previous-context)
    expect(snap.contexts.default.entries[0].url).toBe("/login/");
    expect(snap.contexts.default.entries[0].backTarget).toBeNull();
  });
});

describe("Context History (Chunk E prepared navigation plans)", () => {
  it("prepareBack returns null when blocked, plan when cursor > 0", () => {
    const ctx = createContextHistory();
    ctx.push("/");

    // At cursor 0 with root entry '/' matching implicit default '/' → blocked
    expect(ctx.prepareBack()).toBeNull();

    ctx.push("/a");
    ctx.push("/b");

    // cursor 2 → prepareBack should produce a plan targeting '/a'
    const plan = ctx.prepareBack();
    expect(plan).not.toBeNull();
    expect(plan!.transport).toBe("replace");
    expect(plan!.target).toBe("/a");
    expect(plan!.direction).toBe("back");
    expect(plan!.action).toBe("pop");
    expect(plan!.expectedComparableTarget).toBe("/a");

    // State should NOT be mutated yet
    expect(ctx.currentEntry()?.pathname).toBe("/b");

    // Commit the plan
    const entry = plan!.commit({ pathname: "/a", search: "" });
    expect(entry.pathname).toBe("/a");
    expect(ctx.currentEntry()?.pathname).toBe("/a");
  });

  it("prepareBack with fallback-to-default at cursor 0", () => {
    const ctx = createContextHistory();
    ctx.push("/deep-link");

    // cursor 0, root entry '/deep-link' != implicit default '/' → fallback
    const plan = ctx.prepareBack();
    expect(plan).not.toBeNull();
    expect(plan!.target).toBe("/");
    expect(plan!.action).toBe("pop");

    // State not mutated
    expect(ctx.currentEntry()?.pathname).toBe("/deep-link");

    // Commit replaces the entry at cursor 0
    const entry = plan!.commit({ pathname: "/", search: "" });
    expect(entry.pathname).toBe("/");
    expect(ctx.currentEntry()?.pathname).toBe("/");
  });

  it("prepareBack with tab rootHref fallback", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.push("/tabs/feed/detail");
    ctx.handleSetCurrentTab("feed", "/tabs/feed");

    const plan = ctx.prepareBack();
    expect(plan).not.toBeNull();
    expect(plan!.target).toBe("/tabs/feed");

    // Passing defaultHref should not override rootHref
    const plan2 = ctx.prepareBack("/other");
    expect(plan2!.target).toBe("/tabs/feed");
  });

  it("prepareForward returns null at end, plan when forward exists", () => {
    const ctx = createContextHistory();
    ctx.push("/a");
    ctx.push("/b");
    ctx.push("/c");
    doBack(ctx); // cursor 2 → 1

    const plan = ctx.prepareForward();
    expect(plan).not.toBeNull();
    expect(plan!.transport).toBe("replace");
    expect(plan!.target).toBe("/c");
    expect(plan!.direction).toBe("forward");

    // State not mutated
    expect(ctx.currentEntry()?.pathname).toBe("/b");

    plan!.commit({ pathname: "/c", search: "" });
    expect(ctx.currentEntry()?.pathname).toBe("/c");

    // At end → null
    expect(ctx.prepareForward()).toBeNull();
  });

  it("prepareGo simulates multi-step back and forward", () => {
    const ctx = createContextHistory();
    ctx.push("/a");
    ctx.push("/b");
    ctx.push("/c");
    ctx.push("/d");

    // Go back 2 steps
    const backPlan = ctx.prepareGo(-2);
    expect(backPlan).not.toBeNull();
    expect(backPlan!.target).toBe("/b");
    expect(backPlan!.direction).toBe("back");
    expect(ctx.currentEntry()?.pathname).toBe("/d"); // not mutated

    backPlan!.commit({ pathname: "/b", search: "" });
    expect(ctx.currentEntry()?.pathname).toBe("/b");

    // Go forward 2 steps
    const fwdPlan = ctx.prepareGo(2);
    expect(fwdPlan).not.toBeNull();
    expect(fwdPlan!.target).toBe("/d");
    expect(fwdPlan!.direction).toBe("forward");
    expect(ctx.currentEntry()?.pathname).toBe("/b"); // not mutated

    fwdPlan!.commit({ pathname: "/d", search: "" });
    expect(ctx.currentEntry()?.pathname).toBe("/d");

    // Go back 0 → null
    expect(ctx.prepareGo(0)).toBeNull();
  });

  it("prepareGo returns null when first step is blocked", () => {
    const ctx = createContextHistory();
    ctx.push("/");
    // At '/' which matches default → back blocked
    expect(ctx.prepareGo(-1)).toBeNull();
    // No forward entries
    expect(ctx.prepareGo(1)).toBeNull();
  });

  it("prepareChangeTab returns a plan that synthesizes an entry for empty tab", () => {
    const ctx = createContextHistory();
    ctx.push("/home");

    const plan = ctx.prepareChangeTab("feed", "/tabs/feed");
    expect(plan.transport).toBe("push");
    expect(plan.target).toBe("/tabs/feed");
    expect(plan.direction).toBe("none");

    // State not mutated (still in default context)
    expect(ctx.currentEntry()?.pathname).toBe("/home");

    const entry = plan.commit({ pathname: "/tabs/feed", search: "" });
    expect(entry.pathname).toBe("/tabs/feed");
    expect(entry.context).toBe("feed");
  });

  it("prepareChangeTab returns existing tab entry if tab has history", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.push("/tabs/feed");
    ctx.push("/tabs/feed/detail");
    ctx.push("/other");

    const plan = ctx.prepareChangeTab("feed", "/tabs/feed");
    // Tab has history, cursor at 1 → target is '/tabs/feed/detail'
    expect(plan.target).toBe("/tabs/feed/detail");
  });

  it("prepareResetTab returns plan for active tab and commits reset to root", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.push("/tabs/feed");
    ctx.push("/tabs/feed/page2");

    // push into /tabs/feed matches feed context, so activeContext is 'feed'
    const plan = ctx.prepareResetTab("feed", "/tabs/feed");
    expect(plan).not.toBeNull();
    expect(plan!.transport).toBe("replace");
    expect(plan!.target).toBe("/tabs/feed");
    expect(plan!.direction).toBe("back");

    // Not mutated
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed/page2");

    plan!.commit({ pathname: "/tabs/feed", search: "" });
    expect(ctx.currentEntry()?.pathname).toBe("/tabs/feed");
    expect(ctx.canGoForward()).toBe(false); // entries truncated to root
  });

  it("prepareResetAll returns a plan that clears all stacks", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed");
    ctx.push("/tabs/feed");
    ctx.push("/tabs/feed/page2");
    ctx.push("/other");

    const plan = ctx.prepareResetAll("/login");
    expect(plan.transport).toBe("replace");
    expect(plan.target).toBe("/login");
    expect(plan.direction).toBe("root");
    expect(plan.action).toBe("replace");

    // Not mutated
    expect(ctx.currentEntry()?.pathname).toBe("/other");

    plan.commit({ pathname: "/login", search: "" });
    expect(ctx.currentEntry()?.pathname).toBe("/login");
    // After resetAll to '/login': root entry is '/login', implicit default
    // is '/' → canGoBack is true (back would go to '/' via fallback)
    expect(ctx.canGoBack()).toBe(true);

    // Tab context should be cleared
    const snap = ctx.snapshot();
    expect(snap.contexts.feed?.entries.length ?? 0).toBe(0);
  });

  it("abandoned plan (prepare without commit) leaves state unchanged", () => {
    const ctx = createContextHistory();
    ctx.push("/a");
    ctx.push("/b");

    // Prepare a back plan but never commit it
    const plan = ctx.prepareBack();
    expect(plan).not.toBeNull();
    expect(plan!.target).toBe("/a");

    // State unchanged
    expect(ctx.currentEntry()?.pathname).toBe("/b");
    expect(ctx.canGoBack(1)).toBe(true);

    // Subsequent operations still work correctly
    ctx.push("/c");
    expect(ctx.currentEntry()?.pathname).toBe("/c");

    // A new prepare+commit works correctly
    const plan2 = ctx.prepareBack();
    expect(plan2).not.toBeNull();
    plan2!.commit({ pathname: "/b", search: "" });
    expect(ctx.currentEntry()?.pathname).toBe("/b");
  });

  it("double commit is a no-op via generation counter", () => {
    const ctx = createContextHistory();
    ctx.push("/a");
    ctx.push("/b");
    ctx.push("/c");

    const plan = ctx.prepareBack();
    expect(plan).not.toBeNull();

    // First commit succeeds
    const entry1 = plan!.commit({ pathname: "/b", search: "" });
    expect(entry1.pathname).toBe("/b");
    expect(ctx.currentEntry()?.pathname).toBe("/b");

    // Second commit is a no-op — returns current entry without mutation
    const entry2 = plan!.commit({ pathname: "/b", search: "" });
    expect(entry2.pathname).toBe("/b");
    expect(ctx.currentEntry()?.pathname).toBe("/b");

    // State is still consistent — forward should work
    expect(doForward(ctx)).toBe("/c");
  });

  it("stale plan commit is a no-op when a newer plan exists", () => {
    const ctx = createContextHistory();
    ctx.push("/a");
    ctx.push("/b");
    ctx.push("/c");

    const oldPlan = ctx.prepareBack();
    expect(oldPlan).not.toBeNull();

    // Prepare a newer plan (bumps generation), making oldPlan stale
    const newPlan = ctx.prepareBack();
    expect(newPlan).not.toBeNull();

    // Even committing oldPlan first is blocked — it's stale because
    // a newer plan was prepared (gen < prepareGeneration)
    const staleEntry = oldPlan!.commit({ pathname: "/b", search: "" });
    expect(staleEntry.pathname).toBe("/c"); // returns current entry, no mutation
    expect(ctx.currentEntry()?.pathname).toBe("/c"); // unchanged

    // The newer plan commits successfully
    newPlan!.commit({ pathname: "/b", search: "" });
    expect(ctx.currentEntry()?.pathname).toBe("/b");
  });
});
