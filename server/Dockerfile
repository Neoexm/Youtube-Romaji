# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=22.18.0
FROM node:${NODE_VERSION}-slim AS base

ARG INSTALL_FULL_NLP_STACK=1

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules and run the Python sidecar
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
      build-essential \
      node-gyp \
      pkg-config \
      python3 \
      python3-pip \
      python3-venv \
      python-is-python3

# Install node modules
COPY package-lock.json package.json ./
RUN npm ci

# Install Python runtime dependencies for the pronunciation sidecar.
COPY python/requirements.txt ./python/requirements.txt
COPY python/requirements.optional-nlp.txt ./python/requirements.optional-nlp.txt
RUN python3 -m pip install --no-cache-dir --no-require-hashes --break-system-packages -r python/requirements.txt && \
    if [ "$INSTALL_FULL_NLP_STACK" = "1" ]; then \
      python3 -m pip install --no-cache-dir --no-require-hashes --break-system-packages -r python/requirements.optional-nlp.txt; \
    fi

# Copy application code
COPY . .


# Final stage for app image
FROM base

ARG INSTALL_FULL_NLP_STACK=1

# Install Python runtime so Node can invoke the pronunciation sidecar CLI.
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y \
      build-essential \
      python3 \
      python3-pip \
      python3-venv \
      python-is-python3 && \
    rm -rf /var/lib/apt/lists/*

COPY python/requirements.txt ./python/requirements.txt
COPY python/requirements.optional-nlp.txt ./python/requirements.optional-nlp.txt
RUN python3 -m pip install --no-cache-dir --no-require-hashes --break-system-packages -r python/requirements.txt && \
    if [ "$INSTALL_FULL_NLP_STACK" = "1" ]; then \
      python3 -m pip install --no-cache-dir --no-require-hashes --break-system-packages -r python/requirements.optional-nlp.txt; \
    fi

# Create non-root user for security
RUN useradd -m -u 1001 appuser && \
    chown -R appuser:appuser /app

# Copy built application
COPY --from=build --chown=appuser:appuser /app /app

ENV ROMAJI_PYTHON_BIN="python3"

# Switch to non-root user
USER appuser

# Start the server by default, this can be overwritten at runtime
EXPOSE 3000
CMD [ "npm", "run", "start" ]
