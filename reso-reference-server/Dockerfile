# Build stage
#
# NOTE: Build context is the tools/ directory so that all file: dependencies
# (odata-expression-parser, reso-validation, reso-data-generator) can be resolved.
#
# From docker-compose: context is set to .. (tools/)
# Standalone: docker build -f reso-reference-server/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app

# Copy file: dependencies
COPY odata-expression-parser/ /deps/odata-expression-parser/
COPY reso-validation/ /deps/reso-validation/
COPY reso-data-generator/package.json reso-data-generator/tsconfig.json /deps/reso-data-generator/
COPY reso-data-generator/src/ /deps/reso-data-generator/src/

# Build file: dependencies (server depends on these)
WORKDIR /deps/odata-expression-parser
RUN npm install && npx tsc

WORKDIR /deps/reso-validation
RUN npm install && npx tsc

WORKDIR /deps/reso-data-generator
RUN npm install && npm run build

WORKDIR /app

# Copy server source
COPY reso-reference-server/package.json reso-reference-server/package-lock.json* ./

# Rewrite file: dependency paths for the Docker build context
RUN sed -i 's|file:../odata-expression-parser|file:/deps/odata-expression-parser|' package.json \
 && sed -i 's|file:../reso-validation|file:/deps/reso-validation|' package.json \
 && sed -i 's|file:../reso-data-generator|file:/deps/reso-data-generator|' package.json

RUN npm ci --ignore-scripts || npm install
COPY reso-reference-server/tsconfig.json ./
COPY reso-reference-server/src/ ./src/
RUN npm run build
# Copy JSON config files that tsc doesn't emit
RUN cp src/ui-config.json src/field-groups.json dist/

# Runtime stage
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /deps/odata-expression-parser /deps/odata-expression-parser
COPY --from=build /deps/reso-validation /deps/reso-validation
COPY --from=build /deps/reso-data-generator /deps/reso-data-generator
COPY reso-reference-server/package.json ./
COPY reso-reference-server/server-metadata.json ./
COPY reso-reference-server/public ./public
# Config resolves serverRoot to ../src when running from dist/
COPY reso-reference-server/src/ui-config.json reso-reference-server/src/field-groups.json ./src/

ENV PORT=8080
ENV METADATA_PATH=./server-metadata.json

# Run as non-root user
RUN addgroup -S reso && adduser -S reso -G reso \
 && mkdir -p /data && chown reso:reso /data
USER reso

EXPOSE 8080

CMD ["node", "dist/index.js"]
