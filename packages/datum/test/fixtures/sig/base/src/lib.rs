//! Baseline for the signature-hash change detector. Compare against ../body-only and
//! ../signature-changed; all three declare `quantize` at the same path with the same name.

pub fn quantize(values: &[f32], bits: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len());
    for v in values {
        out.push((*v as u32 >> bits) as u8);
    }
    out
}
