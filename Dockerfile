FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.js ./
COPY static ./static
ENV NODE_ENV=production
EXPOSE 8080
RUN mkdir -p /app/data && chown -R node:node /app
USER node
LABEL org.opencontainers.image.source="https://github.com/LCalrissian/HyperDeck-Vibe"
CMD ["node", "server.js"]