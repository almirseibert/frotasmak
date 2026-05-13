FROM node:18-slim

# Chromium e dependências para Puppeteer no Debian Slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer usará o Chromium do sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

EXPOSE 3002

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]