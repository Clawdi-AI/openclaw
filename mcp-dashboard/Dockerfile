FROM node:22-alpine
WORKDIR /app

RUN npm install @modelcontextprotocol/sdk@latest && \
    rm -rf /root/.npm /tmp/*

COPY dashboard.js .

ENV PORT=18790
EXPOSE 18790

HEALTHCHECK --interval=10s --timeout=5s CMD wget -qO- http://localhost:${PORT}/health || exit 1
CMD ["node", "dashboard.js"]
