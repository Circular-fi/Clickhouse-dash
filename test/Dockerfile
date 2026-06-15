ARG CHDASH_SEMVER=dev
ARG CHDASH_GIT_SHA=unknown
ARG CHDASH_BUILD_TIME=unknown

FROM alpine:3.24 AS toolchain
WORKDIR /work

RUN apk add --no-cache \
    ca-certificates \
    build-base \
    libstdc++-dev \
    cmake \
    ninja \
    git \
    lld

FROM toolchain AS deps
COPY src/CMakeLists.txt /work/src/
COPY src/EmbedStatic.cmake /work/src/

RUN cmake -S /work/src -B /work/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCHDASH_BUILD_APP=OFF \
      -DCHDASH_EMBED_STATIC=OFF \
 && cmake --build /work/build --target clickhouse-cpp-lib

FROM toolchain AS dev-builder
ARG CHDASH_SEMVER
ARG CHDASH_GIT_SHA
ARG CHDASH_BUILD_TIME
RUN mkdir -p /work/src
COPY --from=deps /work/build /work/build
COPY src/CMakeLists.txt /work/src/
COPY src/EmbedStatic.cmake /work/src/
COPY src/*.cpp /work/src/
COPY src/*.hpp /work/src/

RUN cmake -S /work/src -B /work/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Debug \
      -DCHDASH_BUILD_APP=ON \
      -DCHDASH_EMBED_STATIC=OFF \
      -DCHDASH_SEMVER_VALUE="${CHDASH_SEMVER}" \
      -DCHDASH_GIT_SHA_VALUE="${CHDASH_GIT_SHA}" \
      -DCHDASH_BUILD_TIME_VALUE="${CHDASH_BUILD_TIME}" \
      -DCMAKE_EXE_LINKER_FLAGS="-fuse-ld=lld" \
 && cmake --build /work/build --target chdash -j$(nproc) \
 && cp /work/build/chdash /work/chdash

FROM toolchain AS prod-builder
ARG CHDASH_SEMVER
ARG CHDASH_GIT_SHA
ARG CHDASH_BUILD_TIME
COPY --from=deps /work/build /work/build
COPY src /work/src

RUN cmake -S /work/src -B /work/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCHDASH_BUILD_APP=ON \
      -DCHDASH_EMBED_STATIC=ON \
      -DCHDASH_SEMVER_VALUE="${CHDASH_SEMVER}" \
      -DCHDASH_GIT_SHA_VALUE="${CHDASH_GIT_SHA}" \
      -DCHDASH_BUILD_TIME_VALUE="${CHDASH_BUILD_TIME}" \
      -DCMAKE_EXE_LINKER_FLAGS="-static -s -fuse-ld=lld" \
 && cmake --build /work/build --target chdash -j$(nproc) \
 && strip /work/build/chdash \
 && cp /work/build/chdash /work/chdash

FROM alpine:3.24 AS dev
RUN apk add --no-cache ca-certificates libstdc++ libgcc
WORKDIR /app
COPY --from=dev-builder /work/chdash /app/chdash
COPY src/static /app/static
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=1s --start-period=5s --retries=1 CMD ["/app/chdash", "--health"]
ENTRYPOINT ["/app/chdash"]

FROM scratch AS production
WORKDIR /app
COPY --from=prod-builder /work/chdash /app/chdash
COPY --from=toolchain /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=1s --start-period=5s --retries=1 CMD ["/app/chdash", "--health"]
ENTRYPOINT ["/app/chdash"]
