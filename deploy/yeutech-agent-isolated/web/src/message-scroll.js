export const MESSAGE_BOTTOM_THRESHOLD = 96;

export function isNearMessageBottom(target, threshold = MESSAGE_BOTTOM_THRESHOLD) {
  return target.scrollHeight - target.scrollTop - target.clientHeight <= threshold;
}

export function scrollTopAfterPrepend(previousTop, previousHeight, nextHeight) {
  return previousTop + Math.max(0, nextHeight - previousHeight);
}

export function reconcileAfterTerminal(inFlight, reconcile) {
  return Promise.resolve(inFlight).catch(() => null).then(reconcile);
}
