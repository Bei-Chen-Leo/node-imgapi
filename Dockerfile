# 使用官方轻量的 Node.js Alpine 镜像
FROM node:18-alpine

# 创建并设置工作目录
WORKDIR /app

# 复制依赖文件并安装依赖
COPY package*.json ./
RUN npm install --production

# 复制全部项目文件
COPY . .

# 声明匿名卷挂载点（数据持久化）
VOLUME ["/app/img", "/app/html", "/app/ssl"]

# 设置环境变量（建议实际使用时用 docker run -e 传入）
ENV UPDATE_TOKEN=your_token

# 暴露端口（根据 config.json 配置）
EXPOSE 3000 3001

# 启动服务
CMD ["node", "app.js"]
