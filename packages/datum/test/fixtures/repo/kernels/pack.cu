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

void launch_pack(unsigned char* out, int n) {
    pack_symbols<<<1, 256>>>(out, n);
}

}  // namespace fixture
