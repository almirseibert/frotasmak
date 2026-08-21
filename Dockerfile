FROM node:18-alpine

# Fuso oficial do sistema: Brasília (GMT-3). tzdata fornece /usr/share/zoneinfo
# para que os métodos locais de Date (getHours/getDay/getDate) usem BRT.
RUN apk add --no-cache tzdata
ENV TZ=America/Sao_Paulo

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]