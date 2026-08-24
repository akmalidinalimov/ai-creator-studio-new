/**
 * DOM translate/extension crash guard.
 *
 * In-page translation — Google Translate on mobile Chrome is the common one, but
 * some browser extensions do the same — mutates the live DOM out from under
 * React: it replaces React-managed text nodes with its own <font>/<span>
 * wrappers. When React later tries to remove or reorder those nodes, the node it
 * expects is no longer a child of the parent, so `Node.removeChild` /
 * `Node.insertBefore` throw:
 *
 *   NotFoundError: Failed to execute 'removeChild' on 'Node':
 *   The node to be removed is not a child of this node.
 *
 * That error unmounts the WHOLE React tree → the app white-screens and the
 * top-level ErrorBoundary fires (render_crash). On a lesson page the student
 * experiences it as the video "reloading" or being "logged out", and tapping
 * reload just re-triggers translation → a crash loop. We caught exactly this in
 * client_error_events (Android Chrome, lesson routes, one session crashing 8×).
 *
 * Fix (the well-known React issue #11538 guard): make removeChild / insertBefore
 * a safe no-op when the node isn't actually a child of `this`, instead of
 * throwing. React then keeps reconciling instead of crashing. Translation keeps
 * working — only the crash is removed. The no-op can leave a node briefly stale
 * (translation's copy stays); that self-heals on the next render/navigation and
 * is strictly better than a full-app crash.
 *
 * Idempotent + install-once, and must run BEFORE React renders (call it from
 * main.tsx). Emits ONE lightweight DB-visible signal per page-session the first
 * time it catches interference, so we can measure how many students actually hit
 * this (health-signal rule) without flooding the beacon.
 */
import { reportClientError } from "@/lib/beacon";

let installed = false;
let signalled = false;

/** Fire a single per-session beacon the first time the guard catches interference.
 *  Deferred off the (hot) reconciliation stack; best-effort, never throws. */
function signalOnce(method: "removeChild" | "insertBefore"): void {
  if (signalled) return;
  signalled = true;
  try {
    setTimeout(() => {
      reportClientError({
        type: "other",
        message: "dom_translate_guard",
        extra: { kind: "translate_interference", method },
      });
    }, 0);
  } catch {
    /* ignore — a health signal must never affect the app */
  }
}

export function installDomTranslateGuard(): void {
  if (installed) return;
  if (typeof Node === "undefined" || !Node.prototype) return;
  installed = true;

  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) {
      // The node was already detached / reparented (translation or an extension).
      // No-op instead of throwing; return the child, as removeChild would.
      signalOnce("removeChild");
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(
    this: Node,
    node: T,
    child: Node | null,
  ): T {
    if (child && child.parentNode !== this) {
      // Reference node is no longer our child (translation reparented it).
      // No-op (return the new node) rather than throwing; React survives.
      signalOnce("insertBefore");
      return node;
    }
    return originalInsertBefore.call(this, node, child) as T;
  };
}
