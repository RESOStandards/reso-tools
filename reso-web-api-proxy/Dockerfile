# Lightweight CORS proxy + web UI server
# Build context: repository root (so it can access sibling packages)
#
# Usage:
#   docker build -f reso-web-api-proxy/Dockerfile -t reso-web-api-proxy .
#   docker run -p 8888:8888 reso-web-api-proxy

# Stage 1: Build the proxy server
FROM node:22-alpine AS build-proxy
WORKDIR /app
COPY reso-web-api-proxy/package.json reso-web-api-proxy/package-lock.json* ./
RUN npm ci --ignore-scripts || npm install
COPY reso-web-api-proxy/ ./
RUN npx tsc

# Stage 2: Build the web UI
FROM node:22-alpine AS build-ui
WORKDIR /app

# Copy shared dependencies
COPY reso-validation/ /deps/reso-validation/
COPY odata-expression-parser/ /deps/odata-expression-parser/
COPY reso-client/ /deps/reso-client/

COPY reso-web-client/package.json reso-web-client/package-lock.json* ./

# Rewrite dependency paths for Docker build context
RUN sed -i 's|file:../reso-validation|file:/deps/reso-validation|' package.json && \
    sed -i 's|file:../odata-expression-parser|file:/deps/odata-expression-parser|' package.json && \
    sed -i 's|file:../reso-client|file:/deps/reso-client|' package.json && \
    sed -i 's|file:../odata-expression-parser|file:/deps/odata-expression-parser|' /deps/reso-client/package.json

# Build dependencies first
RUN cd /deps/reso-validation && npm install && npx tsc && \
    cd /deps/odata-expression-parser && npm install && npx tsc && \
    cd /deps/reso-client && npm install && npx tsc

RUN npm ci --ignore-scripts || npm install

COPY reso-web-client/ ./
RUN npx vite build

# Stage 3: Runtime
FROM node:22-alpine
WORKDIR /app

# Non-root user
RUN addgroup -S reso && adduser -S reso -G reso

COPY --from=build-proxy /app/dist ./dist/
COPY --from=build-proxy /app/node_modules ./node_modules/
COPY --from=build-proxy /app/package.json ./
COPY --from=build-ui /app/dist ./ui/

USER reso

ENV PORT=8888
EXPOSE 8888

CMD ["node", "dist/cli.js", "--port", "8888", "--ui", "./ui"]
