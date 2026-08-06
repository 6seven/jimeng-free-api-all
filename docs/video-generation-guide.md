# 参考图片生成视频调用指南

本文说明如何调用当前局域网部署的 Jimeng Free API，根据参考图片和提示词生成视频。

## 服务信息

- 服务地址：`http://192.168.2.157:8001`
- 视频接口：`POST /v1/videos/generations`
- 健康检查：`GET /ping`
- 鉴权方式：`Authorization: Bearer <sessionid>`

先检查服务是否可用：

```bash
curl --fail-with-body "http://192.168.2.157:8001/ping"
```

正常结果为：

```text
pong
```

## 局域网服务器部署

当前部署目标：

| 项目 | 值 |
| --- | --- |
| SSH 地址 | `dwolf@192.168.2.157` |
| 系统架构 | Linux `x86_64` / Docker `amd64` |
| 局域网地址 | `http://192.168.2.157:8001` |
| 容器名称 | `jimeng-free-api` |
| 镜像标签 | `jimeng-free-api:962b18e` |
| 数据卷 | `jimeng-data` |
| 资源限制 | 2 CPU、4 GB 内存 |
| 重启策略 | `unless-stopped` |
| 发布目录 | `/home/dwolf/apps/jimeng-free-api/releases/962b18e-20260806` |

### 1. Docker 权限

服务器用户需要有 Docker 权限。如果执行 `docker ps` 提示无法访问 `/var/run/docker.sock`，在自己的终端执行：

```bash
ssh dwolf@192.168.2.157 'sudo usermod -aG docker dwolf'
```

该命令会要求输入服务器 sudo 密码。完成后断开并重新建立 SSH 连接，使用户组权限生效。

Docker 用户组具有接近 root 的权限，只应授予可信用户。

### 2. 创建发布目录

每次部署使用独立发布目录，避免直接覆盖上一版源码：

```bash
ssh dwolf@192.168.2.157 \
  'mkdir -p "$HOME/apps/jimeng-free-api/releases/962b18e-20260806"'
```

发布目录名称建议使用 Git commit 和日期，例如 `962b18e-20260806`。

### 3. 传输构建文件

在本地项目根目录执行：

```bash
rsync -az \
  Dockerfile \
  .dockerignore \
  package.json \
  yarn.lock \
  tsconfig.json \
  libs.d.ts \
  configs \
  public \
  src \
  dwolf@192.168.2.157:/home/dwolf/apps/jimeng-free-api/releases/962b18e-20260806/
```

不要上传以下内容：

- `.env`
- `.git`
- `logs*.txt`
- `logs/`
- `data/`
- `node_modules/`
- `dist/`

Session ID 只保存在调用端，通过请求头传入，不需要复制到服务器。

### 4. 在服务器构建镜像

服务器是 `amd64`，使用以下命令构建：

```bash
ssh dwolf@192.168.2.157 \
  'docker build --platform linux/amd64 \
    -t jimeng-free-api:962b18e \
    "$HOME/apps/jimeng-free-api/releases/962b18e-20260806"'
```

镜像标签应使用固定 commit，不要在正式部署中只使用 `latest`。

### 5. 启动局域网容器

首次部署执行：

```bash
ssh dwolf@192.168.2.157 \
  'docker run -d --init \
    --name jimeng-free-api \
    --restart unless-stopped \
    --cpus 2 \
    --memory 4g \
    -p 192.168.2.157:8001:8000 \
    -v jimeng-data:/app/data \
    -e TZ=Asia/Shanghai \
    -e SERVER_ENV=dev \
    -e SERVER_HOST=0.0.0.0 \
    -e SERVER_PORT=8000 \
    jimeng-free-api:962b18e'
```

端口绑定到 `192.168.2.157`，局域网设备可以通过 `http://192.168.2.157:8001` 访问。不要在路由器上把 `8001` 映射到公网。

当前仓库只有 `configs/dev` 配置，所以部署时明确使用 `SERVER_ENV=dev`。这不代表服务可以忽略生产安全要求。

### 6. 部署验证

从本机检查局域网访问：

```bash
curl --fail-with-body "http://192.168.2.157:8001/ping"
curl --fail-with-body "http://192.168.2.157:8001/dashboard/status"
curl --fail-with-body "http://192.168.2.157:8001/v1/models"
```

