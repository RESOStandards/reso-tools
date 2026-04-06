FROM node:22-alpine AS build

RUN apk add --no-cache git

WORKDIR /app

# Copy workspace dependencies
COPY odata-expression-parser/ /deps/odata-expression-parser/
COPY reso-validation/ /deps/reso-validation/
COPY reso-client/ /deps/reso-client/

# Build shared deps
WORKDIR /deps/odata-expression-parser
RUN npm install && npm run build

WORKDIR /deps/reso-validation
RUN npm install && npm run build

WORKDIR /deps/reso-client
RUN rm -f package-lock.json \
 && sed -i 's|file:../odata-expression-parser|file:/deps/odata-expression-parser|' package.json \
 && npm install && npm run build

# Pre-clone reso-certification-utils
RUN git clone --depth 1 --branch v3.0.0 https://github.com/RESOStandards/reso-certification-utils.git /tmp/cert-utils \
 && cd /tmp/cert-utils && npm pkg delete scripts.prepare

# Build reso-certification
COPY reso-certification/ /deps/reso-certification/
WORKDIR /deps/reso-certification
RUN sed -i 's|file:../reso-client|file:/deps/reso-client|' package.json \
 && sed -i 's|file:../reso-validation|file:/deps/reso-validation|' package.json \
 && sed -i 's|git+https://github.com/RESOStandards/reso-certification-utils.git#v3.0.0|file:/tmp/cert-utils|' package.json \
 && npm install && npm run build

# Build MCP server
WORKDIR /app
COPY reso-mcp-server/package.json ./
RUN sed -i 's|file:../reso-client|file:/deps/reso-client|' package.json \
 && sed -i 's|file:../reso-validation|file:/deps/reso-validation|' package.json \
 && sed -i 's|file:../reso-certification|file:/deps/reso-certification|' package.json \
 && sed -i 's|file:../odata-expression-parser|file:/deps/odata-expression-parser|' package.json \
 && npm install

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
COPY --from=build /deps/odata-expression-parser /deps/odata-expression-parser
COPY --from=build /deps/reso-validation /deps/reso-validation
COPY --from=build /deps/reso-client /deps/reso-client
COPY --from=build /deps/reso-certification /deps/reso-certification

RUN addgroup -S reso && adduser -S reso -G reso
USER reso

ENTRYPOINT ["node", "dist/index.js"]
