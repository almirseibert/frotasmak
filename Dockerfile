# Usa a imagem base do Node.js
FROM node:18-alpine

# Define o diretório de trabalho no contêiner
WORKDIR /app

# Copia o package.json e o package-lock.json para o diretório de trabalho
COPY package*.json ./

# Instala as dependências
RUN npm install

# Copia o restante dos arquivos do seu backend
COPY . .

# Expõe a porta que o seu servidor Node.js vai rodar
EXPOSE 3300

# Comando para iniciar o servidor
CMD ["node", "server.js"]