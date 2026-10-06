FROM node:24-alpine AS build

WORKDIR /repo

# node:22-alpine shipped npm 10.9.9, whose resolver crashes on this tree with
# "Cannot read properties of null (reading 'edgesOut')" — bisected to vitest 4.x.
# Pinned to the major rather than @latest so a future npm cannot change the build
# underneath us, and matching the pin the publish workflows already use.
RUN npm install -g npm@11

# This image builds the workspace FROM THIS REPOSITORY rather than installing the
# sibling @reso-standards packages from the npm registry.
#
# Installing them from the registry meant a commit was tested against the last
# PUBLISHED dependencies, so a change that added an export and a change that consumed
# it could never both be green until a publish happened in between. That is not a
# theoretical ordering problem: reso-certification imports parseReplicationProgress
# and summarizeReplicationProgress from reso-common, they exist only in an unpublished
# reso-common, and every compliance job failed on it. The same shape happened once
# before, at reso-common 0.3.0.
#
# Building from the workspace means a pull request is tested against itself, which is
# what CI is for, and it is testable locally with the same command CI runs. It does not
# change what consumers receive: published packages still resolve from the registry for
# everyone outside this repository.
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
# lockfile, but the install is SCOPED to the six workspaces this image builds. An
# unscoped install also pulls reso-reference-server's better-sqlite3, which publishes
# no musl prebuild and so needs python3/make/g++ in the image to compile — a toolchain
# this image has no other use for, to build a database driver the certification CLI
# never loads.
RUN npm ci \
      -w @reso-standards/reso-metadata-utils \
      -w @reso-standards/reso-common \
      -w @reso-standards/reso-validation \
      -w @reso-standards/odata-expression-parser \
      -w @reso-standards/reso-client \
      -w @reso-standards/reso-certification

COPY reso-metadata-utils ./reso-metadata-utils
COPY reso-common ./reso-common
COPY reso-validation ./reso-validation
COPY odata-expression-parser ./odata-expression-parser
COPY reso-client ./reso-client
COPY reso-certification ./reso-certification

# Topological order: a package builds only after every sibling it imports, because tsc
# resolves a workspace sibling through the dist its package.json points at, and the
# symlink alone does not create that dist.
RUN npm run build -w @reso-standards/reso-metadata-utils \
 && npm run build -w @reso-standards/reso-common \
 && npm run build -w @reso-standards/reso-validation \
 && npm run build -w @reso-standards/odata-expression-parser \
 && npm run build -w @reso-standards/reso-client \
 && npm run build -w @reso-standards/reso-certification

RUN cd reso-certification/xsd-validator && npm install

# Dev dependencies stay in the image. `npm prune --omit=dev` would be the tidy thing to
# do, but prune re-resolves the whole workspace rather than the scoped subset installed
# above, so it reaches reso-reference-server's better-sqlite3 and fails trying to compile
# it. Carrying the build-only packages costs image size in a continuous-integration image
# nothing publishes; adding a C toolchain to drop them would cost more.

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
# Ownership is set by the COPY itself. A `chown -R` afterwards rewrites every inode and
# so writes a second copy of the entire tree as its own layer, which doubles the image
# and, on a machine whose Docker disk is near full, fails the build outright.
COPY --from=build --chown=reso:reso /repo /repo

USER reso

WORKDIR /repo/reso-certification

ENTRYPOINT ["node", "dist/cli/index.js"]
