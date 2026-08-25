//! Fixture crate root. Every construct here exists to pin one indexer behaviour.

pub mod qtip;

use std::collections::HashMap;

/// A `uses_type` anchor and an `implements` target.
pub trait Codec {
    fn decode(&self, packed: u32) -> u32;
}

pub struct Alpha {
    pub width: u32,
}

pub struct Beta {
    pub width: u32,
}

impl Codec for Alpha {
    fn decode(&self, packed: u32) -> u32 {
        self.widen(packed)
    }
}

impl Alpha {
    /// Reached through `self.widen(..)`, which resolves via the enclosing impl type.
    pub fn widen(&self, packed: u32) -> u32 {
        packed << self.width
    }

    pub fn table() -> HashMap<u32, u32> {
        HashMap::new()
    }
}

impl Codec for Beta {
    fn decode(&self, packed: u32) -> u32 {
        packed >> 1
    }
}

/// One of two symbols with this name; `qtip::shared_helper` is the other. A call from *this*
/// module resolves uniquely, because module-local wins — which is what Rust name resolution does
/// too. The ambiguous case therefore has to come from a module where neither is local; see
/// `crateB/src/lib.rs`.
pub fn shared_helper(v: u32) -> u32 {
    v + 1
}

pub fn calls_locally(v: u32) -> u32 {
    shared_helper(v)
}

/// Nothing in this fixture defines `absent_dependency`, so the edge must survive as `unresolved`
/// rather than being dropped: "calls something I could not find" is information.
pub fn calls_missing(v: u32) -> u32 {
    absent_dependency(v)
}

pub const MAX_WIDTH: u32 = 8;
