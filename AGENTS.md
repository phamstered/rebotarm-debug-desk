# Easy Debug 开发约束

## 强制测试规则

**所有功能的变更，都需要执行所有单元测试并保证通过。**

- 完成任何功能新增、修改、修复或重构后，必须在项目根目录执行 `npm test`。
- `npm test` 必须完整运行前端 Vitest、Tauri/Rust 测试和 ROS Bridge 核心 C++ 测试；不得只运行受影响的单个测试文件作为最终验证。
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
```
