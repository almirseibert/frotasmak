FROM node:18-alpine

# Fuso oficial do sistema: Brasília (GMT-3). tzdata fornece /usr/share/zoneinfo
# para que os métodos locais de Date (getHours/getDay/getDate) usem BRT.
# fontconfig + ttf-dejavu: exigidos pelo carimbo das Evidências de Campo (§5.6) —
# sem eles o librsvg do sharp renderiza texto acentuado como quadrado/vazio.
# Provado na Fase 0 (backend/_spike_evidencias/).
RUN apk add --no-cache tzdata fontconfig ttf-dejavu && fc-cache -f
ENV TZ=America/Sao_Paulo

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]