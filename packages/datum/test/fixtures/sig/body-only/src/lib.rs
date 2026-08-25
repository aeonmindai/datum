//! Identical signature to ../base, completely different body — and reformatted, to prove the hash
//! ignores whitespace as well as behaviour. The hash must not move: nothing a caller can see
//! changed.

pub fn quantize(
    values: &[f32],
    bits: u32,
) -> Vec<u8> {
    values
        .iter()
        .map(|v| (*v as u32).rotate_right(bits) as u8)
        .collect()
}
