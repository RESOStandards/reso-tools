FROM node:24-alpine AS build

WORKDIR /app

# All @reso-standards/* dependencies are published to the npm registry and are
# declared as caret ranges in package.json, so a plain `npm install` resolves
# them (including reso-certification, which ships its own xsd/validation assets).
# No sibling COPY-into-/deps, no file: rewrites, no source builds needed.
COPY reso-mcp-server/package.json ./
# node:22-alpine ships npm 10.9.9, whose dependency resolver crashes on this
# tree with "Cannot read properties of null (reading 'edgesOut')". Bisected to
# vitest 4.x: every other dependency installs clean, vitest alone reproduces it,
# and npm 11 installs the whole manifest. Development runs npm 11 locally, which
# is why this passed on every machine and failed only in the image.
#
# Pinned to the major rather than @latest so a future npm cannot change the build
# underneath us.
RUN npm install -g npm@11
RUN npm install

COPY reso-mcp-server/tsconfig.json ./
COPY reso-mcp-server/src/ ./src/
RUN npm run build
RUN npm prune --omit=dev

# --- Runtime ---
FROM node:24-alpine

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

RUN addgroup -S reso && adduser -S reso -G reso
USER reso

ENTRYPOINT ["node", "dist/index.js"]
