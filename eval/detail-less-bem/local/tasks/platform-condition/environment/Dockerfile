FROM python:3.11.9-slim-bookworm AS python-runtime

# environment_image_tag=detail-less-bem:node20.18.0-python3.11.9-stylelint16.10.0
FROM node:20.18.0-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.205

WORKDIR /workspace

COPY --from=python-runtime /usr/local /usr/local
RUN apt-get update && apt-get install -y --no-install-recommends \
    libbz2-1.0 libexpat1 libffi8 libgdbm6 liblzma5 libncursesw6 \
    libreadline8 libsqlite3-0 libssl3 zlib1g && \
    rm -rf /var/lib/apt/lists/* && \
    pip install --no-cache-dir pytest==8.3.3 && \
    npm install --global stylelint@16.10.0 @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

COPY .stylelintrc.json /workspace/.stylelintrc.json
COPY scripts /workspace/scripts
COPY src /workspace/src

CMD ["bash"]
