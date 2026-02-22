# syntax=docker/dockerfile:1.6

FROM alpine:3.20 AS builder
WORKDIR /work

RUN apk add --no-cache \
    ca-certificates \
    build-base \
    cmake \
    ninja \
    git

COPY ./src /work/src

RUN --mount=type=cache,target=/work/build \
    cmake -S /work/src -B /work/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCHDASH_EMBED_STATIC=ON \
      -DCMAKE_EXE_LINKER_FLAGS="-static -static-libstdc++ -static-libgcc -s" \
 && cmake --build /work/build --target chdash \
 && file /work/build/chdash \
 && cp /work/build/chdash /work/chdash

FROM scratch AS production

COPY --from=builder /work/chdash /chdash

EXPOSE 8080
ENV PORT=8080

HEALTHCHECK --interval=5s --timeout=1s --start-interval=500ms --start-period=5s --retries=1 \
  CMD ["/chdash", "--health"]

ENTRYPOINT ["/chdash"]