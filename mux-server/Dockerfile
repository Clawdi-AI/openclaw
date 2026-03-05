FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile

EXPOSE 18891
CMD ["node", "--import", "tsx", "mux-server/src/server.ts"]
