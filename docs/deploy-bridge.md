# 部署 Jetson Bridge（`deploy:bridge`）

Bridge 源码在仓库 `bridge/easy_debug_bridge`，依赖 ROS 2 Humble、Boost.Beast 与标准 ROS 消息包。Jetson 上的 colcon 工作区可能与仓库不同步——**不要**用 ad-hoc `scp` / `rsync` 整目录覆盖远端 package，也不要把「colcon 成功」当成「当前进程已更新」。

## 推荐命令

```bash
npm run deploy:bridge -- --dry-run
npm run deploy:bridge -- --backup
npm run deploy:bridge -- --skip-sync --skip-build --restart
```

脚本：`scripts/deploy-bridge.mjs`（`npm run deploy:bridge`）。流程概览：比较 → 同步 → `colcon build` → 校验；可选备份与重启。

## 默认参数（对齐 damiao Profile）

| 项 | 默认 |
|---|---|
| SSH host | `damiao` |
| 远端工作区 | `/home/jialiang/easy_debug_bridge`（同步到 `src/easy_debug_bridge/`） |
| ROS overlay | `/home/jialiang/Project/leader_follower/install/setup.bash` |
| 端口 | `8765` |

可用 `--host` / `--remote` / `--ros-setup` / `--port` 或环境变量 `BRIDGE_DEPLOY_*` 覆盖。默认**不加** rsync `--delete`，以保留远端自定义消息/扩展；需要清理时再加 `--delete`。

更多 flags 见：

```bash
node scripts/deploy-bridge.mjs --help
```

## 部署后校验（脚本默认打印）

1. `ros2` 解析到的 `bridge_node` 是否位于远端 `install/` 树
2. `/proc/<pid>/exe` 是否与解析到的安装二进制一致
3. 是否监听 `127.0.0.1:8765`
4. 不一致时必须显式 `--restart` 才会替换进程；不要手动 `pkill` 误伤其他节点
5. 桌面端重连，或 `node scripts/smoke-bridge.mjs <localPort>`

阶段失败会标注 `ssh` / `compare` / `backup` / `sync` / `build` / `verify` / `restart`。

## 首次手工初始化（可选）

脚本也会 `mkdir -p` 远端 package 目录。若需手工建工作区：

```bash
mkdir -p ~/easy_debug_bridge/src
# 推荐用 npm run deploy:bridge，而不是整目录 cp 覆盖
cd ~/easy_debug_bridge
source /opt/ros/humble/setup.bash
colcon build --symlink-install --packages-select easy_debug_bridge
```

## 测试

`npm run test:deploy` 覆盖参数解析、rsync 参数、远端脚本与校验输出解析，**不要求**真实 Jetson。现场可达时再跑完整 deploy + `--restart`。

桌面端日常拉起 Bridge 仍由连接流程中的 `start_session` 负责；本脚本负责让远端 **install 树**保持最新。
