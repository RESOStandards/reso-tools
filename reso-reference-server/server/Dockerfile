# Build stage
#
# NOTE: Build context is the tools/ directory so that all file: dependencies
# (odata-expression-parser, validation, data-generator) can be resolved.
#
# From docker-compose: context is set to .. (tools/)
# Standalone: docker build -f reso-reference-server/server/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app

# Copy file: dependencies
COPY odata-expression-parser/ /deps/odata-expression-parser/
COPY validation/ /deps/validation/
COPY data-generator/package.json data-generator/tsconfig.json /deps/data-generator/
COPY data-generator/src/ /deps/data-generator/src/

# Build file: dependencies (server depends on these)
WORKDIR /deps/odata-expression-parser
RUN npm install && npx tsc

WORKDIR /deps/validation
RUN npm install && npx tsc

WORKDIR /deps/data-generator
RUN npm install && npm run build

WORKDIR /app

# Copy server source
COPY reso-reference-server/server/package.json reso-reference-server/server/package-lock.json* ./

# Rewrite file: dependency paths for the Docker build context
RUN sed -i 's|file:../../odata-expression-parser|file:/deps/odata-expression-parser|' package.json \
 && sed -i 's|file:../../validation|file:/deps/validation|' package.json \
 && sed -i 's|file:../../data-generator|file:/deps/data-generator|' package.json

RUN npm ci --ignore-scripts || npm install
COPY reso-reference-server/server/tsconfig.json ./
COPY reso-reference-server/server/src/ ./src/
RUN npm run build
# Copy JSON config files that tsc doesn't emit
RUN cp src/ui-config.json src/field-groups.json dist/

# Runtime stage
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /deps/odata-expression-parser /deps/odata-expression-parser
COPY --from=build /deps/validation /deps/validation
COPY --from=build /deps/data-generator /deps/data-generator
COPY reso-reference-server/server/package.json ./
COPY reso-reference-server/server/server-metadata.json ./
COPY reso-reference-server/server/public ./public

ENV PORT=8080
ENV METADATA_PATH=./server-metadata.json

# Run as non-root user
RUN addgroup -S reso && adduser -S reso -G reso \
 && mkdir -p /data && chown reso:reso /data
USER reso

EXPOSE 8080

CMD ["node", "dist/index.js"]
