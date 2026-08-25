//! A nested module, so the derived fqn has to come from the directory layout rather than the file.

use crate::Codec;

pub struct Geometry {
    pub k: u32,
}

impl Geometry {
    pub fn from_env() -> Self {
        Self { k: 4 }
    }
}

/// The second definition of this name. With `crateA/src/lib.rs` also defining it, a bare
/// `shared_helper(..)` call has exactly two candidates.
pub fn shared_helper(v: u32) -> u32 {
    v * 2
}

macro_rules! widen_twice {
    ($v:expr) => {
        $v << 2
    };
}

pub fn use_macro(v: u32) -> u32 {
    widen_twice!(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shared_helper() {
        assert_eq!(shared_helper(2), 4);
    }

    #[tokio::test]
    async fn geometry_from_env_is_four() {
        assert_eq!(Geometry::from_env().k, 4);
    }

    fn helper_not_a_test(v: u32) -> u32 {
        v
    }

    #[test]
    fn uses_the_helper() {
        assert_eq!(helper_not_a_test(1), 1);
    }
}

pub fn implements_via_codec(c: &dyn Codec) -> u32 {
    c.decode(1)
}
