import { useSyncExternalStore } from 'react';

/**
 * Progressive Web App plumbing: service worker lifecycle, install prompt and
 * standalone/offline detection.
 *
 * All of it degrades to a no-op when the app is opened as a plain page from a
 * file:// URL or an insecure origin, which is how the single-file build is
 * often used.
 */

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

/** iOS Safari exposes standalone mode here instead of via display-mode. */
interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

export interface PwaStatus {
  /** A Chromium install prompt has been captured and can be shown. */
  canPrompt: boolean;
  /** Running from a home screen icon / installed app window. */
  standalone: boolean;
  /** iOS or iPadOS, where installing is a manual Share > Add to Home Screen. */
  isIos: boolean;
  /** Service workers are usable here at all (secure context, not file://). */
  supported: boolean;
  /** A newer build has been downloaded and is waiting to take over. */
  updateReady: boolean;
  /** The device reports no network connection. */
  online: boolean;
}

const DISPLAY_MODE_QUERIES = ['standalone', 'minimal-ui', 'fullscreen'];

const isIos = (): boolean => {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports a desktop Safari UA, distinguishable by touch points.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
};

const isStandalone = (): boolean =>
  DISPLAY_MODE_QUERIES.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches) ||
  (navigator as NavigatorWithStandalone).standalone === true;

const serviceWorkerSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext;

let status: PwaStatus = {
  canPrompt: false,
  standalone: isStandalone(),
  isIos: isIos(),
  supported: serviceWorkerSupported(),
  updateReady: false,
  online: navigator.onLine,
};

const listeners = new Set<() => void>();

const setStatus = (patch: Partial<PwaStatus>): void => {
  const next = { ...status, ...patch };
  const changed = (Object.keys(patch) as (keyof PwaStatus)[]).some((key) => status[key] !== next[key]);
  if (!changed) return;
  status = next;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Reactive view of install/update/connectivity state. */
export const usePwaStatus = (): PwaStatus =>
  useSyncExternalStore(subscribe, () => status, () => status);

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let waitingWorker: ServiceWorker | null = null;
let reloadOnControllerChange = false;

/** Interval between background update checks for a long-lived session. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const trackWaitingWorker = (worker: ServiceWorker | null): void => {
  if (!worker) return;
  waitingWorker = worker;
  setStatus({ updateReady: true });
};

const watchRegistration = (registration: ServiceWorkerRegistration): void => {
  // A build can already be waiting from a previous visit.
  if (registration.waiting && navigator.serviceWorker.controller) {
    trackWaitingWorker(registration.waiting);
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // Without an existing controller this is the very first install, which
      // is not an update the user needs to act on.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        trackWaitingWorker(registration.waiting ?? installing);
      }
    });
  });

  const checkForUpdate = () => {
    registration.update().catch(() => {
      /* offline or transient: the next check will retry */
    });
  };

  window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
};

/**
 * Registers the service worker and wires up install/update listeners. Safe to
 * call unconditionally; it returns immediately where PWA APIs are unavailable.
 */
export const initPwa = (): void => {
  window.addEventListener('online', () => setStatus({ online: true }));
  window.addEventListener('offline', () => setStatus({ online: false }));

  DISPLAY_MODE_QUERIES.forEach((mode) => {
    window
      .matchMedia(`(display-mode: ${mode})`)
      .addEventListener('change', () => setStatus({ standalone: isStandalone() }));
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppress the browser's own mini-infobar so the prompt is shown from an
    // explicit action in the app menu instead.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    setStatus({ canPrompt: true });
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    setStatus({ canPrompt: false });
  });

  // Dev runs from the Vite server, which never emits sw.js; a stale worker
  // caching HMR modules would only get in the way there.
  if (!status.supported || !import.meta.env.PROD) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadOnControllerChange) return;
    reloadOnControllerChange = false;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    // Resolved against the document so the same bundle works at a domain root,
    // under a GitHub Pages project subpath, or from any other subdirectory.
    const swUrl = new URL('sw.js', document.baseURI);
    navigator.serviceWorker
      // Scope defaults to the worker's own directory, which is the app root.
      .register(swUrl, { updateViaCache: 'none' })
      .then(watchRegistration)
      .catch((error) => {
        // A failed registration must never keep the app from starting.
        console.warn('[AirComic] Service worker registration failed:', error);
      });
  });
};

/**
 * Shows the platform install prompt. Must be called from a user gesture.
 * Resolves to true when the user accepted.
 */
export const promptInstall = async (): Promise<boolean> => {
  const prompt = deferredPrompt;
  if (!prompt) return false;

  // A captured prompt can only be used once.
  deferredPrompt = null;
  setStatus({ canPrompt: false });

  try {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    return outcome === 'accepted';
  } catch {
    return false;
  }
};

/** Activates a waiting build and reloads once it has taken control. */
export const applyUpdate = (): void => {
  if (!waitingWorker) {
    window.location.reload();
    return;
  }
  reloadOnControllerChange = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
};
