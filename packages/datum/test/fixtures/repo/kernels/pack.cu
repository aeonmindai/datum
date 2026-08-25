#include "geom.cuh"

namespace fixture {

// A launch site: `pack_symbols<<<grid, block>>>(...)` parses as a chain of shift operators, so the
// call edge only exists if the extractor rescues it textually.
__global__ void pack_symbols(unsigned char* out, int n) {
    int slot = packed_bytes_per_row(n);
    out[slot] = 0;
}

// `__launch_bounds__` written the way CUDA actually writes it: on its own line, above the
// declaration. tree-sitter-cpp does not merely stumble here, it consumes the declarator, so
// without the length-preserving blanking pass this kernel is absent from the index entirely.
template <int BLOCK>
__launch_bounds__(BLOCK, 4)
__global__ void bounded_pack(unsigned char* out, int n) {
    out[n] = 1;
}

// Two more shapes the grammar gets wrong, both measured on Arc.
//
// The return type `Geom<BLOCK>` in front of the name makes tree-sitter-cpp report the declarator's
// name as the whole phrase `__forceinline__ Geom vec_helper` \u2014 newline and all \u2014 rather than as an
// identifier, so a bare specifier check misses it and only "is this a plain identifier" catches it.
template <int BLOCK>
__device__ __forceinline__ Geom<BLOCK> vec_helper(int n) {
    // `dim3 grid(n, 1)` is C++'s most vexing parse: syntactically identical to a prototype, and
    // the grammar resolves it the wrong way. Believing it invents a `function` named `grid` that
    // then competes for resolution with anything genuinely called `grid`.
    dim3 grid(n, 1);
    return Geom<BLOCK>{};
}

void launch_pack(unsigned char* out, int n) {
    pack_symbols<<<1, 256>>>(out, n);
}

}  // namespace fixture
