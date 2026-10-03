# claude-remote

在手机浏览器里远程使用 Mac 上的 Claude Code：每个项目一个终端，断线重连不丢输出。

## 架构

```
手机浏览器 ──HTTPS──> CDN ──> 云服务器 nginx ──frp 隧道──> Mac
                                                          ├── relay-server :7691  WebSocket 中继 + 鉴权 + 输出缓存
                                                          ├── file-server  :7690  项目文件列表 / 下载 / 上传
                                                          └── ttyd :7682-7689     每个项目一个，按需懒启动
                                                                 └── zsh → claude -c
```

1. `/claude/` 返回项目选择页 `web/index.html`，项目列表来自 `/files/api/projects`
2. 进入 `/claude/{project}/` 返回 `web/terminal.html`，建立 `wss://.../claude/{project}/ws`
3. relay-server 校验密码，按需拉起该项目的 ttyd，把浏览器和 ttyd 桥接起来；缓存最近 512 KB 输出，重连后回放

项目清单的唯一来源是 `config/projects.json`，relay-server、file-server、选择页三方共用，改文件即时生效（`fs.watchFile`）。

## 部署

1. Mac：`brew install ttyd node`，`cd scripts && npm install`，frpc 二进制放到 `bin/frpc`
2. 复制 `config/projects.example.json` → `config/projects.json`，`deploy/frpc.example.toml` → `config/frpc.toml` 并填好
3. 设置环境变量 `ADMIN_PASSWORD`（总密码）；项目里的 `password` 字段是只能进该项目的专属密码
4. 服务器：跑 frps，nginx 参照 `deploy/nginx.example.conf`，把 `web/*.html` 放到 `/usr/share/nginx/html/claude/`
5. 启动：`scripts/start-remote.sh`；常驻用 launchd 调 `scripts/supervisor.sh`（前台 exec relay-server，进程退出由 KeepAlive 重拉）

## 安全须知

- 鉴权全部在 relay-server（同一 IP 连错 5 次锁 60 秒）；选择页只负责把密码存进 localStorage，终端页连接时带上
- **file-server 目前没有鉴权**，公网暴露时请在 nginx 上给 `/files/` 加一层认证，或只在内网使用
- 终端以 `--dangerously-skip-permissions` 运行 Claude Code，等同把这台电脑的 shell 交给持有密码的人
