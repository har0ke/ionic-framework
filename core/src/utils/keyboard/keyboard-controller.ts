import { doc, win } from '@utils/browser';
import { printIonWarning } from '@utils/logging';

import { Keyboard, KeyboardResize } from '../native/keyboard';

/**
 * The webview resize that follows a keyboard hide is detected by the
 * container returning to the height it had before the keyboard opened.
 * `clientHeight` rounds to whole CSS pixels, so fractional device pixel
 * ratios can leave the settled height off by a pixel — allow a small
 * tolerance instead of requiring an exact match.
 */
const RESIZE_CONTAINER_HEIGHT_TOLERANCE = 2;

/**
 * Safety net for the resize promise: if the container never returns to the
 * expected height (e.g. the device rotated while the keyboard was open, or a
 * native overlay changed the webview frame), the promise resolves after this
 * delay instead of leaving consumers such as ion-tab-bar and ion-footer
 * blocked forever.
 */
const RESIZE_PROMISE_TIMEOUT_MS = 700;

/**
 * The element that resizes when the keyboard opens
 * is going to depend on the resize mode
 * which is why we check that here.
 */
const getResizeContainer = (resizeMode?: KeyboardResize): HTMLElement | null => {
  /**
   * If doc is undefined then we are
   * in an SSR environment, so the keyboard
   * adjustment does not apply.
   * If the webview does not resize then there
   * is no container to resize.
   */
  if (doc === undefined || resizeMode === KeyboardResize.None || resizeMode === undefined) {
    return null;
  }

  /**
   * The three remaining resize modes: Native, Ionic, and Body
   * all cause `ion-app` to resize, so we can listen for changes
   * on that. In the event `ion-app` is not available then
   * we can fall back to `body`.
   */
  const ionApp = doc.querySelector('ion-app');

  return ionApp ?? doc.body;
};

/**
 * Get the height of ion-app or body.
 * This is used for determining if the webview
 * has resized before the keyboard closed.
 * */
const getResizeContainerHeight = (resizeMode?: KeyboardResize) => {
  const containerElement = getResizeContainer(resizeMode);

  return containerElement === null ? 0 : containerElement.clientHeight;
};

/**
 * Creates a controller that tracks and reacts to opening or closing the keyboard.
 *
 * @internal
 * @param keyboardChangeCallback A function to call when the keyboard opens or closes.
 */
