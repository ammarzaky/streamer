/**
 * Periodic room maintenance.
 *
 * The sweep does three things, and the order matters: reap sockets that died silently,
 * resolve any expired host grace, then retire empty or idle rooms.
 *
 * The host-grace step in particular cannot live only on the join path. A room whose host
 * disappears and where nobody happens to join again would otherwise stay hostless for the
 * rest of its life -- `end` returns NOT_HOST to everyone and the room lingers until the idle
 * timeout hours later.
 */
export function startJanitor({ registry, config, endRoom, send, broadcast }) {
  const timer = setInterval(
    () => registry.sweep({ endRoom, send, broadcast }),
    config.rooms.janitorIntervalMs,
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
