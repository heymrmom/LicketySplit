FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile --filter @openreel/web...
RUN pnpm build

FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.title="LicketySplit"
LABEL org.opencontainers.image.source="https://github.com/heymrmom/LicketySplit"
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node apps/web/functions ./apps/web/functions
COPY --chown=node:node hosting/railway/server.mjs ./hosting/railway/server.mjs
COPY --chown=node:node LICENSE ./LICENSE
USER node
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "hosting/railway/server.mjs"]
