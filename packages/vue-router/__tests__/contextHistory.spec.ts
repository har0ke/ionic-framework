import { createContextHistory } from "../src/contextHistory";
import type { ContextConfig } from "../src/types";

const tabConfig: ContextConfig = {
  backBehavior: "within-context",
  rootBackBehavior: "block",
  clearOnExternalPush: false,
  unmatchedBehavior: "default",
};

describe("Context History (registry + matching)", () => {
  it("default context exists: matchContext('/anything') === 'default'", () => {
    const ctx = createContextHistory();
    expect(ctx.matchContext("/anything")).toEqual("default");
  });

  it("registers a single tab prefix and matches exact + nested (trailing slash normalized)", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed/", tabConfig);

    expect(ctx.matchContext("/tabs/feed")).toEqual("feed");
    expect(ctx.matchContext("/tabs/feed/1")).toEqual("feed");
  });

  it("registers a single tab prefix and matches exact + nested (no trailing slash)", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    expect(ctx.matchContext("/tabs/feed")).toEqual("feed");
    expect(ctx.matchContext("/tabs/feed/1")).toEqual("feed");
  });

  it("chooses the longest matching prefix when multiple contexts overlap", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.registerContext("feed-settings", "/tabs/feed/settings", tabConfig);

    expect(ctx.matchContext("/tabs/feed/123")).toEqual("feed");
    expect(ctx.matchContext("/tabs/feed/settings")).toEqual("feed-settings");
    expect(ctx.matchContext("/tabs/feed/settings/profile")).toEqual("feed-settings");
  });

  it("boundary match: '/tabs/feed' does NOT match '/tabs/feedback'", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    expect(ctx.matchContext("/tabs/feedback")).toEqual("default");
  });

  it("re-registering the same id is a no-op", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.registerContext("feed", "/other", {
      ...tabConfig,
      unmatchedBehavior: "active",
    });

    expect(ctx.matchContext("/tabs/feed")).toEqual("feed");
    expect(ctx.matchContext("/other")).toEqual("default");
  });

  it("unmatched route returns default", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

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
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    ctx.push("/login/");
    ctx.push("/tabs/feed/");

    expect(ctx.currentEntry()?.pathname).toEqual("/tabs/feed/");
    expect(ctx.currentEntry()?.context).toEqual("feed");
    expect(ctx.currentEntry()?.originContext).toEqual("default");
  });

  it("clearOnExternalPush true clears target context before push", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.registerContext("discover", "/tabs/discover", tabConfig);

    ctx.push("/login/");
    ctx.push("/signup/");
    ctx.push("/tabs/feed/");
    ctx.push("/tabs/discover/");
    ctx.push("/login-new/");

    expect(ctx.currentEntry()?.pathname).toEqual("/login-new/");
    expect(ctx.currentEntry()?.context).toEqual("default");
    expect(ctx.canGoBack(1)).toBe(false);
  });

  it("replace in same context updates pathname but keeps routerAnimation", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    const customAnimation = (() => undefined) as any;

    ctx.push("/tabs/feed/", { routerAnimation: customAnimation });
    ctx.replace("/tabs/feed/updated/");

    expect(ctx.currentEntry()?.pathname).toEqual("/tabs/feed/updated/");
    expect(ctx.currentEntry()?.routerAnimation).toBe(customAnimation);
  });

  it("replace in same context inherits entry overrides unless explicitly overridden", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);

    ctx.push("/tabs/feed/", {
      backBehavior: "previous-context",
      rootBackBehavior: "previous-context",
    });
    ctx.replace("/tabs/feed/updated/");

    expect(ctx.currentEntry()?.backBehavior).toEqual("previous-context");
    expect(ctx.currentEntry()?.rootBackBehavior).toEqual("previous-context");

    ctx.replace("/tabs/feed/updated-again/", {
      backBehavior: "within-context",
      rootBackBehavior: "block",
    });

    expect(ctx.currentEntry()?.backBehavior).toEqual("within-context");
    expect(ctx.currentEntry()?.rootBackBehavior).toEqual("block");
  });

  it("replace cross-context behaves as push into target context", () => {
    const ctx = createContextHistory();
    ctx.registerContext("feed", "/tabs/feed", tabConfig);
    ctx.registerContext("discover", "/tabs/discover", tabConfig);

    ctx.push("/tabs/feed/");
    ctx.replace("/tabs/discover/profile/");

    expect(ctx.currentEntry()?.pathname).toEqual("/tabs/discover/profile/");
    expect(ctx.currentEntry()?.context).toEqual("discover");
    expect(ctx.currentEntry()?.originContext).toEqual("feed");
  });

  it("canGoBack and canGoForward use cursor bounds", () => {
    const ctx = createContextHistory();

    ctx.push("/a/");
    ctx.push("/b/");
    ctx.push("/c/");

    expect(ctx.canGoBack(1)).toBe(true);
    expect(ctx.canGoBack(2)).toBe(true);
    expect(ctx.canGoBack(3)).toBe(false);
    expect(ctx.canGoForward(1)).toBe(false);
  });

  it("parses search without leading question mark", () => {
    const ctx = createContextHistory();

    ctx.push("/a/?q=1");
    expect(ctx.currentEntry()?.search).toBe("q=1");

    ctx.push({ pathname: "/b/", search: "?x=2" });
    expect(ctx.currentEntry()?.search).toBe("x=2");
  });
});
