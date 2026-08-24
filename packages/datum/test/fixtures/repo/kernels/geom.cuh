#pragma once

#include <cstdint>

namespace fixture {

template <uint32_t K_>
struct Geom {
    static constexpr uint32_t K = K_;
    static constexpr uint32_t ALPHABET = 1u << K_;
};

using GeomK4 = Geom<4>;

// `__device__` makes this a kernel by the indexer's classification, and the CUDA qualifier lands in
// an ERROR node that the extractor has to look past to find the declarator at all.
__device__ __forceinline__ int packed_bytes_per_row(int num_symbols) {
    return num_symbols / 2;
}

template <typename T>
__device__ __forceinline__ float to_float(T v) {
    return static_cast<float>(v);
}

// An explicit specialisation. The empty `<>` throws tree-sitter-cpp off badly enough that the
// declarator's name field comes back as `__forceinline__` and the real name is stranded inside an
// ERROR node; the extractor has to recover it, or this kernel is indexed under a name nothing can
// call.
template <>
__device__ __forceinline__ float to_float<int>(int v) {
    return packed_bytes_per_row(v);
}

}  // namespace fixture
