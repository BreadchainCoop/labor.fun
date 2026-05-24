# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (gh) from the official apt repo so task script gates can
# use `gh api` for GitHub authenticated calls (auth via GH_TOKEN passthrough).
RUN install -dm 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, claude-code, and Google Calendar MCP globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @cocal/google-calendar-mcp

# Install the official GitHub MCP server (pinned + checksum-verified).
# Arch-matched to the container so it works whether built on amd64 or
# arm64 hosts. SHA-256s are the goreleaser release checksums for the
# pinned version, independently verified; the build fails if the
# downloaded tarball does not match (supply-chain integrity).
ARG GITHUB_MCP_SERVER_VERSION=1.0.5
ARG GITHUB_MCP_SERVER_SHA256_AMD64=201082f569a846eaefd4318f13bccb5d9227c2cec45037d1d292ee83111173c1
ARG GITHUB_MCP_SERVER_SHA256_ARM64=ef5ba03df4aea7aaf52ba25be7bacb9fe64038dc17e46a85ba251998e8513f62
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) gmcp_arch="x86_64"; gmcp_sha="${GITHUB_MCP_SERVER_SHA256_AMD64}" ;; \
      arm64) gmcp_arch="arm64";  gmcp_sha="${GITHUB_MCP_SERVER_SHA256_ARM64}" ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/github/github-mcp-server/releases/download/v${GITHUB_MCP_SERVER_VERSION}/github-mcp-server_Linux_${gmcp_arch}.tar.gz"; \
    mkdir -p /tmp/gmcp; \
    curl -fsSL "$url" -o /tmp/gmcp.tar.gz; \
    echo "${gmcp_sha}  /tmp/gmcp.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gmcp.tar.gz -C /tmp/gmcp; \
    install -m 0755 /tmp/gmcp/github-mcp-server /usr/local/bin/github-mcp-server; \
    rm -rf /tmp/gmcp /tmp/gmcp.tar.gz; \
    github-mcp-server --help > /dev/null

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Copy scripts (used as task script gates)
COPY scripts/ /app/scripts/

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
