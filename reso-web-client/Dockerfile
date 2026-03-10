# Stage 1: Build
FROM node:22-alpine AS build
WORKDIR /app

# Copy file: dependencies
COPY validation/ /deps/validation/
COPY odata-expression-parser/ /deps/odata-expression-parser/
COPY odata-client/ /deps/odata-client/

COPY reso-web-client/package.json reso-web-client/package-lock.json* ./

# Rewrite file: dependency paths for the Docker build context
RUN sed -i 's|file:../validation|file:/deps/validation|' package.json && \
    sed -i 's|file:../odata-expression-parser|file:/deps/odata-expression-parser|' package.json && \
    sed -i 's|file:../odata-client|file:/deps/odata-client|' package.json && \
    sed -i 's|file:../odata-expression-parser|file:/deps/odata-expression-parser|' /deps/odata-client/package.json

# Build dependencies first so dist/ exists when npm resolves file: links
RUN cd /deps/validation && npm install && npx tsc && \
    cd /deps/odata-expression-parser && npm install && npx tsc && \
    cd /deps/odata-client && npm install && npx tsc

RUN npm ci --ignore-scripts || npm install

COPY reso-web-client/ ./
RUN npx vite build

# Stage 2: Serve with nginx
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html

# nginx config template — API_UPSTREAM is substituted at container startup
# by the nginx entrypoint's envsubst mechanism (20-envsubst-on-templates.sh).
# Default: "server:8080" (matches the default docker-compose service name).
# Override via environment variable to point at a different backend service.
ENV API_UPSTREAM=server:8080

COPY reso-web-client/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80
