//! In-memory token buckets. Keys are hashed with a per-process random key (std
//! `RandomState`), so neither IPs nor anon keys are kept in clear, and nothing is persisted
//! or logged. Restart = clean slate.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hash, RandomState};
use std::sync::Mutex;
use std::time::Instant;

pub struct Limiter {
    per_sec: f64,
    burst: f64,
    hasher: RandomState,
    buckets: Mutex<HashMap<u64, (f64, Instant)>>,
}

const MAX_KEYS: usize = 100_000;

impl Limiter {
    pub fn new(per_sec: f64, burst: f64) -> Self {
        Self {
            per_sec: per_sec.max(0.0),
            burst: burst.max(1.0),
            hasher: RandomState::new(),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Take one token. `Err(secs)` = retry after `secs`.
    pub fn check<K: Hash>(&self, key: &K) -> Result<(), u64> {
        let h = self.hasher.hash_one(key);
        let now = Instant::now();
        let mut map = self.buckets.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() >= MAX_KEYS {
            let (rate, burst) = (self.per_sec, self.burst);
            map.retain(|_, (tokens, t)| *tokens + now.duration_since(*t).as_secs_f64() * rate < burst);
            if map.len() >= MAX_KEYS {
                map.clear();
            }
        }
        let (tokens, last) = map.entry(h).or_insert((self.burst, now));
        *tokens = (*tokens + now.duration_since(*last).as_secs_f64() * self.per_sec).min(self.burst);
        *last = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            Ok(())
        } else if self.per_sec > 0.0 {
            Err(((1.0 - *tokens) / self.per_sec).ceil() as u64)
        } else {
            Err(60)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket() {
        let l = Limiter::new(1.0, 2.0);
        assert!(l.check(&"a").is_ok());
        assert!(l.check(&"a").is_ok());
        assert_eq!(l.check(&"a"), Err(1));
        assert!(l.check(&"b").is_ok());
    }
}
