# syntax=docker/dockerfile:1.6

FROM alpine:3.20 AS base-build
WORKDIR /work

RUN apk add --no-cache \
    ca-certificates \
    build-base \
    cmake \
    ninja \
    git


FROM base-build AS builder
COPY ./src /work/src
RUN cmake -S /work/src -B /work/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCHDASH_EMBED_STATIC=ON \
      -DCMAKE_EXE_LINKER_FLAGS="-static -static-libstdc++ -static-libgcc -s" \
 && cmake --build /work/build --target chdash \
 && file /work/build/chdash \
 && cp /work/build/chdash /work/chdash


FROM base-build AS dev-builder
RUN apk add --no-cache lld binutils
COPY ./src/CMakeLists.txt ./src/EmbedStatic.cmake /work/src/
COPY ./src/*.cpp ./src/*.hpp /work/src/
RUN cmake -S /work/src -B /work/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Debug \
      -DCHDASH_EMBED_STATIC=OFF \
      -DCMAKE_EXE_LINKER_FLAGS="-fuse-ld=lld" \
 && cmake --build /work/build --target chdash \
 && cp /work/build/chdash /work/chdash


FROM alpine:3.20 AS dev
RUN apk add --no-cache ca-certificates libstdc++ libgcc
COPY --from=dev-builder /work/chdash /chdash
COPY ./src/static /static

EXPOSE 8080
ENV PORT=8080
ENV STATIC_DIR=/static

ENTRYPOINT ["/chdash"]


FROM scratch AS production
COPY --from=builder /work/chdash /chdash
EXPOSE 8080
ENV PORT=8080
HEALTHCHECK --interval=5s --timeout=1s --start-interval=500ms --start-period=5s --retries=1 \
  CMD ["/chdash", "--health"]
ENTRYPOINT ["/chdash"]