FROM node:24-alpine AS build

WORKDIR /repo

# node:22-alpine shipped npm 10.9.9, whose resolver crashes on this tree with
# "Cannot read properties of null (reading 'edgesOut')" — bisected to vitest 4.x.
# Pinned to the major rather than @latest so a future npm cannot change the build
# underneath us, and matching the pin the publish workflows already use.
RUN npm install -g npm@11

# This image builds the workspace FROM THIS REPOSITORY rather than installing the
# sibling @reso-standards packages from the npm registry, so a commit is tested against
# itself instead of against whatever was last published. Published packages still
# resolve from the registry for everyone outside this repository.
#
# This image has the most to gain from that: it depends on five siblings, including
# reso-certification, so under registry resolution its smoke test could only ever
# exercise the last published combination of them.
#
# Manifests and the lockfile first, so a source-only change does not reinstall.
COPY package.json package-lock.json ./
COPY reso-metadata-utils/package.json ./reso-metadata-utils/
COPY reso-common/package.json ./reso-common/
COPY reso-validation/package.json ./reso-validation/
COPY odata-expression-parser/package.json ./odata-expression-parser/
COPY reso-client/package.json ./reso-client/
COPY reso-certification/package.json ./reso-certification/
COPY reso-reference-server/package.json ./reso-reference-server/
COPY reso-mcp-server/package.json ./reso-mcp-server/

# Every workspace member's manifest is present above because npm reconciles the whole
# lockfile, but the install is SCOPED to the workspaces this image builds. Leaving
# reso-reference-server out of the scope also keeps its better-sqlite3 out of the tree;
# see the note in reso-reference-server/Dockerfile for why that matters.
#
# --ignore-scripts because nothing in this tree has an install step this image needs, and
# skipping them keeps the native-build behavior described in that note from reaching here
# if the scope ever widens.
RUN npm ci --ignore-scripts \
      -w @reso-standards/reso-metadata-utils \
      -w @reso-standards/reso-common \
      -w @reso-standards/reso-validation \
      -w @reso-standards/odata-expression-parser \
      -w @reso-standards/reso-client \
      -w @reso-standards/reso-certification \
      -w @reso-standards/reso-mcp-server

COPY reso-metadata-utils ./reso-metadata-utils
COPY reso-common ./reso-common
COPY reso-validation ./reso-validation
COPY odata-expression-parser ./odata-expression-parser
COPY reso-client ./reso-client
COPY reso-certification ./reso-certification
COPY reso-mcp-server ./reso-mcp-server

# Topological order: a package builds only after every sibling it imports, because tsc
# resolves a workspace sibling through the dist its package.json points at, and the
# symlink alone does not create that dist.
RUN npm run build -w @reso-standards/reso-metadata-utils \
 && npm run build -w @reso-standards/reso-common \
 && npm run build -w @reso-standards/reso-validation \
 && npm run build -w @reso-standards/odata-expression-parser \
 && npm run build -w @reso-standards/reso-client \
 && npm run build -w @reso-standards/reso-certification \
 && npm run build -w @reso-standards/reso-mcp-server

# --- Runtime stage ---
FROM node:24-alpine

WORKDIR /repo

# The user is created before the COPY because `--chown` resolves the name against this
# image's /etc/passwd, and an unknown name fails the build.
RUN apk add --no-cache wget \
 && addgroup -S reso && adduser -S reso -G reso

# The whole workspace comes forward. The hoisted node_modules holds symlinks into the
# sibling package directories, so copying node_modules without them would leave those
# links dangling.
#
# Ownership is set by the COPY itself, because a `chown -R` afterwards rewrites every
# inode and so writes a second copy of the entire tree as its own layer.
COPY --from=build --chown=reso:reso /repo /repo

USER reso

WORKDIR /repo/reso-mcp-server

ENTRYPOINT ["node", "dist/index.js"]
