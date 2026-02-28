# syntax=docker/dockerfile:1.6

FROM alpine:3.20 AS toolchain
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
RUN mkdir -p /work/src
COPY --from=deps /work/build /work/build
COPY src/CMakeLists.txt /work/src/
COPY src/EmbedStatic.cmake /work/src/
COPY src/*.cpp /work/src
COPY src/*.hpp /work/src

RUN cmake -S /work/src -B /work/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Debug \
      -DCHDASH_BUILD_APP=ON \
      -DCHDASH_EMBED_STATIC=OFF \
      -DCMAKE_EXE_LINKER_FLAGS="-fuse-ld=lld" \
 && cmake --build /work/build --target chdash -j$(nproc) \
 && cp /work/build/chdash /work/chdash

FROM toolchain AS prod-builder
COPY --from=deps /work/build /work/build
COPY src /work/src

RUN cmake -S /work/src -B /work/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCHDASH_BUILD_APP=ON \
      -DCHDASH_EMBED_STATIC=ON \
      -DCMAKE_EXE_LINKER_FLAGS="-static -s -fuse-ld=lld" \
 && cmake --build /work/build --target chdash -j$(nproc) \
 && strip /work/build/chdash \
 && cp /work/build/chdash /work/chdash

FROM alpine:3.20 AS dev
RUN apk add --no-cache ca-certificates libstdc++ libgcc
COPY --from=dev-builder /work/chdash /chdash
COPY src/static /static
EXPOSE 8080
ENV PORT=8080
ENV STATIC_DIR=/static
HEALTHCHECK --interval=5s --timeout=1s --start-period=5s --retries=1 CMD ["/chdash", "--health"]
ENTRYPOINT ["/chdash"]

FROM scratch AS production
COPY --from=prod-builder /work/chdash /chdash
COPY --from=toolchain /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
EXPOSE 8080
ENV PORT=8080
HEALTHCHECK --interval=5s --timeout=1s --start-period=5s --retries=1 CMD ["/chdash", "--health"]
ENTRYPOINT ["/chdash"]
