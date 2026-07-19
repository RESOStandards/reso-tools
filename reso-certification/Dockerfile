FROM node:22-alpine AS build

WORKDIR /app

# Install dependencies. All @reso-standards/* deps resolve from the npm registry
# as caret ranges — no sibling COPY-into-/deps, no file: rewrites, no source builds.
COPY reso-certification/package.json ./
RUN npm install

COPY reso-certification/tsconfig.json ./
COPY reso-certification/src/ ./src/
COPY reso-certification/xsd-validator/ ./xsd-validator/
COPY reso-certification/xsd/ ./xsd/
# schema-validation-settings.json is read at runtime by the DD/schema validators
# (src/sdk/dd.ts and src/legacy/lib/schema); it lives at the package root.
COPY reso-certification/schema-validation-settings.json ./
RUN cd xsd-validator && npm install && cd ..
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
COPY --from=build /app/src/legacy ./src/legacy
COPY --from=build /app/xsd-validator ./xsd-validator
COPY --from=build /app/xsd ./xsd
COPY --from=build /app/schema-validation-settings.json ./
COPY --from=build /app/sample-payloads ./sample-payloads
COPY --from=build /app/sample-metadata.xml ./

# Install wget for health checks in entrypoint
RUN apk add --no-cache wget

# Run as non-root user
RUN addgroup -S reso && adduser -S reso -G reso \
 && chown -R reso:reso /app
USER reso

ENTRYPOINT ["node", "dist/cli/index.js"]
