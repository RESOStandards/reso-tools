FROM node:22-alpine AS build

RUN apk add --no-cache git

WORKDIR /app

# Copy workspace dependencies (same resolution chain as the server Dockerfile)
COPY odata-expression-parser/ /deps/odata-expression-parser/
COPY reso-validation/ /deps/reso-validation/
COPY reso-client/ /deps/reso-client/

# Build odata-expression-parser
WORKDIR /deps/odata-expression-parser
RUN npm install && npm run build

# Build reso-validation
WORKDIR /deps/reso-validation
RUN npm install && npm run build

# Build reso-client (depends on filter-parser)
WORKDIR /deps/reso-client
RUN rm -f package-lock.json \
 && sed -i 's|file:../odata-expression-parser|file:/deps/odata-expression-parser|' package.json \
 && npm install && npm run build

# Pre-clone reso-certification-utils and strip lefthook prepare script.
# npm always runs prepare for git deps regardless of --ignore-scripts or --omit=dev.
RUN git clone --depth 1 --branch v3.0.0 https://github.com/RESOStandards/reso-certification-utils.git /tmp/cert-utils \
 && cd /tmp/cert-utils && npm pkg delete scripts.prepare

# Build reso-certification (depends on reso-client + reso-validation)
WORKDIR /app
COPY reso-certification/package.json ./
RUN sed -i 's|file:../reso-client|file:/deps/reso-client|' package.json \
 && sed -i 's|file:../reso-validation|file:/deps/reso-validation|' package.json \
 && sed -i 's|git+https://github.com/RESOStandards/reso-certification-utils.git#v3.0.0|file:/tmp/cert-utils|' package.json \
 && npm install

COPY reso-certification/tsconfig.json ./
COPY reso-certification/src/ ./src/
RUN npm run build
RUN npm prune --omit=dev

# Copy sample payloads and metadata
COPY reso-certification/sample-payloads/ ./sample-payloads/
COPY reso-certification/sample-metadata.xml ./

# --- Runtime stage ---
FROM node:22-alpine

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/sample-payloads ./sample-payloads
COPY --from=build /app/sample-metadata.xml ./
COPY --from=build /deps/odata-expression-parser /deps/odata-expression-parser
COPY --from=build /deps/reso-validation /deps/reso-validation
COPY --from=build /deps/reso-client /deps/reso-client

# Install wget for health checks in entrypoint
RUN apk add --no-cache wget

# Run as non-root user
RUN addgroup -S reso && adduser -S reso -G reso
USER reso

ENTRYPOINT ["node", "dist/cli/index.js"]
