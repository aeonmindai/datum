//! Same name and same body as ../base, but `bits` widened from `u32` to `u64`. This is the change
//! a name-keyed index cannot see and every caller cares about, so the hash must move.

pub fn quantize(values: &[f32], bits: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len());
    for v in values {
        out.push((*v as u32 >> bits) as u8);
    }
    out
}
