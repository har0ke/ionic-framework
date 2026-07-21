import * as contentModule from '../../../content';
import { enableScrollAssist } from '../scroll-assist';
import * as scrollDataModule from '../scroll-data';

/**
 * Covers the lifecycle of the pending scroll-assist work armed by
 * jsSetFocus when the input needs more scroll room than the content
 * offers (ionKeyboardDidShow listener + 1s fallback timeout): it must be
 * finished early - without scrolling or re-focusing - when the focus
 * session ends via blur or unmount, and the relocated input must always
 * be restored.
 *
 * Note: the module functions are stubbed with jest.spyOn (not jest.mock
 * factories) because the Stencil spec transformer does not hoist
 * jest.mock calls above the imports.
 */
describe('scroll assist: pending scroll work', () => {
  const SKIP_SCROLL_ASSIST = 'data-ionic-skip-scroll-assist';

  let componentEl: HTMLElement;
  let inputEl: HTMLInputElement;
  let contentEl: HTMLElement;
  let focusSpy: jest.SpyInstance;
  let scrollByPointSpy: jest.SpyInstance;
  let cleanup: (() => void) | undefined;

  const flushMicrotasks = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };

  const focusInput = () => componentEl.dispatchEvent(new Event('focusin'));
  const blurInput = () => componentEl.dispatchEvent(new Event('focusout'));
  const keyboardDidShow = () =>
    window.dispatchEvent(new CustomEvent('ionKeyboardDidShow', { detail: { keyboardHeight: 313 } }));

  /** Focus the input and let jsSetFocus arm its pending scroll work. */
  const focusAndArm = async () => {
    focusInput();
    await flushMicrotasks();
    /**
     * setManualFocus marks the input so the programmatic focus does not
     * re-run scroll assist. In a real browser the focus event consumes
     * the attribute right away; the mock environment does not dispatch
     * focus events, so consume it here to keep later focusin dispatches
     * realistic.
     */
    inputEl.removeAttribute(SKIP_SCROLL_ASSIST);
  };

  const clonedInput = () => componentEl.querySelector('.cloned-input');

  beforeEach(() => {
    jest.useFakeTimers();

    componentEl = document.createElement('div');
    inputEl = document.createElement('input') as HTMLInputElement;
    componentEl.appendChild(inputEl);
    contentEl = document.createElement('div');
    document.body.appendChild(componentEl);
    document.body.appendChild(contentEl);

    focusSpy = jest.spyOn(inputEl, 'focus').mockImplementation(() => {});

    jest.spyOn(scrollDataModule, 'getScrollData').mockReturnValue({
      scrollAmount: 200,
      scrollDuration: 300,
      scrollPadding: 0,
      inputSafeY: 0,
    });
    // No room to scroll: forces the "wait for resize" branch to arm.
    jest.spyOn(contentModule, 'getScrollElement').mockResolvedValue({
      scrollHeight: 100,
      clientHeight: 100,
      scrollTop: 0,
    } as any);
    scrollByPointSpy = jest.spyOn(contentModule, 'scrollByPoint').mockResolvedValue(undefined);

    cleanup = enableScrollAssist(componentEl, inputEl, contentEl, null, 290, false, undefined, false);
  });

  afterEach(() => {
    cleanup?.();
    componentEl.remove();
    contentEl.remove();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('relocates the input while waiting for the keyboard', async () => {
    await focusAndArm();

    expect(clonedInput()).not.toBeNull();
    expect(componentEl.style.pointerEvents).toBe('none');
  });

  it('completes the scroll and re-focuses while the session is active', async () => {
    await focusAndArm();
    const focusCallsAfterArm = focusSpy.mock.calls.length;

    keyboardDidShow();
    await flushMicrotasks();

    expect(scrollByPointSpy).toHaveBeenCalledTimes(1);
    expect(clonedInput()).toBeNull();
    expect(componentEl.style.pointerEvents).toBe('');
    expect(focusSpy.mock.calls.length).toBeGreaterThan(focusCallsAfterArm);
  });

  it('blur cancels the pending work: restores the input, never scrolls or re-focuses', async () => {
    await focusAndArm();
    const focusCallsAfterArm = focusSpy.mock.calls.length;

    blurInput();
    await flushMicrotasks();

    // Relocation is restored immediately at blur.
    expect(clonedInput()).toBeNull();
    expect(componentEl.style.pointerEvents).toBe('');

    // Neither the fallback timeout nor a late keyboard event may act.
    jest.advanceTimersByTime(1000);
    keyboardDidShow();
    await flushMicrotasks();

    expect(scrollByPointSpy).not.toHaveBeenCalled();
    expect(focusSpy.mock.calls.length).toBe(focusCallsAfterArm);
  });

  it('blur during the smooth scroll suppresses the re-focus', async () => {
    let resolveScroll!: () => void;
    scrollByPointSpy.mockImplementation(() => new Promise<void>((resolve) => (resolveScroll = resolve)));

    await focusAndArm();

    keyboardDidShow();
    await flushMicrotasks();
    expect(scrollByPointSpy).toHaveBeenCalledTimes(1);

    blurInput();
    const focusCallsAfterBlur = focusSpy.mock.calls.length;

    resolveScroll();
    await flushMicrotasks();

    expect(clonedInput()).toBeNull();
    expect(focusSpy.mock.calls.length).toBe(focusCallsAfterBlur);
  });

  it('blur racing the async arming gap still cleans up without arming', async () => {
    focusInput();
    // No microtask flush: blur before jsSetFocus passed its awaited
    // getScrollElement call, i.e. before any pending work was registered.
    blurInput();
    await flushMicrotasks();

    expect(clonedInput()).toBeNull();
    expect(componentEl.style.pointerEvents).toBe('');

    const focusCalls = focusSpy.mock.calls.length;
    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(scrollByPointSpy).not.toHaveBeenCalled();
    expect(focusSpy.mock.calls.length).toBe(focusCalls);
  });

  it('destroy cancels the pending work like a blur', async () => {
    await focusAndArm();
    const focusCallsAfterArm = focusSpy.mock.calls.length;

    cleanup?.();
    cleanup = undefined;
    await flushMicrotasks();

    expect(clonedInput()).toBeNull();
    expect(componentEl.style.pointerEvents).toBe('');

    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(scrollByPointSpy).not.toHaveBeenCalled();
    expect(focusSpy.mock.calls.length).toBe(focusCallsAfterArm);
  });

  it('re-focusing after a cancelled wait arms and completes again', async () => {
    await focusAndArm();
    blurInput();
    await flushMicrotasks();
    expect(clonedInput()).toBeNull();

    await focusAndArm();
    expect(clonedInput()).not.toBeNull();
    const focusCallsAfterArm = focusSpy.mock.calls.length;

    keyboardDidShow();
    await flushMicrotasks();

    expect(scrollByPointSpy).toHaveBeenCalledTimes(1);
    expect(clonedInput()).toBeNull();
    expect(focusSpy.mock.calls.length).toBeGreaterThan(focusCallsAfterArm);
  });
});
