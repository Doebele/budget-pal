from app.core.rate_limit import SlidingWindowRateLimiter


def test_rate_limiter_blocks_after_limit() -> None:
    limiter = SlidingWindowRateLimiter(max_requests=2, window_seconds=60)
    key = "1.2.3.4:test@example.com"

    assert limiter.check(key).allowed is True
    assert limiter.check(key).allowed is True
    decision = limiter.check(key)
    assert decision.allowed is False
    assert decision.retry_after_seconds > 0


def test_rate_limiter_reset_clears_bucket() -> None:
    limiter = SlidingWindowRateLimiter(max_requests=1, window_seconds=60)
    key = "1.2.3.4:test@example.com"

    assert limiter.check(key).allowed is True
    assert limiter.check(key).allowed is False
    limiter.reset(key)
    assert limiter.check(key).allowed is True

