# llama.cpp built from source with explicit Blackwell (sm_120a) CUDA arch support.
# CMAKE_CUDA_ARCHITECTURES pinned to 120 (Blackwell) rather than relying on
# auto-detection, since this always builds on a CI/build host that may not
# have the target GPU attached.
#
# LLAMA_CPP_TAG bumped b10092 -> b10502 (2026-08-19, latest release at time of
# bump) for the Qwen3.8-27B migration: a real, documented bug exists on older
# llama.cpp CUDA builds where Qwen3.8's DeltaNet/Gated-DeltaNet layers produce
# silently corrupted output (loads fine, full speed, no crash or error --
# just garbage text) -- see ggml-org/llama.cpp discussion #27164. The
# underlying GDN CUDA coalescing fix landed at b8333, well before both the old
# and new tag, but there was no reason to risk it -- confirmed output
# correctness directly against this new build before deploying (see
# murderbot/llm/compose.yaml migration notes).
ARG LLAMA_CPP_TAG=b10502

FROM nvidia/cuda:12.8.2-devel-ubuntu24.04 AS build
ARG LLAMA_CPP_TAG

RUN apt-get update && apt-get install -y --no-install-recommends \
      git build-essential cmake curl libcurl4-openssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --branch "${LLAMA_CPP_TAG}" --depth 1 \
      https://github.com/ggml-org/llama.cpp .

RUN cmake -B build \
      -DBUILD_SHARED_LIBS=OFF \
      -DGGML_CUDA=ON \
      -DCMAKE_CUDA_ARCHITECTURES=120 \
      -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --config Release -j"$(nproc)" \
         --clean-first --target llama-server llama-cli

FROM nvidia/cuda:12.8.2-runtime-ubuntu24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
      libcurl4 ca-certificates curl libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/build/bin/llama-server /usr/local/bin/llama-server
COPY --from=build /src/build/bin/llama-cli /usr/local/bin/llama-cli

ENTRYPOINT ["/usr/local/bin/llama-server"]
