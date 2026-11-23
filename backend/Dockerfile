# syntax=docker/dockerfile:1

# ---- build -------------------------------------------------------------------
FROM rust:1-slim-bookworm AS build
WORKDIR /app

# Cache dependencies: build a stub binary against the real manifest first.
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release --locked 2>/dev/null || cargo build --release \
    && rm -rf src

COPY migrations ./migrations
COPY src ./src
RUN touch src/main.rs && cargo build --release

# ---- runtime -----------------------------------------------------------------
# Distroless: no shell, no package manager, runs as non-root.
FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=build /app/target/release/big-api /app/big-api
ENV BIND_ADDR=0.0.0.0:8080 APP_ENV=production
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/app/big-api"]
