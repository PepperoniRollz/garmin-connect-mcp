# Multi-stage build: compile TypeScript, then ship a slim production image
# running as the unprivileged node user.

FROM node:lts-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:lts-slim
ENV NODE_ENV=production
WORKDIR /app
# /data holds the Garmin token cache, auth DB, and lift DB (mounted as named volumes;
# pre-created here so first mount inherits node-user ownership).
RUN mkdir -p /data/tokens /data/auth /data/lifts && chown -R node:node /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