检查容器状态：

```bash
ssh dwolf@192.168.2.157 \
  'docker ps --filter name=^/jimeng-free-api$'

ssh dwolf@192.168.2.157 \
  'docker inspect jimeng-free-api \
    --format "status={{.State.Status}} restarts={{.RestartCount}}"'
```

检查启动日志：

```bash
ssh dwolf@192.168.2.157 'docker logs --since 10m jimeng-free-api'
```

首次部署后立即打开 `http://192.168.2.157:8001` 设置管理员账号。初始化完成前，局域网中的其他设备也能调用 setup 接口。

### 7. 日常运维

查看实时日志：

```bash
ssh dwolf@192.168.2.157 'docker logs -f jimeng-free-api'
```

重启服务：

```bash
ssh dwolf@192.168.2.157 'docker restart jimeng-free-api'
```

停止和启动服务：

```bash
ssh dwolf@192.168.2.157 'docker stop jimeng-free-api'
ssh dwolf@192.168.2.157 'docker start jimeng-free-api'
```

查看持久卷：

```bash
ssh dwolf@192.168.2.157 'docker volume inspect jimeng-data'
```

删除容器不会自动删除 `jimeng-data`。不要执行 `docker volume rm jimeng-data`，除非已经备份并确认要删除管理员账号、统计、日志和媒体记录。

### 8. 重新部署

先使用新的 commit 标签构建镜像，再替换容器。以下示例中的 `<new-tag>` 和 `<new-release-path>` 必须替换为实际值：

```bash
ssh dwolf@192.168.2.157 \
  'docker build --platform linux/amd64 \
    -t jimeng-free-api:<new-tag> \
    <new-release-path>'
```

确认新镜像构建成功后再替换：

```bash
ssh dwolf@192.168.2.157 \
  'docker stop jimeng-free-api && \
   docker rm jimeng-free-api && \
   docker run -d --init \
     --name jimeng-free-api \
     --restart unless-stopped \
     --cpus 2 \
     --memory 4g \
     -p 192.168.2.157:8001:8000 \
     -v jimeng-data:/app/data \
     -e TZ=Asia/Shanghai \
     -e SERVER_ENV=dev \
     -e SERVER_HOST=0.0.0.0 \
     -e SERVER_PORT=8000 \
     jimeng-free-api:<new-tag>'
```

新容器继续使用原有 `jimeng-data`，管理员账号和统计数据会保留。旧镜像标签仍在服务器上，可以用同样的启动命令切回旧版本。

## Session ID

本地项目根目录的 `.env` 使用以下格式：

```dotenv
SESSIONID=你的即梦_sessionid
```

调用前加载变量：

```bash
source .env
```

应用服务本身不会自动读取这个 `.env`。Session ID 必须由调用方通过 `Authorization` 请求头发送。

多个账号可以使用英文逗号分隔：

```dotenv
SESSIONID=sessionid_1,sessionid_2
```

检查积分：

```bash
curl --fail-with-body \
  -X POST "http://192.168.2.157:8001/token/points" \
  -H "Authorization: Bearer $SESSIONID"
```

## 推荐参数

首次测试建议使用：

| 参数 | 推荐值 | 说明 |
| --- | --- | --- |
| `model` | `jimeng-video-seedance-2.0-mini` | 优先使用成本较低的模型测试 |
| `ratio` | `16:9` | 横屏视频 |
| `resolution` | `720p` | 降低首次测试的积分和资源消耗 |
| `duration` | `5` | 首次测试建议 5 秒 |
| `response_format` | `url` | 避免 Base64 视频占用大量内存 |

支持的常用比例：

- `16:9`
- `9:16`
- `1:1`
- `4:3`
- `3:4`
- `21:9`

分辨率和时长最终取决于所选模型及账号权益。不支持的分辨率会调整为模型默认值；积分不足时，服务会尝试降低时长或分辨率。

## 单张本地参考图

单张图片会作为视频首帧。图片路径必须是调用命令所在电脑上的绝对路径。

