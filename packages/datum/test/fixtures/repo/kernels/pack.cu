#include "geom.cuh"

namespace fixture {

// A launch site: `pack_symbols<<<grid, block>>>(...)` parses as a chain of shift operators, so the
// call edge only exists if the extractor rescues it textually.
__global__ void pack_symbols(unsigned char* out, int n) {
    int slot = packed_bytes_per_row(n);
    out[slot] = 0;
}

void launch_pack(unsigned char* out, int n) {
    pack_symbols<<<1, 256>>>(out, n);
}

}  // namespace fixture
