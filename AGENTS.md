# Robot Console 开发约束

## 强制测试规则

**所有功能的变更，都需要执行所有单元测试并保证通过。**

- 完成任何功能新增、修改、修复或重构后，必须在项目根目录执行 `npm test`。
- `npm test` 必须完整运行前端 Vitest、Tauri/Rust 测试、ROS Bridge 核心 C++ 测试和 Bridge 部署脚本测试；不得只运行受影响的单个测试文件作为最终验证。
- 任一单元测试失败时，不得声明任务完成，也不得通过删除、跳过或弱化有效断言来掩盖失败。
- 生产代码行为发生变化时，必须同步新增或更新对应单元测试和 `docs/basic-features.md` 功能清单。
- 涉及 TypeScript/React 或打包配置的变更，在全量单元测试通过后还必须执行 `npm run build`。
- 涉及 Jetson ROS Bridge 的变更，除本地全量单元测试外，还应在可用环境中执行 ROS 2 构建/测试和必要的隔离 Topic 验证；真实电机测试必须遵循安全确认要求。

## 测试入口

```bash
npm test
npm run build
```

分层入口仅用于开发定位：

```bash
npm run test:frontend
npm run test:rust
npm run test:bridge
npm run test:deploy
```

## Jetson Bridge 部署（脚本优先）

仓库中的 `bridge/easy_debug_bridge` 与 Jetson colcon 工作区（默认 `/home/jialiang/easy_debug_bridge`）可能不一致。**不要**用 ad-hoc SSH/`scp`/`rsync` 整目录覆盖远端 package，也不要把 “colcon 成功” 当成 “当前进程已更新”。

统一使用：

```bash
npm run deploy:bridge -- --dry-run
npm run deploy:bridge -- --backup
npm run deploy:bridge -- --skip-sync --skip-build --restart
```

脚本：`scripts/deploy-bridge.mjs`。默认对齐 damiao Profile：SSH host `damiao`，远端根目录 `/home/jialiang/easy_debug_bridge`（同步到 `src/easy_debug_bridge/`），ROS overlay `/home/jialiang/Project/leader_follower/install/setup.bash`，端口 `8765`。可用 `--host` / `--remote` / `--ros-setup` / `--port` 或 `BRIDGE_DEPLOY_*` 覆盖。默认不加 rsync `--delete`，保留远端自定义消息/扩展。

部署后校验清单（脚本默认打印）：

1. `ros2` 解析到的 `bridge_node` 是否位于远端 `install/` 树
2. `/proc/<pid>/exe` 是否与解析到的安装二进制一致
3. 是否监听 `127.0.0.1:8765`
4. 不一致时必须显式 `--restart` 才会替换进程；不要手动 `pkill` 误伤其他节点
5. 桌面端重连或 `node scripts/smoke-bridge.mjs <localPort>`

阶段失败标注 `ssh` / `compare` / `backup` / `sync` / `build` / `verify` / `restart`。`npm run test:deploy` 不要求真实 Jetson；现场可达时再跑完整 deploy + `--restart`。
