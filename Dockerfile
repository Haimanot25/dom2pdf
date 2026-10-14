# dom2pdf production image.
#
# Base image is pinned to the same Playwright release as the dependency
# (playwright 1.64.0 → v1.64.0) so the bundled Chromium build matches exactly
# what the library expects. Chromium's sandbox stays enabled: dom2pdf
# launches with `chromiumSandbox: true`, and the runtime user below is
# non-root so the sandbox actually works.

FROM mcr.microsoft.com/playwright:v1.64.0-noble AS build
WORKDIR /app

RUN corepack enable

# Manifests first — dependency install is cached until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/benchmark/package.json packages/benchmark/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.check.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm -r build

FROM mcr.microsoft.com/playwright:v1.64.0-noble AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/benchmark/package.json packages/benchmark/package.json
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/benchmark/dist packages/benchmark/dist
COPY --from=build /app/apps/cli/dist apps/cli/dist

# Non-root: required for Chromium's sandbox (dom2pdf never disables it) and
# the right default for a service that renders untrusted documents.
RUN useradd --create-home --uid 10001 dom2pdf \
  && chown -R dom2pdf:dom2pdf /app
USER dom2pdf

ENTRYPOINT ["node", "apps/cli/dist/index.js"]
CMD ["--help"]
