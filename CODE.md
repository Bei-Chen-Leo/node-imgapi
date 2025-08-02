# 运行文档
最简单的方式就是直接
```shell
git clone https://github.com:FurCraft-Official/node-imgapi.git
cd node-imgapi
npm install
node app
```
---
## 配置
在config文件夹下会有一个json的配置文件
web是关于网页运行，dir定义了图片跟web的目录，剩下的就关于缓存了  
那些名字都顾名思义，~~不要告诉我你不认识，不认识就去bing啊~~  
还需要创建一个.env写入UPDATE_TOKEN=your_token用于刷新list.json  

我也懒得另外去说这些配置了  

---
## docker
没错，我们还有docker版本  
~~能跑起来就不错了~~  

运行
```shell
git clone https://github.com:FurCraft-Official/node-imgapi.git
cd node-imgapi
docker build -t 镜像名 .
```
~~你问我为什么要自己build，因为我懒~~  

然后运行  

```shell
docker run -d \
  -p 3000:3000 \
  -p 3001:3001 \
  -v /home/config:/app/config \ 
  -e UPDATE_TOKEN=your_token  \
  --name 容器名 \
  镜像名

```
-p 3001可要可不要，因为那至是https端口 

-e的your_token是用来刷新list.json的token  

---
就这样  

没了
