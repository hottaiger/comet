FROM python:3.12-slim

WORKDIR /workspace

# Runtime tools for both comet baselines:
# - bash: 0.3.9 classic shell scripts (bash 4+ arrays, [[ ]]; python:3.12-slim ships only dash)
# - nodejs npm: 0.4.0-beta.1 comet (independent .mjs command scripts) and OpenSpec CLI
# - git curl jq: comet scripts and state inspection
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash git curl jq ca-certificates \
    nodejs npm && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir pyyaml

# OpenSpec CLI (comet drives openspec new/list/status/archive).
# Use npmmirror for reproducible builds behind GFW.
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g @fission-ai/openspec@1.5.0 && \
    npm config delete registry

# The live docs-layout treatment exercises Comet's OpenSpec command boundary.
# Frozen 039/040 Skills continue to call openspec directly and are unaffected.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'if [ "$1" != "openspec" ]; then echo "eval comet wrapper only supports: comet openspec" >&2; exit 2; fi' \
    'shift' \
    'cd /workspace/docs' \
    'exec openspec "$@"' \
    > /usr/local/bin/comet && chmod +x /usr/local/bin/comet

# Claude Code CLI (the agent runtime; version overridable via BENCH_CC_VERSION).
ARG CLAUDE_CODE_VERSION=latest
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && \
    npm config delete registry

# Sample project structure
RUN mkdir -p wordcount-cli && \
    echo '# Word Count CLI\nA simple word counting tool.' > wordcount-cli/README.md

# Existing wordcount code (extended during the task)
COPY wordcount.py /workspace/wordcount.py
COPY test_wordcount.py /workspace/test_wordcount.py

# OpenSpec working tree (comet-open writes under openspec/changes/)
RUN mkdir -p openspec/changes

# Parallel docs-layout root used only by COMET_FULL_040_BETA_DOCS_LAYOUT.
RUN mkdir -p docs/openspec/changes/archive docs/openspec/specs && \
    printf 'schema: spec-driven\n' > docs/openspec/config.yaml

# Create a non-root user: claude --dangerously-skip-permissions refuses to run
# as root, and most comet scripts also expect a normal HOME for git config etc.
RUN useradd --create-home --shell /bin/bash agent && \
    chown -R agent:agent /workspace
USER agent
ENV HOME=/home/agent
# Validator scripts import scaffold.*; bake PYTHONPATH so it never crosses the
# MSYS path-conversion boundary on the docker run command line.
ENV PYTHONPATH=/workspace
# Minimal git identity so comet commits don't fail.
RUN git config --global user.email "agent@eval.local" && \
    git config --global user.name "Comet Eval Agent" && \
    git config --global init.defaultBranch master

CMD ["bash"]
