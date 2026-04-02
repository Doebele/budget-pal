from collections import defaultdict, deque
from dataclasses import dataclass
from threading import Lock
from time import monotonic


@dataclass
class RateLimitDecision:
    allowed: bool
    retry_after_seconds: int = 0


class SlidingWindowRateLimiter:
    """
    Simple in-memory sliding window limiter.
    Good baseline for single-instance deployments.
    """

    def __init__(self, max_requests: int, window_seconds: int):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def check(self, key: str) -> RateLimitDecision:
        now = monotonic()
        with self._lock:
            q = self._events[key]
            self._prune(q, now)
            if len(q) >= self.max_requests:
                retry_after = max(1, int(self.window_seconds - (now - q[0])))
                return RateLimitDecision(allowed=False, retry_after_seconds=retry_after)
            q.append(now)
            return RateLimitDecision(allowed=True)

    def reset(self, key: str) -> None:
        with self._lock:
            self._events.pop(key, None)

    def _prune(self, q: deque[float], now: float) -> None:
        while q and (now - q[0]) >= self.window_seconds:
            q.popleft()

