# ──────────────────────────────────────────────────────────────
# Stage A — Go helper builder
# Builds scripts/extract_go/ into a static binary. Discarded after copy.
# ──────────────────────────────────────────────────────────────
FROM golang:1.22-bookworm AS go-helper-builder
WORKDIR /src
COPY scripts/extract_go/go.mod ./
RUN go mod download
COPY scripts/extract_go/ ./
RUN go test ./...
RUN mkdir -p /out && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bollard-extract-go .

# ──────────────────────────────────────────────────────────────
# Stage B — Rust helper builder
# Builds scripts/extract_rs/ into a release binary. Discarded after copy.
# ──────────────────────────────────────────────────────────────
FROM rust:1.80-slim-bookworm AS rust-helper-builder
WORKDIR /src
COPY scripts/extract_rs/Cargo.toml ./
RUN mkdir -p src \
    && echo 'fn main(){}' > src/main.rs \
    && cargo build --release \
    && rm -rf src \
    && rm -f target/release/bollard-extract-rs \
    && rm -f target/release/deps/bollard_extract_rs* \
    && rm -rf target/release/.fingerprint/bollard-extract-rs-*
COPY scripts/extract_rs/src ./src
RUN cargo test --release
RUN mkdir -p /out \
    && cargo build --release \
    && cp target/release/bollard-extract-rs /out/bollard-extract-rs

# ──────────────────────────────────────────────────────────────
# Stage C1 — Java helper: fat JAR (Maven)
# ──────────────────────────────────────────────────────────────
FROM maven:3.9-eclipse-temurin-21 AS java-jar-builder
WORKDIR /src
COPY scripts/extract_java/pom.xml ./
RUN mvn -q dependency:go-offline
COPY scripts/extract_java/ ./
RUN mvn -q package -DskipTests

# ──────────────────────────────────────────────────────────────
# Stage C2 — Java helper: GraalVM native-image
# ──────────────────────────────────────────────────────────────
FROM ghcr.io/graalvm/native-image-community:21 AS java-helper-builder
COPY --from=java-jar-builder /src/target/bollard-extract-java-1.0.0-jar-with-dependencies.jar /tmp/app.jar
RUN mkdir -p /out \
    && native-image \
        --no-fallback \
        -jar /tmp/app.jar \
        -o /out/bollard-extract-java \
        -H:+ReportExceptionStackTraces

# ──────────────────────────────────────────────────────────────
# Stage C — dev (fast, day-to-day)
# Node 22 + pnpm + python3 + pre-built Go/Rust/Java extractor helpers.
# No Go, Rust, or JVM toolchain at runtime (Java helper is native binary).
# ──────────────────────────────────────────────────────────────
FROM node:22-slim AS dev
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git ca-certificates python3 procps ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY --from=go-helper-builder   /out/bollard-extract-go /usr/local/bin/bollard-extract-go
COPY --from=rust-helper-builder /out/bollard-extract-rs /usr/local/bin/bollard-extract-rs
COPY --from=java-helper-builder /out/bollard-extract-java /usr/local/bin/bollard-extract-java
RUN bollard-extract-go --version && bollard-extract-rs --version && bollard-extract-java --version
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/engine/package.json packages/engine/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/agents/package.json packages/agents/package.json
COPY packages/verify/package.json packages/verify/package.json
COPY packages/blueprints/package.json packages/blueprints/package.json
COPY packages/detect/package.json packages/detect/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ENTRYPOINT ["pnpm"]

# ──────────────────────────────────────────────────────────────
# Stage D — dev-full (Stage 3b validation)
# Extends dev with full Go 1.22 and Rust stable toolchains so the
# pipeline can run go test / cargo test / pytest against project code.
#
# Single RUN layer: all installs + cleanup in one layer so that
# post-install rm/purge actually reclaims space. Separate layers
# make deletions invisible to the layer that created the files.
# ──────────────────────────────────────────────────────────────
FROM dev AS dev-full
ENV GOPATH=/go GOTOOLCHAIN=local PATH=/usr/local/go/bin:/go/bin:/root/.cargo/bin:/opt/java/openjdk/bin:$PATH
COPY --from=eclipse-temurin:21-jdk /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
RUN set -eux \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       curl gcc libc6-dev pkg-config python3-pip maven \
    \
    && ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) GO_ARCH=amd64 ;; \
         arm64) GO_ARCH=arm64 ;; \
         *) echo "unsupported arch $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL "https://go.dev/dl/go1.22.6.linux-${GO_ARCH}.tar.gz" \
       | tar -C /usr/local -xz \
    && rm -rf /usr/local/go/api /usr/local/go/doc \
              /usr/local/go/test /usr/local/go/misc \
    && go version \
    \
    && java -version && mvn --version \
    \
    && curl -fsSL https://sh.rustup.rs \
       | sh -s -- -y --default-toolchain stable --profile minimal \
    && rm -rf /root/.rustup/toolchains/*/share/doc \
    && rustc --version && cargo --version \
    \
    && pip3 install --break-system-packages --no-cache-dir pytest ruff \
    \
    && apt-get purge -y --auto-remove curl python3-pip \
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/* \
              /usr/share/doc /usr/share/man \
              /usr/lib/*/libasan* /usr/lib/*/libtsan* \
              /usr/lib/*/liblsan* /usr/lib/*/libhwasan* \
              /usr/lib/*/libubsan* /usr/lib/*/libgprofng*
WORKDIR /app
ENTRYPOINT ["pnpm"]
