# Usa uma imagem base oficial do Node.js
FROM node:20-alpine

# Define o diretório de trabalho no contêiner
WORKDIR /app

# Copia package.json (Base Directory = prp-main, então ele vê package.json diretamente)
COPY package*.json ./ 

# Instala as dependências
RUN npm install --omit=dev

# Copia o restante do código para o contêiner
COPY . . 

# Expõe a porta que o Node.js usa (3000)
EXPOSE 3000

# Comando para iniciar o servidor (conforme seu package.json)
CMD ["npm", "start"]