export const createKeyboardController = async (
  keyboardChangeCallback?: (keyboardOpen: boolean, resizePromise?: Promise<void>) => void
): Promise<KeyboardController> => {
  let keyboardWillShowHandler: (() => void) | undefined;
  let keyboardWillHideHandler: (() => void) | undefined;
  let keyboardVisible = false;
  /**
   * This lets us determine if the webview content
   * has resized as a result of the keyboard.
   */
  let initialResizeContainerHeight: number;

  const init = async () => {
    const resizeOptions = await Keyboard.getResizeMode();
    const resizeMode = resizeOptions === undefined ? undefined : resizeOptions.mode;

    keyboardWillShowHandler = () => {
      /**
       * We need to compute initialResizeContainerHeight right before
       * the keyboard opens to guarantee the resize container is visible.
       * The resize container may not be visible if we compute this
       * as soon as the keyboard controller is created.
       * We re-capture it on every keyboard show while the keyboard is
       * closed so the baseline follows rotations and other window size
       * changes. The `keyboardVisible` gate keeps additional
       * keyboardWillShow events fired while the keyboard is already open
       * (e.g. keyboard geometry changes) from capturing a shrunken height.
       */
      if (!keyboardVisible) {
        initialResizeContainerHeight = getResizeContainerHeight(resizeMode);
      }

      keyboardVisible = true;
      fireChangeCallback(keyboardVisible, resizeMode);
    };

    keyboardWillHideHandler = () => {
      keyboardVisible = false;
      fireChangeCallback(keyboardVisible, resizeMode);
    };

    win?.addEventListener('keyboardWillShow', keyboardWillShowHandler);
    win?.addEventListener('keyboardWillHide', keyboardWillHideHandler);
  };

  const fireChangeCallback = (state: boolean, resizeMode: KeyboardResize | undefined) => {
    if (keyboardChangeCallback) {
      keyboardChangeCallback(state, createResizePromiseIfNeeded(resizeMode));
    }
  };

  /**
   * Code responding to keyboard lifecycles may need
   * to show/hide content once the webview has
   * resized as a result of the keyboard showing/hiding.
   * createResizePromiseIfNeeded provides a way for code to wait for the
   * resize event that was triggered as a result of the keyboard.
   */
  const createResizePromiseIfNeeded = (resizeMode: KeyboardResize | undefined): Promise<void> | undefined => {
    if (
      /**
       * If we are in an SSR environment then there is
       * no window to resize. Additionally, if there
       * is no resize mode or the resize mode is "None"
       * then initialResizeContainerHeight will be 0
       */
      initialResizeContainerHeight === 0 ||
      /**
       * If the keyboard is closed before the webview resizes initially
       * then the webview will never resize.
       */
      initialResizeContainerHeight === getResizeContainerHeight(resizeMode)
    ) {
      return;
    }

    /**
     * Get the resize container so we can
     * attach the ResizeObserver below to
     * the correct element.
     */
    const containerElement = getResizeContainer(resizeMode);
    if (containerElement === null) {
      return;
    }

    /**
     * Some part of the web content should resize,
     * and we need to listen for a resize.
     */
    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      /**
       * Single exit for every way the wait can end (height restored or
       * safety timeout): stop observing, clear the pending timer and
       * resolve. Never leaves a ResizeObserver or timer behind.
       */
      const done = () => {
        ro.disconnect();
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        resolve();
      };

      const callback = () => {
        /**
         * As per the spec, the ResizeObserver
         * will fire when observation starts if
         * the observed element is rendered and does not
         * have a size of 0 x 0. However, the watched element
         * may or may not have resized by the time this first
         * callback is fired. As a result, we need to check
         * the dimensions of the element.
         *
         * https://www.w3.org/TR/resize-observer/#intro
         */
        if (
          Math.abs(containerElement.clientHeight - initialResizeContainerHeight) <= RESIZE_CONTAINER_HEIGHT_TOLERANCE
        ) {
          /**
           * The resize happened, so stop listening
           * for resize on this element.
           */
          done();
        }
      };

      /**
       * In Capacitor there can be delay between when the window
       * resizes and when the container element resizes, so we cannot
       * rely on a 'resize' event listener on the window.
       * Instead, we need to determine when the container
       * element resizes using a ResizeObserver.
       */
      const ro = new ResizeObserver(callback);
      ro.observe(containerElement);

      /**
       * The container may never return to the expected height, for example
       * when the device rotated while the keyboard was open or when a
       * native overlay changed the webview frame while it was covered.
       * Resolve after a bounded delay so consumers awaiting this promise
       * are never blocked indefinitely.
       */
      timeoutId = setTimeout(() => {
        printIonWarning(
          '[keyboard-controller] - The resize container did not return to its expected height within the timeout; resolving the resize wait anyway.',
          {
            expectedHeight: initialResizeContainerHeight,
            currentHeight: containerElement.clientHeight,
          }
        );
        done();
      }, RESIZE_PROMISE_TIMEOUT_MS);
    });
  };

  const destroy = () => {
    win?.removeEventListener('keyboardWillShow', keyboardWillShowHandler!);
    win?.removeEventListener('keyboardWillHide', keyboardWillHideHandler!);

    keyboardWillShowHandler = keyboardWillHideHandler = undefined;
  };

  const isKeyboardVisible = () => keyboardVisible;

  await init();
  return { init, destroy, isKeyboardVisible };
};

export type KeyboardController = {
  init: () => void;
  destroy: () => void;
  isKeyboardVisible: () => boolean;
};
