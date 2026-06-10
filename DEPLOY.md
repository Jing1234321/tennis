# 二拍即合发布说明

这个网站需要后台实时读取 Tennishub / UBC 公开订场页面，所以要部署成 Web Service，不能只用静态网页托管。

## 推荐：Render Docker Web Service

1. 把这个文件夹推到一个 GitHub 仓库。
2. 打开 Render Dashboard，选择 New Web Service。
3. 连接 GitHub 仓库。
4. Language / Runtime 选择 Docker。
5. 服务名可以用 `er-pai-ji-he`。
6. 部署后 Render 会给一个 `https://你的名字.onrender.com` 地址。

项目里已经准备好：

- `Dockerfile`：包含 Node 服务和 Playwright 浏览器环境。
- `render.yaml`：Render Blueprint 配置。
- `package.json`：生产启动命令 `npm start`。

## 重要

- 不要部署成 Static Site，否则 `/api/availability` 不会工作。
- 免费实例可能会休眠，第一次打开会慢一点。
- 官网页面结构如果以后改版，Tennishub/UBC 抓取逻辑可能需要跟着调整。
