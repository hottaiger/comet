FROM node:20.18.0-bookworm-slim AS node_runtime

FROM python:3.11.9-slim-bookworm

ARG IMAGE_TAG=detail-less-bem-node20.18.0-python3.11.9-stylelint16.10.0
ARG CLAUDE_CODE_VERSION=2.1.205
LABEL org.opencontainers.image.version="${IMAGE_TAG}"

COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node_runtime /usr/local/lib/node_modules /usr/local/lib/node_modules

RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    node --version | grep -qx 'v20.18.0' && \
    python --version | grep -qx 'Python 3.11.9' && \
    npm install --global stylelint@16.10.0 @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && \
    stylelint --version | grep -qx '16.10.0' && \
    pip install --no-cache-dir pytest==8.3.3 pydantic==2.9.2 python-dotenv==1.0.1

WORKDIR /workspace
CMD ["bash"]
