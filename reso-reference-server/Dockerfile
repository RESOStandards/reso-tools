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
# lockfile, but the install is SCOPED to the workspaces this image builds.
#
# --ignore-scripts is load bearing, not hygiene. better-sqlite3 13 ships no install
# script, declares "gypfile": false, and bundles a prebuilt binary per platform,
# linuxmusl-x64 among them, so it needs no compiler anywhere. Installed on its own, npm
# honors that and does nothing. Installed as part of a workspace, npm sees a binding.gyp
# in the unpacked directory and runs "node-gyp rebuild" regardless of the manifest, which
# fails on this image for want of python3, make and g++ — measured in both `npm ci` and
# `npm install`, and the reason the package installed cleanly here before the workspace
# build existed. The alternative is adding a C toolchain to compile a binary the package
# already shipped. Skipping the scripts is correct: the module loads from its bundled
# prebuilds, which the smoke check below the build proves, and nothing else in this
# image's dependency tree has an install step it needs.
RUN npm ci --ignore-scripts \
      -w @reso-standards/reso-common \
      -w @reso-standards/reso-validation \
      -w @reso-standards/odata-expression-parser \
      -w @reso-standards/reso-reference-server

COPY reso-common ./reso-common
COPY reso-validation ./reso-validation
COPY odata-expression-parser ./odata-expression-parser
COPY reso-reference-server ./reso-reference-server

# Topological order: a package builds only after every sibling it imports, because tsc
# resolves a workspace sibling through the dist its package.json points at, and the
# symlink alone does not create that dist.
RUN npm run build -w @reso-standards/reso-common \
 && npm run build -w @reso-standards/reso-validation \
 && npm run build -w @reso-standards/odata-expression-parser \
 && npm run build -w @reso-standards/reso-reference-server

# JSON config files tsc does not emit
RUN cp reso-reference-server/src/ui-config.json \
       reso-reference-server/src/field-groups.json \
       reso-reference-server/dist/

# Fail the build here rather than at container start if the SQLite driver cannot load its
# bundled binary. This is the assertion that makes --ignore-scripts above safe to keep.
RUN node -e "const db=require('better-sqlite3')(':memory:');db.exec('create table t(x)');db.prepare('insert into t values (1)').run();if(db.prepare('select count(*) c from t').get().c!==1)process.exit(1);console.log('better-sqlite3 loaded its prebuilt binary and round-tripped a row')"

# --- Runtime stage ---
FROM node:24-alpine

WORKDIR /repo

# The user is created before the COPY because `--chown` resolves the name against this
# image's /etc/passwd, and an unknown name fails the build.
RUN addgroup -S reso && adduser -S reso -G reso \
 && mkdir -p /data && chown reso:reso /data

# The whole workspace comes forward. The hoisted node_modules holds symlinks into the
# sibling package directories, so copying node_modules without them would leave those
# links dangling.
#
# Ownership is set by the COPY itself, because a `chown -R` afterwards rewrites every
# inode and so writes a second copy of the entire tree as its own layer.
COPY --from=build --chown=reso:reso /repo /repo

ENV PORT=8080
ENV METADATA_PATH=./server-metadata.json

USER reso

WORKDIR /repo/reso-reference-server

EXPOSE 8080

CMD ["node", "dist/index.js"]
