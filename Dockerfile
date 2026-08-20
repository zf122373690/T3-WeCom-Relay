FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js wxplugin.js index.html admin.html proxy-exit.js ./
COPY assets ./assets
RUN mkdir -p logs
ENV PORT=18081
EXPOSE 18081
CMD ["node", "server.js"]
