FROM alpine:3.20 AS builder
WORKDIR /work

RUN apk add --no-cache \
    ca-certificates \
    build-base \
    cmake \
    ninja \
    git \
    openssl-dev \
    zlib-dev \
    curl

COPY ./src /work/src

RUN cmake -S /work/src -B /work/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /work/build --target chdash

FROM alpine:3.20 AS production
WORKDIR /app

RUN apk add --no-cache \
    ca-certificates \
    libstdc++ \
    curl

COPY --from=builder /work/build/chdash /app/chdash

COPY ./src/static /app/static

ENV LISTEN_HOST=0.0.0.0
ENV LISTEN_PORT=8080
ENV STATIC_DIR=/app/static

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=10 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/app/chdash"]