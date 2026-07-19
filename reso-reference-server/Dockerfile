# Build stage
#
# NOTE: docker-compose builds this image with the tools/ root as the build
# context (context: ..), so COPY paths are prefixed with reso-reference-server/.
# Standalone: docker build -f reso-reference-server/Dockerfile .   (from tools/)
#
# The @reso-standards/* dependencies (reso-common, odata-expression-parser,
# reso-validation) resolve from the npm registry via npm install.

FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies (resolved from the npm registry)
COPY reso-reference-server/package.json reso-reference-server/package-lock.json* ./
RUN npm install

# Build the server
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
COPY reso-reference-server/package.json ./
COPY reso-reference-server/server-metadata.json ./
COPY reso-reference-server/seed-data ./seed-data
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