```bash
source .env

curl --fail-with-body \
  -X POST "http://192.168.2.157:8001/v1/videos/generations" \
  -H "Authorization: Bearer $SESSIONID" \
  -F "model=jimeng-video-seedance-2.0-mini" \
  -F "prompt=让画面中的人物自然转头，头发随风摆动，镜头缓慢推进，生成5秒视频" \
  -F "ratio=16:9" \
  -F "resolution=720p" \
  -F "response_format=url" \
  -F "reference=@/Users/dwolf/Desktop/reference.png"
```

将 `/Users/dwolf/Desktop/reference.png` 替换为实际图片路径。

### Multipart 时长限制

当前接口会把 multipart 表单字段解析为字符串，但 `duration` 校验要求数字。因此下面的写法会校验失败：

```bash
-F "duration=5"
```

使用本地文件上传时，不要传 multipart `duration`。需要 5 秒视频时，在 prompt 中明确写入“生成5秒视频”。需要严格传递数值时，使用后面的 JSON 请求方式。

## 本地首尾帧

第一张图片作为首帧，第二张图片作为尾帧。使用不同字段名上传，保持字段顺序为首帧、尾帧：

```bash
source .env

curl --fail-with-body \
  -X POST "http://192.168.2.157:8001/v1/videos/generations" \
  -H "Authorization: Bearer $SESSIONID" \
  -F "model=jimeng-video-seedance-2.0-mini" \
  -F "prompt=从首帧自然过渡到尾帧，动作连贯，镜头稳定，生成5秒视频" \
  -F "ratio=16:9" \
  -F "resolution=720p" \
  -F "response_format=url" \
  -F "first_frame=@/Users/dwolf/Desktop/first.png" \
  -F "end_frame=@/Users/dwolf/Desktop/end.png"
```

服务只把前两张成功上传的图片分别作为首帧和尾帧。不要发送多余图片。

## 网络参考图

参考图已经有可公开访问的 HTTPS URL 时，可以使用 JSON 请求。JSON 中的 `duration` 必须是数字，不要加引号。

```bash
source .env

curl --fail-with-body \
  -X POST "http://192.168.2.157:8001/v1/videos/generations" \
  -H "Authorization: Bearer $SESSIONID" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jimeng-video-seedance-2.0-mini",
    "prompt": "让画面中的人物自然转头，头发随风摆动，镜头缓慢推进",
    "ratio": "16:9",
    "resolution": "720p",
    "duration": 5,
    "file_paths": [
      "https://example.com/reference.png"
    ],
    "response_format": "url"
  }'
```

首尾帧使用数组顺序表示：

```json
{
  "file_paths": [
    "https://example.com/first.png",
    "https://example.com/end.png"
  ]
}
```

第一项是首帧，第二项是尾帧。

## 响应格式

成功响应示例：

```json
{
  "created": 1786000000,
  "data": [
    {
      "url": "https://example.com/generated-video.mp4",
      "revised_prompt": "让画面中的人物自然转头"
    }
  ]
}
```

生成任务可能持续数分钟。调用端不要设置过短的请求超时。

不建议对视频使用以下参数：

```json
{
  "response_format": "b64_json"
}
```

Base64 视频会显著增加服务端和客户端的内存占用。优先使用 `url`。

## 常见问题

### `Params body.duration invalid`

原因是 multipart 中的 `duration` 被解析成字符串。删除 `-F "duration=5"`，在 prompt 中写明时长，或改用 JSON 请求。

### Session ID 无效

重新登录即梦官网，在浏览器开发者工具的 `Application`、`Cookies` 中获取最新的 `sessionid`，然后更新本地 `.env`。

### 积分不足

服务会尝试降低视频时长和分辨率。仍然失败时，需要等待每日积分刷新、切换账号或使用更低成本的模型。

### 首帧上传失败

确认本地路径存在、当前用户有读取权限，并且文件小于 100 MB。网络图片需要能够从服务器访问。

## 安全规则

- 不要把真实 Session ID 写入命令示例、聊天记录或 Git 提交。
- `.env` 权限应保持为 `600`，并确保被 `.gitignore` 和 `.dockerignore` 忽略。
- 当前服务使用局域网 HTTP，只能在可信局域网中使用。
- 不要把服务器 `8001` 端口映射到公网。
- 网络参考图只使用可信 HTTPS 地址。
- 当前服务存在任意 URL 获取风险，公网部署前必须增加 URL 白名单和内网地址拦截。
- 管理后台应立即完成管理员初始化，避免其他局域网用户抢先设置。
