# macOS 安装（`install:mac`）

将 release 版桌面应用安装到本机 Applications。

## 一键安装

```bash
npm run install:mac
```

脚本会：

1. 执行 `npm run tauri build` 生成 release 版 **Robot Console.app**
2. 原子安装到 `/Applications/Robot Console.app`
3. 更新已有安装时，在新版本复制完成后再替换；**安装失败则恢复旧版本**

仅需生成安装包、不写入 `/Applications` 时：

```bash
npm run tauri build
```

## 显示名说明

用户面向产品名为 **Rebotarm Debug Desk**；当前代码侧 Tauri `productName`、窗口标题与 `/Applications` 包名仍为 **Robot Console**（`Robot Console.app`）。文档不会静默改代码侧显示名。

## 开发与调试包

日常开发：

```bash
npm install
npm run tauri dev
```

调试版 `.app` 路径：

```text
src-tauri/target/debug/bundle/macos/Robot Console.app
```

## 验证

涉及安装脚本或打包行为的变更，须在全量测试中覆盖：

```bash
npm test
npm run build
```

其中 `npm run test:install` 覆盖 `install:mac` 安装与失败回滚逻辑（不要求真实签名分发）。
