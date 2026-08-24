//! A second crate, so crate-prefixed fqns are actually distinguishable — and so there is a module
//! from which a call to `shared_helper` is genuinely ambiguous.

use fixture_alpha::shared_helper;

/// Exactly one symbol in the whole fixture bears this name, so the call to it below must resolve
/// `unique-name` — the baseline the ambiguous and unresolved cases are measured against.
pub fn only_one_of_me(v: u32) -> u32 {
    v.wrapping_shl(1)
}

pub fn caller(v: u32) -> u32 {
    only_one_of_me(v)
}

/// Neither `fixture_alpha::shared_helper` nor `fixture_alpha::qtip::shared_helper` is local here,
/// so the bare name matches two symbols and the edge must carry both candidates. Note the `use`
/// above: an importer can see which one it meant, but the indexer is not a name resolver and
/// pretending otherwise is the over-claim this store refuses.
pub fn calls_ambiguously(v: u32) -> u32 {
    shared_helper(v)
}

pub struct Left;
pub struct Right;

pub trait Pairable {
    fn combine(&self) -> u32;
}

/// The impl *target* is a tuple, which has no nameable type. Deriving one produces an fqn
/// containing a space and a comma that no call site can ever match, so `combine` would read as
/// unreferenced; the honest answer is that there is no type name here to scope it under.
impl Pairable for (Left, Right) {
    fn combine(&self) -> u32 {
        1
    }
}
