FROM node:22-alpine AS build

WORKDIR /app

# All @reso-standards/* dependencies are published to the npm registry and are
# declared as caret ranges in package.json, so a plain `npm install` resolves
# them (including reso-certification, which ships its own xsd/validation assets).
# No sibling COPY-into-/deps, no file: rewrites, no source builds needed.
COPY reso-mcp-server/package.json ./
RUN npm install

COPY reso-mcp-server/tsconfig.json ./
COPY reso-mcp-server/src/ ./src/
RUN npm run build
RUN npm prune --omit=dev

# --- Runtime ---
FROM node:22-alpine

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

RUN addgroup -S reso && adduser -S reso -G reso
USER reso

ENTRYPOINT ["node", "dist/index.js"]
