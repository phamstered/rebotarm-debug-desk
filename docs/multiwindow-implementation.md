# 多窗口实现记录（进行中）

跟踪 Issue：[#260](https://github.com/phamstered/rebotarm-debug-desk/issues/260)。本文件是开发记录，不代表已发布功能。当前分支已接入原生传输和页面拆收入口，正在独立应用 `dev.easydebug.multiwindowtest` 中验证；`/Applications/Robot Console.app` 尚未更新。八项公共查询、运动日志、Position/Pick 的原生任务归属与终态恢复、Monitor 独立历史已接入 Rust；其他控制任务与完整离线配置切换仍未完成，不能按已交付多窗口功能验收。

## 完整交付范围

九个导航页面均可拆出、聚焦、收回，关闭保留数据；每个功能一个实例。所有窗口共享一个 Rust 管理的 Bridge WebSocket 与 SSH 隧道，公共轮询、订阅、任务协调和缓存独立于主窗口生命周期。副屏失焦不暂停展示；隐藏窗口停止绘制，任务按既有安全规则处理。运动或采样进行中禁止迁移相应页面。恢复窗口布局但不恢复运动授权。

图像、点云保持二进制，按兴趣分发和最新帧覆盖；ACK、故障、任务终态可靠交付。Monitor 采集与显示分离；模型资源共用字节缓存，场景只在实际展示窗口创建。所有既有反馈、控制器、时钟、限位及现场确认门禁继续有效。

## 已编写的基础模块

`src-tauri/src/session/`：

- `transport.rs`：原生 loopback WebSocket 客户端，hello 核验、请求关联、取消/DISABLE 保留容量、断连与超时清理，不自动重试未知执行结果。通过 runtime/ipc 接入桌面，连接入口只使用 SSH session 返回的实际端口。
- `wire.rs`：保留 RCI1/RCR1/RCD1/RCT1 二进制帧，核验元数据类型与长度，不把图像转换成 Base64。
- `delivery.rs`：每窗口有界队列，可靠消息优先，预览每流最多保留一帧。可靠队列溢出返回明确错误，由调用方处理窗口失联，不能静默丢弃 ACK。IPC 已采用单个在途拉取，不把积压转移到 WebView Channel 内部。
- `subscriptions.rs`：按窗口代次和组件消费者引用合并 Topic 订阅；每个 Topic 串行等待上游 ACK；区分期望订阅与已确认订阅。关闭/重开窗口期间旧响应不重新授权新窗口。当前 Bridge 仅支持 Image unsubscribe，普通 Topic 最后消费者离开后不再分发，但保留上游订阅至会话断开。
- `windows.rs`：九页面窗口白名单、窗口 incarnation 核验、窗口恢复位置约束。窗口身份必须来自 Tauri 实际调用窗口，不能只信任前端传入 token。

- `runtime.rs` / `ipc.rs` 与 `nativeBridgeLogic.ts`：真实调用窗口鉴权、共享连接、按消费者合并订阅、独立 ACK 请求和有界长轮询；跨 IPC 帧龄保留。原生帧二进制头为 17 字节，见协议。URDF 在订阅 ACK 前到达也会保留，并支持后加入窗口复用。

## 待接入和验收

1. 原生会话与前端适配器已接通并有跨窗口模拟测试。后续必须补全窗口异常退出时的任务所有权/安全停止；原生共享资源缓存与 Monitor 独立历史已接入，Monitor 在最新帧合并前保存有界采样历史。
2. Agent、USB、arm mode、Controller、Topics、clock、Motion、Pick 八项公共状态/轮询已移到原生会话。rosbag 状态、其他任务生命周期和共享编辑数据仍待抽离；手眼原始样本不随窗口复制，页面编辑须有明确单写者和版本。
3. 页面路由、拆出、收回、关闭拦截已接入。采用同一个原生 WebView reparent，迁移时不复制/重建 React、样本或 GPU 场景；原生调用者鉴权也改为稳定 WebView 身份。布局持久化、工作区变化后的窗口约束及主窗口隐藏/恢复已接入；迁移失败回滚已接入并进行原生故障验证；实际拔屏、多屏仍待验证。
4. 窗口菜单与全部九页面接入；执行/采样中禁止迁移；全局任务状态一致；主窗口关闭不终止其他窗口会话。
5. 图像/点云和 Monitor 展示按窗口兴趣驱动；共享资源缓存已接入；刷新限流、源数据新鲜度门禁继续验收。
6. 全量单元测试、构建、原生多窗口视觉验收；三窗口及九窗口、50 次拆收、30 分钟内存稳定性、断线/慢消费者/崩溃/外接屏验证。确认 CI 后按仓库流程合并、安装。

尚未验证多窗口运行时性能；Bridge 新协议仅在独立工作区验证，未部署到正式运行进程。隔离传输测试只监听本机随机回环端口，不发布真实机器人命令。

## 页面窗口接入记录

- 主窗口保留导航与连接入口；每个功能按需创建唯一的 `page-*` WebView，地址为 `index.html?page=<白名单页面>`。独立窗口为 `detached-page-*`，关闭请求执行收回，不销毁页面。
- 页面通过 `native_bridge_context` 获取共享连接代次，附着自己的消费者；断线清理实时数据、保留本页编辑内容。旧代次发现/附着结果不会写入新会话。
- 拆收按钮展示阻止原因；手眼采样/求解、Joint4 姿态保持、Episode 采集/保存、Motor 预检/发送和运动任务报告忙状态。此处仍是前端状态上报，原生任务租约必须补齐才能保证跨窗口命令互斥及崩溃安全。
- 主窗口 HTML 弹层覆盖期间隐藏嵌入的原生页面，独立窗口不跟随隐藏。原生页面可见状态与 document visibility 共同控制绘制，失焦本身不会暂停。
- Motor 的隐藏/断线处理保留草稿、清除授权并发送 DISABLE；晚到预检不会重启定时发送。也修复了控制锁只改变 UI 指示而未清理定时器的问题。
- 首次原生验证：离线手眼页把格子边长改为 16 mm、生成标定板、切换到原始尺寸 100%，拆出后再收回，三个状态均保留。随后修复独立窗口宽度沿用原父窗口的问题，并在真实原生窗口确认右侧按钮与滚动条完整；关闭独立窗口收回后仍保留 16 mm 输入。整个九页面/多屏验收尚未完成。
- 已完成一轮全量单元测试（823 前端 / 79 Rust）和前端、独立原生 Debug bundle 构建；后续尺寸与页面安全修复需以新一轮结果为准。日志位于本机 `/tmp/260-workspace-*.log`、`/tmp/260-native-window-build.log`。


### macOS 尺寸兼容记录

本机 `tauri-runtime-wry 2.11.4` 的空 Window 在 reparent 后尚无 `has_children` 标志，`inner_size()` 会返回首个 WebView 的旧 frame。因此须在移入前读取空窗口大小，后续使用 `Resized/ScaleFactorChanged` 事件的真实尺寸。诊断曾记录新 1200 px 窗口内查询得到旧 1440 px 页面宽度，修复后已视觉复验。主窗口嵌入区域还需把 CSS viewport 换算到 WebView 原生 frame，保留 WebKit 的标题栏 inset，避免上移遮挡主窗口按钮；不硬编码标题栏高度。

最新一轮全量测试：828 前端、81 Rust 和其余全量脚本通过（`/tmp/260-workspace-verified-tests.log`）；`npm run build` 日志为 `/tmp/260-workspace-verified-build.log`。原生隔离构建为 `/tmp/260-native-window-build-5.log`，正式应用尚未安装。

## 共享查询接入记录

- `observations.rs` 在应用会话中统一调度六个固定只读来源，查询不依赖任何 WebView；每源串行执行，快照和错误限制大小。普通并发刷新合并，操作后复查强制排在旧查询后重新发起。
- 页面只订阅状态变更并读取快照；不同窗口的显示状态保留同一连接代次、递增版本和原始帧龄。过期处理本地执行，不发起远端请求。Controller 缓存/服务器等待与原生 IPC 等待分别计时，不能重复扣除或延长有效期。
- 断线取消在途只读查询，三个 SSH 探测进程启用 drop 时终止，旧会话结果不能写入新连接。原生 Topics 请求也复用公共来源，避免页面初次附着重复发现。
- 隔离测试覆盖九个消费者只产生一次查询、普通刷新合并、操作后新查询、无 WebView 时继续调度、断线取消、过期/错误、超大响应和前端旧响应隔离。全量测试日志 `/tmp/260-shared-polling-tests.log`，前端构建日志 `/tmp/260-shared-polling-build.log`。本阶段没有启动真实机械臂动作，也未更新正式安装包。

## 共享资源缓存记录

- `resources.rs` 把原始 RCR1 资源字节保存在 Rust 会话中，按完整 URI 与编码合并上游请求。最多 128 MiB / 512 项和 64 个在途 URI，按最近使用顺序淘汰；错误与超出单个缓存预算的响应不保留。
- 相同资源在各窗口之间复用同一个 Rust `Arc`；桌面 BridgeClient 只合并当前在途请求，不再各自持有长期 128 MiB 字节缓存。IPC 和 GPU 场景仍有各窗口所需的工作副本，不能据此声称整个应用只有一份模型内存。
- 单元测试覆盖九消费者、LRU 容量、队列压力、错误重试、URI 不匹配、断线取消及旧结果隔离。真实 loopback 假 Bridge 的两页面测试确认只产生一个上游资源请求，返回原始二进制。全量验证日志 `/tmp/260-resource-sharing-all-tests.log`。
- 下一步任务所有权须先于运动轮询迁移：`position_motion_info` 在 Bridge 内续租运动，不能让应用级无条件轮询在操作页面崩溃后继续替它续租。需结合原生租约、取消/停止确认、页面失联处理一起接入。

本阶段最终全量结果：837 前端 / 90 Rust 与其余全部测试通过，`npm run build` 通过（`/tmp/260-resource-sharing-build.log`）。缓存验证使用本机隔离 WebSocket，不连接生产 Jetson。

## 原生任务第一阶段：Position / Pick

- `tasks.rs` 在提交时登记占用，原生窗口身份、incarnation、连接代次及 command_id 关联；与拆收迁移共用互斥，消除仅依赖页面 busy 上报的竞态。尚未受理也阻止其他窗口提交执行命令；取消/DISABLE 不被占用挡住。
- 任务来源页面的 IPC 入口维护存活时间。5 秒未继续请求/拉取、页面会话退出或队列错误后，Rust 看门狗请求取消；其他窗口的 info/status 不能替它续租。取消 ACK 不释放占用，stop_failed/未知结果保留；任务终态按编号匹配，忽略 Pick 子步骤终态和旧代次响应。
- `command_queue.rs` 与发送器在写入前检查停止代次及任务许可。取消/DISABLE 可越过普通队列；停止之前已经排队、甚至尚未开始 poll 的旧执行请求不能在停止之后发送。迟到的原生取消不会撤销后继任务的排队许可。已发送的指令仍由 Bridge 取消和确认终态。
- `native_task_snapshot` / `native-tasks-changed` 提供所有窗口的状态提示，不依赖主 WebView 转发。查询快照不产生远端心跳。
- 隔离测试使用本机随机回环 WebSocket：两窗口实际验证单任务占用、拒绝代续租、所属页面退出触发取消，以及取消 ACK 后仍保持占用直到匹配终态。另覆盖未发送失败、未知受理、迁移竞争、旧响应、Pick 子任务和队列撤销。

下一阶段继续完成其他任务的原生生命周期；Position 的跨连接按 command_id 查询终态及只读查询/续租分离已在下节接入。Motor/直接 JTC 轨迹/重力辨识、Controller/arm mode/Joint4/采集/手眼本地操作的完整原生生命周期尚未接入，不能据此声称全局运动互斥及崩溃安全完成。九页面布局恢复、多屏与性能验收仍按上文完整范围推进。

本阶段验证：`npm test` 全部通过（840 前端、102 Rust 与其余脚本；`/tmp/260-native-task-verified-tests.log`），`npm run build` 通过（`/tmp/260-native-task-build.log`）；独立标识的 Debug Tauri bundle 构建及 `codesign --verify --deep --strict` 通过（`/tmp/260-native-task-bundle.log`）。尚未在原生窗口实际执行任务或验证新增状态提示的多窗口布局；正式应用与 Jetson 都未替换。


## 共享运动观察、日志及任务恢复

- `position_motion_observe` / `visual_pick_observe` 不刷新租约，由 Rust 分别每 1 秒 / 500 ms 统一调用。页面收到原生失效通知后读取缓存，不再各自远程轮询；离开主窗口不影响公共查询。
- Position 用专用 command_id 心跳，Pick 用既有 status 续租；只为已受理、实际所属窗口仍存活的任务发送。慢心跳不阻塞取消，旧任务响应不能影响后继任务。断线状态通知移到 Core 锁外，避免重入死锁。
- Bridge 保存至多 256 个 / 2 MiB 的完整 Position 终态（每项 256 KiB）；跨连接恢复必须匹配编号和状态，重启/淘汰导致未知时保留占用。恢复事件保留动作组元数据，不能以仅 busy=false 释放任务。
- Rust 运动日志至多 5000 项 / 2 MiB，按每窗口独立游标分页；截断、跨会话、非法序号及迟到响应均覆盖测试。缓存回复计入源年龄；抓取 UI 拒绝旧缓存重置任务，夹爪旧反馈不被重新续鲜。
- 验证环境：Mac loopback 假 Bridge；Jetson 独立 `~/easy_debug_bridge_260_motion_observe`，脚本同步、单线程 colcon 构建。ROS 测试使用测试文件明确限定的隔离域和模拟机器人，未向正式机械臂发送动作。构建保留 `-UNDEBUG`，确保 Release 测试中的 assert 生效。正式应用未更新。

本阶段合入 main 的 Release 断言与时间戳溢出测试修复后，全量 `npm test` 通过（845 前端 / 114 Rust 与其余脚本），前端、文档和独立 Debug Tauri bundle 构建、codesign 核验通过。日志为本机 `/tmp/260-integrated-main-{tests,build,docs-build,bundle}.log`。Jetson 完整 `colcon build` / `colcon test` / `colcon test-result --verbose` 通过：22 tests，0 errors，0 failures，0 skipped（`/tmp/260-integrated-main-ros-build-test.log`）。修复前的一次 ROS 测试因旧测试时间戳溢出停滞并被定向终止，不计为通过。

手眼页离线原生拆收验收已完成 40 次完整循环：16 mm 标定板参数、生成图片及 100% 缩放均保留。受前台焦点变化打断的批次未计数；其中一次主窗口仍显示“已在独立窗口打开”，聚焦独立窗口后内容完整。尚未完成 50 次及 30 分钟性能验收。过程中仅采样了父进程 RSS（约 119–170 MiB），不含 WebKit 子进程，不能据此声称整体内存稳定。正式应用和生产 Bridge 均未替换。

合并后的 Bridge build ID `e9be0475146b` 已通过实际随机 loopback 端口验证：两类只读观察、未知任务不解锁、未知心跳不续租，以及 4 项无效字段/编号负例。验证域为 166，只启动并清理自己的临时 Bridge 进程（`/tmp/260-integrated-main-smoke.log`）。

## 窗口布局及主窗口生命周期

- `layout.rs` 保存带版本和大小限制的窗口偏好，原子替换文件；未知页面、未来版本、无效坐标与损坏文件不进入运行状态。只有普通窗口位置/尺寸和拆出状态持久化，不保存执行授权。应用标识隔离配置目录。
- 主窗口关闭改为隐藏，嵌入页面收到不可见状态，独立窗口保持可用。“主窗口”按钮在采样等禁止迁移期间仍可使用；Dock Reopen 同样恢复主窗口，不收回独立页。
- 启动时创建已保存的独立页，收到 ready 后执行已有迁移流程；暂未 ready 的状态不覆盖保存的拆出偏好。显示器工作区变化后约束普通窗口，保存坐标包含负原点和窗口装饰尺寸；最小化、最大化、全屏不覆盖普通尺寸。
- 原生离线验证：生成标定板并设为 100%，拆出、关闭主窗口后图片及缩放仍在；从独立窗口恢复主窗口成功；退出/重开隔离应用后手眼页自动恢复为独立窗口。独立窗口右侧工具和滚动条完整。此次未验证真实连接跨主窗口关闭的连续性，也未实测多屏热插拔或修改后位置恢复。重启应用只恢复布局，不承诺恢复未保存图片/样本。
- 最终验证：`npm test` 通过（845 前端 / 117 Rust 与其余脚本），`npm run build`、`npm run docs:build`、独立 Debug Tauri bundle 及 codesign 通过；日志 `/tmp/260-window-layout-{all-tests,build,docs-build,bundle}.log`。本阶段未修改 Bridge。完整任务仍需其他控制生命周期、Monitor 历史、共享编辑、迁移失败回滚和全部性能/多屏验收。

### 迁移失败恢复

拆出、收回以同一页面为事务：记录父窗口、尺寸、可见性与焦点，逐步完成迁移；失败自动恢复。恢复未完成时保留窗口和页面，显示“恢复窗口”，禁止继续拆收，允许在无执行/采样占用后重试。重试只恢复该页面，保留其他窗口随后发生的布局及 busy 变化。只有确认窗口为空才清理，清理失败也不撤销已成功收回的页面。

本机原生故障注入发现两层运行库问题，已使用与锁文件同版本的 vendor 补丁，保留上游许可证与来源说明，不改全局 Cargo 缓存：

- `tauri-runtime-wry 2.11.4` 原实现会先移出源列表再调用原生迁移；改为成功后转移所有权，缺失/关闭目标返回错误，处理同父窗口请求，标记目标 child-WebView 状态，消除旧 frame 干扰窗口尺寸查询。
- `tauri 2.11.5` 原实现在 runtime 成功前修改父窗口记录。真实测试中关闭目标的延迟销毁事件会误删存活页面的 IPC 注册，出现“failed to acquire webview reference”，即使图片仍然可见。现在仅成功后提交父窗口记录。回归测试还原旧顺序确实失败（`/tmp/260-tauri-registration-before-fix.log`），修复后通过。

隔离应用 `dev.easydebug.multiwindowtest` 的 Debug 构建可读取其配置目录的单次 `migration-faults.json`，正式标识/Release 构建不读取。列表最多 10 项、文件最多 2 KiB；使用后改名为 `migration-faults.consumed.json`。例如 `['detach:bounds', 'rollback:reparent']`（写入时用 JSON 双引号）会在已移动页面后触发尺寸失败，再向真正已关闭的原生窗口发出回滚请求；不是只在 native 调用前返回一个模拟错误。

已在离线原生手眼页验证：生成 1200×900 标定板，输入 16 mm，缩放 100%；关闭目标引发拆出失败后可再次调用拆出；拆出和回滚双重失败显示恢复入口；恢复中途再次失败后仍可重试；收回尺寸失败回到原独立窗口；收回后的空窗口清理失败保留主窗口页面，关闭空窗口可再次清理。上述过程中输入、图片与缩放均保留。另补充失败重试的焦点恢复，使错误信息随当前承载页面的窗口显示。

本阶段不宣称原生进程被杀后可保留未保存的 JS 堆，不把可见截图等同于 IPC 可继续操作。仍待全部九页面、跨显示器、持续运行性能和其他任务生命周期验收。

最终原生复验：恢复中途再次失败会自动聚焦实际承载页面的窗口，错误及重试按钮直接可见；随后连续完成 **50 轮拆出＋收回（100 次迁移）**，每轮自动读取真实原生无障碍树，核对 16 mm（输入文本 `016`）、1200×900 标定板及 100% 缩放，均保留。该批操作墙钟约 127 秒，含工具调用开销，不能作为应用迁移延迟指标。保存独立窗口布局后退出并重新启动，手眼页自动恢复为独立窗口。重启只验证布局恢复，不宣称未保存表单或图片跨进程保留。

最终验证：`npm test` 通过（847 前端 / 122 Rust / 2 运行库测试与全部其余脚本），`npm run build`、独立 Debug Tauri bundle 和 `codesign --verify --deep --strict` 通过；日志 `/tmp/260-migration-{verified-tests,build,bundle}.log`。原生全程离线，没有连接生产 Bridge、发送机械臂指令或覆盖 `/Applications/Robot Console.app`。此阶段不修改 Bridge，未新增 ROS 部署。

## Monitor 独立历史

- Rust `monitor.rs` 在预览合并前捕获选定数值 Topic，原生订阅消费者不依赖 Monitor WebView 存活。最多 64 个 Topic、8192 帧 / 8 MiB；新样本到达时淘汰距其超过 30 秒的数据。每页 256 帧 / 512 KiB，超限单帧（64 KiB）建立明确缺口。
- 仅 Monitor 页面可配置和读取；连接代次、附着代次和独立游标校验。历史读取与普通 Bridge 消息回调分离，保留接收时刻，不向控制反馈回放历史。暂停停止采集，隐藏仅停止拉取/绘制；恢复分批补齐，截断会提示并重建曲线，配置/暂停边界重置诊断配对。
- 修复批量订阅中某 Topic 被拒绝时其余 ACK 未结算的问题；旧连接订阅超时只能关闭原代次，不能误关已建立的新连接。
- 实际 loopback 假 Bridge 验证 600 帧全部进入历史、预览只保留最新帧；页面退出后重开仍能读取原生保留历史，两个消费者只有一次上游订阅；断线与旧附着拒绝，订阅错误可恢复。前端覆盖迟到响应、隐藏/暂停恢复、原始帧龄、bag 倒退、截断和批量点数限制。
- 全量 `npm test` 通过：859 前端 / 128 Rust / 2 运行库测试与全部其余脚本（`/tmp/260-monitor-all-tests.log`）；前端、文档及独立 Debug Tauri bundle 构建通过（`/tmp/260-monitor-{build,docs-build,bundle}.log`），codesign 核验通过。
- 原生离线同时打开主窗口、手眼、Monitor，确认七张图的滚动区域与底部面板可见、暂停控件响应正常。CUA 滚轮接口报 `noWindowsAvailable`，改用实际窗口的 Page Down 完成滚动验证，进程未退出。此项不等于连接中历史补齐的原生端到端性能验收；采样完整性证据来自上述实际 WebSocket 集成测试。
- 本阶段复查发现各 App 实例仍可能用本地持久化覆盖 Monitor 配置；下文“Monitor 版本化配置”已处理此问题。正式应用与生产 Bridge 未修改。

### 收回后的离线入口

原生复验发现未连接时将 Monitor 收回会回到连接表单，缺少重开刚才页面的入口。连接表单新增“返回已打开页面”，只列出原生层已创建并 ready 的页面；通过同一个 `NativeWorkspaceHost` 恢复或聚焦，不创建第二份图表/编辑器，不自动连接、不授予运动权限。切回连接表单时隐藏嵌入页，独立窗口不受影响。

已在最新隔离应用实际完成“暂停 Monitor → 收回 → 返回已打开页面 → 再次拆出”，两次迁移后仍为同一七面板仪表盘且保留暂停状态；主窗口离线下拉与页面拆出按钮完整可见。全量测试 861 前端 / 128 Rust / 2 运行库测试及其余脚本通过；前端、文档、独立 Debug bundle 与 codesign 均通过，日志 `/tmp/260-offline-workspace-{all-tests,build,docs-build,bundle}.log`。此轮不连接生产机器人，不替换正式应用。

## Monitor 版本化配置

- `documents.rs` 增加独立于 Bridge 连接的原生写入器：固定文档键、实际 WebView 权限、大小/结构校验、版本比较、互斥内原子保存。冲突返回新快照，不自动重试旧内容；文件损坏、超限、读取或写入错误不降级为空配置覆盖。通知仅携带键和版本，原始图像/采样点不广播、不写入 Monitor 配置。
- Monitor/Topics 首次读取时将旧 localStorage 导入 `monitor-workspace.v2.json`，多个窗口同时迁移只产生一个权威版本；其余 App 不再持续写回 Monitor 本地键。Topics 添加字段使用最新配置提交，成功后才转至 Monitor；元数据更新按稳定仪表盘/面板/序列身份保留已有采样点。整体布局替换校验发起时的版本；迟到读响应不能覆盖新快照。每个读者最多排队 32 项编辑。
- 测试覆盖实际线程并发写入、旧版本拒绝、外部文件变更、损坏/超限文件保留、非法字段/调用者、两 React 消费者的迁移及同步、样本不进配置、失效旧读、保存失败、队列压力和被删除文件不从旧种子复活。原生测试临时目录使用独立序号，避免并行测试依赖时钟分辨率。
- 全量 `npm test` 通过（868 前端 / 132 Rust / 2 运行库测试与其余脚本）；前端、文档、独立 Debug bundle 与 codesign 通过。日志 `/tmp/260-shared-editing-{all-tests,build,docs-build,bundle}.log`。
- 原生离线验收：七面板配置成功迁移为 2943 字节的文件且不含 points；通过真实 Monitor 窗口改名，退出并重启后名称保留，主窗口/手眼启动不覆盖它。备份隔离配置后放入无效测试内容，真实 UI 拒绝保存、保留当前仪表盘和未保存名称；确认文件未被覆盖，恢复备份后再次保存成功，错误消失。配置测试仅触及 `dev.easydebug.multiwindowtest`，生产应用与 Bridge 未修改。Topics 到 Monitor 同步的证据为两消费者测试，本阶段没有连接机器人进行原生实时字段选择。

共享编辑仍需完成：姿态库与动作组页面接入版本化写入和变更通知、脏草稿冲突提示、异步保存状态；移除旧无版本写入入口；主窗口离线 Motion 编辑入口须复用已有 Motion 页，避免第二个编辑器；其他布局偏好按所属页面写入。存储层已为 `positions` / `motion_groups` 保留旧文件路径与校验适配，但这不代表对应前端已迁移。随后继续其余原生任务生命周期、九窗口及持续运行/多屏验收，完整 Issue #260 尚未达到交付条件。


## 姿态库与动作组共享编辑

两类页面已接入 `editor_document_read/commit`，沿用原文件路径；移除无版本校验的旧读写 IPC。保存基于最新文档，仅修改指定连接的目标记录，保留其他配置。编辑和删除带记录基线，防止整份文档版本更新后仍把旧草稿覆盖回去。Status 新保存的姿态通过轻量失效通知同步到 Motion；草稿独立保留。姿态保存对话框和编辑页等待写入结果，失败展示原因，阻止重复提交和保存中的页面迁移。

本阶段已完成下述全量测试和隔离原生验证。离线主窗口的重复 Motion 编辑入口及其他偏好单写者仍待后续接入；完整目标保持进行中。


本阶段原生复验发现 Motion 拆出后可出现仅剩窗口工具栏、内容消失，重新选择页面可短暂恢复。已将原生页的可见性以 Rust 快照为准（避免 reparent 后 WebKit `document.hidden` 影响独立窗口），并把 Motion 内容的路由显示与绘制/查询活跃状态分离。真实窗口仍显示时不会因绘制暂停隐藏编辑表单；隐藏或最小化仍暂停绘制。


四窗口启动时还捕获到一次真实原生死锁：主线程处理 `workspace_page_ready` 的事件广播，在 `WryWebviewDispatcher::eval_script` 等待父窗口 ID 锁；恢复窗口的后台线程持有同一锁，在 `reparent` 等待主线程 ACK。栈保存于 `/tmp/260-window-startup-sample.txt`。运行库修复改为先复制并释放源 ID 锁，再发送/等待迁移；主线程在迁移成功后、ACK 前提交新 ID。回归测试在临时还原旧持锁顺序时失败（`GUI event blocked by waiting caller`），修复后三项运行库测试通过；失败仍保留原父窗口，断开的响应通道返回错误。


最终验证：`npm test` 全部通过（876 前端 / 133 Rust / 3 运行库测试与全部其余脚本，`/tmp/260-position-group-final-tests.log`）。`npm run build`、`npm run docs:build`、独立 Debug Tauri bundle 和 `codesign --verify --deep --strict` 均通过；日志 `/tmp/260-position-group-{build,docs-build,bundle}.log`。还原旧锁顺序的临时负例按预期失败，记录于 `/tmp/260-reparent-old-lock-test.log`，不影响上述最终全量结果。

离线原生实测：主窗口、Motion、Monitor、手眼四窗口连续三次恢复启动成功；姿态与动作组的外部修改会拒绝旧草稿提交并保留输入，重新载入后均保存成功，且核对了实际文件；主窗口保存的姿态名称同步出现在独立 Motion。修复后切换 Motion Tab 不再丢失可见内容。未保存姿态草稿完成 12 轮收回＋拆出（24 次迁移）均保留。自动化过程中的焦点切换和 ScreenCaptureKit 中断没有计入通过次数；本轮未完成新的 50 轮连续批次，不代替此前手眼页的 50 轮记录或整体性能验收。测试数据仅位于 `dev.easydebug.multiwindowtest`，正式应用与 Jetson 未替换，未连接真实机械臂。


## 离线 Motion 单实例入口

离线姿态库及动作组按钮改用原生 Motion Host；带版本的 Tab 导航保存在 Rust 快照，覆盖懒创建和已拆出页面。姿态编辑在切换 Tab 时保持挂载。连接配置不匹配时保留原编辑并提示先同步连接；完整离线配置切换和其他任务生命周期仍待实现。


本阶段验证：`npm test` 全部通过（879 前端 / 134 Rust / 3 运行库测试及全部其余脚本），随后 `npm run build`、`npm run docs:build` 通过；日志 `/tmp/260-offline-motion-final-{tests,build}.log`、`/tmp/260-offline-motion-docs-build.log`。独立 Debug Tauri bundle 构建和签名核验通过（`/tmp/260-offline-motion-bundle.log`）。

实际离线原生窗口验证了两个管理入口聚焦同一 Motion 并选中对应 Tab；未保存姿态名称跨 Tab、返回主窗口、重新进入管理入口及收回后重新进入均保留。测试草稿随后取消，未写入正式姿态库。同一隔离应用还复验了手眼页 1200×900 标定板的放大查看、完整工具栏、原始尺寸及 Esc 返回，返回后保留 100% 缩放。未连接机器人、未替换正式应用；本轮不重复声称此前故障注入和 50 轮迁移是新增验证。全量九窗口、多屏及持续运行验收仍未完成。


## 页面偏好写入归属

App 在每个原生 WebView 中运行，因此原来各页面初始化时都会保存 Motion 标签、Topics 分栏等偏好，存在旧状态覆盖。现在 `pagePreferences.ts` 明确分配唯一写入者：Motion 保存自身标签/Controller 侧栏，Topics 保存面板/侧栏/尺寸，主窗口保存全局导航、Motion 下主导航显示及连接后跳转。主窗口即使当前选择 Motion 也不写 Motion 页的标签；页面隐藏或拆收不改变归属。浏览器单窗口保留原行为。

页面内部的 MotionLayout/URDF/动作组/浮动面板和数据采集设置已经只在对应唯一页面组件挂载，继续由本页写入。此处是 UI 偏好归属，不把 localStorage 当作任务锁或控制授权。姿态/动作组/Monitor 共享文档继续使用 Rust 版本校验。完整任务生命周期和多屏验收仍未完成。


验证结果：`npm test` 全部通过（884 前端 / 134 Rust / 3 运行库测试及其他完整脚本），`npm run build`、`npm run docs:build`、独立 Debug Tauri bundle 与严格 codesign 核验通过；日志 `/tmp/260-preferences-{all-tests,build,docs-build,bundle}.log`。回归覆盖十种页面身份的唯一写入者、旧读者更新/重开不能覆盖、存储错误，以及主窗口和手眼 App 实际挂载不写其他页面偏好。

隔离原生验证：使用备份后的布局 fixture 同时恢复九个功能窗口及主窗口，逐一选择原生窗口菜单并核对真实页面内容。Motion 设为动作组、Topics 收起左侧栏后，其他窗口导航不改变它们；退出并重新启动九窗口后，两项偏好仍保留。九个功能页各完成一次收回＋拆出（18 次迁移），逐次核对页面 URL、工具栏和内容。首次 Status 收回时主窗口还在连接表单，需点击既有“返回已打开页面”才展示嵌入内容；后续八页直接展示。此事实不计为迁移失败，也不宣称离线收回已经自动切离连接表单。测试完成后退出隔离应用并恢复测试前窗口布局，九窗口布局证据保留于 `/tmp/260-preferences-nine-window-verified-layout.json`。

本轮只验证离线窗口恢复、导航及拆收，未验证九窗口连接中的流量/任务、30 分钟内存、外接屏热插拔或真实电机。手眼“前往 Motion 调整姿态”目前只聚焦已有 Motion，显式切至 Robot View 的跨页面导航意图仍需接入；其他原生任务生命周期、完整离线配置切换、发布安装与 CI/PR 合并继续按完整目标推进。


## 原生手眼采集与计算任务

`local_tasks.rs` 将离线也可运行的手眼子进程纳入原生任务登记。实际 WebView 身份、请求编号与所属页面心跳关联；任务提交和原生拆收通过 Tasks 的同一互斥锁仲裁。查询者不能续租；取消/超时/原生 future 被丢弃时清理工作、保留有界元数据终态，再释放迁移占用。原始图像与计算结果只返回发起调用。前端统一包装五处采集/计算入口，在来源变化或卸载时取消，串行心跳并拒绝迟到结果。主窗口离线入口也读取状态，成功时隐藏，失败和取消显示。

该阶段覆盖 capture/preview/frames 与 board/detect/solve 子进程；不把文件选择和导出对话框算作已完成原生生命周期，也不把手眼任务锁等同于其他运动任务的原生归属。完整范围仍包含 Motor/直接 JTC/重力、Controller/arm mode/Joint4/数据采集、完整离线配置切换、多屏性能及最终安装合并。


本阶段全量 `npm test` 通过（888 前端 / 140 Rust / 3 运行库测试及全部其余脚本）；前端、文档及独立 Debug Tauri bundle 构建、严格 codesign 核验通过。日志 `/tmp/260-handeye-native-{all-tests,build,docs-build,bundle}.log`。新增测试覆盖实际本地 sleep 子进程取消后退出、原生 future 丢弃、过期/旧编号/他页面心跳拒绝、取消终态、锁释放、两线程迁移与任务提交的唯一赢家，以及前端来源切换/卸载取消、迟到结果拒绝、单个在途续租和只读观察者不续租。

原生离线验收：独立手眼页面通过新增 operationId 和真实 WebView 鉴权成功生成 1200×900 标定板；完成后收回成功且图片保留，在嵌入页再次生成成功，再拆出仍正常。快速标定板任务没有用来宣称真实窗口失联/忙态竞态验收；这些路径的证据是上述原生和 React 回归测试。本轮未连接生产 Jetson、未实测远端 SSH 采集取消、未覆盖正式应用，Bridge 无变更。

## 原生 Motor 连续发送任务

Motor 首帧在原生写入前占用全局运动任务及本页迁移锁，发布 ACK 后仅同一 WebView 实例可续发。Rust 监视真实写入的指令流；250 ms 无新指令时在下一轮 250 ms 检查中请求 DISABLE，查询/绘制不延长指令流。窗口关闭、未知发布结果和连接丢失保留任务占用，原生层不重放运动指令。已有 Bridge 负责 DISABLE 清零及每帧新 sequence，未改机器人安全门。

停止完成需要新的 HardwareStatus 同时满足 DISABLE、对应 ACK 序列、源时间推进和原生接收新鲜度。ACK 只表明发布，不是硬件关闭输出证明。Rust 为当前 statusTopic 保留原生订阅，不依赖最后一个 WebView。身份由主机、用户/SSH 端口、Bridge 远端端口、ROS domain 及命令/反馈 Topic 确定；本地转发端口变化可重连核验，另一机器人不能解锁旧任务，也不会自动向它发送 DISABLE。这里核验的是输出关闭，不宣称机械静止。

本阶段全量 `npm test` 通过（889 前端 / 147 Rust / 3 运行库测试及全部其余脚本）；`npm run build`、`npm run docs:build`、独立 Debug Tauri bundle 和严格 codesign 核验通过，日志 `/tmp/260-motor-native-{all-tests,build,docs-build,bundle}.log`。实际 loopback WebSocket 集成测试验证所有页面退出后自动 DISABLE、错误序列/模式保持占用、新鲜匹配反馈释放占用，硬件订阅只建立一次且不随页面退出释放。单元测试覆盖首次拒绝、未知发布、旧响应/队列许可、流中断、重连不同机器人及新连接停止证明；前端状态读取不续发控制。

本轮 CUA 仍返回 Mac 锁屏错误，已再次请求解锁；本轮构建没有完成新的真实窗口复验，不能将前序迁移验证算作本轮结果。未连接生产机械臂，未覆盖 `/Applications/Robot Console.app` 或部署 Jetson；Bridge 源码无变化。完整目标仍需直接 JTC/重力/Controller/arm mode/Joint4/采集等任务归属、离线配置切换、显式跨页导航、多屏及持续运行验证、最终发布与 PR/CI 合并。

## 重力辨识原生任务（实现与验证进行中）

当前未提交改动将 Gravity 纳入 Tasks：首帧前占用、实际 page-gravity 身份、编号关联、原生心跳/取消、按完整保留终态恢复。前端生成独立 command_id、拒绝旧任务结果、反馈 DONE/FAILED 不解锁、晚到 ACK 不恢复断开的执行。Bridge 新增 GravityTaskCore，在 ROS 受理前登记、保留尚无 GoalHandle 的取消、只读查询不续租、5 秒租约及连接退出取消。Action 返回后等待新鲜 HOLD/DISABLE 与六个具名关节的低速反馈，终态有界保留；异步发送异常保持未知占用，不返回可被误认为明确拒绝的 error。

最新本机 npm test 通过（891 前端 / 150 Rust / 3 运行库测试及其余脚本；/tmp/260-gravity-final-tests.log）；前端和文档构建通过（/tmp/260-gravity-{build,docs-build}.log）。ROS 首轮失败发生在测试助手等待 hello 的 request_id；实际协议 hello 不带编号，已改为直接发送和读取 hello。本轮不能据此宣称 ROS 行为已经通过。

目前最新 Bridge build ID 为 664d6fea7a4f。仅脚本同步至 damiao 的独立工作区 easy_debug_bridge_260_motion_observe，未重启生产 Bridge。该工作区先前两次单线程 colcon 编译已成功；最新异步异常修正仍需最终验证。当前真实在途句柄：exec 88576（单线程 colcon build 后运行 ROS_DOMAIN_ID=220、ROS_LOCALHOST_ONLY=1 的 test_gravity_task_ros.py，日志 /tmp/260-gravity-verified-ros.log）；exec 3070（独立 Debug Tauri bundle，日志 /tmp/260-gravity-bundle.log）。后续先轮询这些句柄或核验其终态，不因等待无输出重复启动。随后还需完整 colcon test、bundle 签名与代码复查、提交推送，以及前文其余完整目标。未连接真实机械臂、未安装正式应用。


重力辨识阶段最终验证：显式 DISABLE 不允许随后 HOLD 解锁，Action 返回后重新发布三帧清零且序列递增的 DISABLE；最多每秒重试一次，核对新的固件序列和低速反馈。纯核心测试及实际隔离 ROS Action 测试覆盖此路径，并核对所有字段清零、每帧序列唯一。ROS 还覆盖受理前的占用/取消、非所属客户端不能续租、只读查询不能阻止租约过期、源时间重放不证明停稳和保留终态查询。

最终 npm test 全部通过（891 前端 / 150 Rust / 3 运行库测试及全部脚本；/tmp/260-gravity-disable-tests.log）。前端由 Tauri beforeBuildCommand 再次构建，独立 Debug bundle 和严格 codesign 核验通过（/tmp/260-gravity-disable-bundle.log），文档构建通过。Jetson 独立工作区完整 colcon build、colcon test、colcon test-result --verbose 通过：24 tests、0 errors、0 failures、0 skipped（/tmp/260-gravity-disable-ros-all.log）。当前 build ID 为 ac78d78d2600，先前列出的构建/测试句柄均已完成，以上最终结果取代之前在途状态。

本轮 Mac 已可操作。退出旧隔离进程、重建并启动最新隔离包后，实际生成 1200×900 标定板，切换到 100%，完成一次拆出和收回，图片及缩放保留；此项只验证离线窗口回归，不能当作实际重力辨识或多屏验收。没有连接生产机械臂，没有覆盖正式应用或重启生产 Bridge。仍待直接 JTC/Controller/arm mode/Joint4/数据采集与 bag 等生命周期、离线配置与跨页导航、多屏性能，以及最终发布、PR/CI/合并；完整目标保持进行中。


## 解锁后的原生迁移故障复验

在提交 7e03905 对应的隔离 Debug 应用中重新验证，未连接 Bridge。向独立配置目录写入单次故障 fixture：detach:bounds + rollback:reparent 后，真实原生迁移及向已关闭目标的回滚失败，页面显示“恢复窗口”；再注入 recover:bounds，恢复中途失败仍保留页面及重试入口；随后重试成功，并可再次正常拆出。另注入 dock:bounds，收回失败自动返回原独立窗口，再次收回成功。每步均读取真实原生无障碍树核验，最终回到主窗口嵌入页。

全程保留 12×9、15 mm / 11.25 mm 输入、1200×900 标定板和 100% 缩放。收回失败后仍能打开图片大图，截图确认工具栏及关闭按钮完整可见，Esc 返回原页面并保留缩放。三个 fixture 均已消费，不留待触发故障文件。本轮仅追加验证记录，没有生产行为变更，未重新运行全量测试；前序全量结果不计作本轮新增验证。未覆盖正式应用、未部署或操作机械臂；完整多窗口目标仍在进行中。


## Controller 切换原生占用与成功后核验

单个/批量 Controller IPC 现在从真实 WebView 取得页面身份，核对当前 Rust 连接 Profile（本地隧道端口不参与机器人身份），在首次异步预检之前占用 Tasks 的同一运动/迁移锁。命令仅在当前连接、页面仍有效时发送一次。窗口退出前尚未发送的任务撤销；已发送的有限切换由应用层工作继续，页面退出不取消核验，也不借此放开其他执行。

命令成功之后的核验使用公共查询强制刷新，要求所有 Controller 的名称、类型及 active/inactive 目标一致，旧缓存、过期值、重复名称及另一连接均不成立。短期无法核验时 IPC 在 25 秒后返回“仍在核验”，原生工作继续；同机器人/配置重连可恢复查询，其他配置只等待，不发送切换。SSH 失败或 20 秒超时保留未知占用且不重试控制；目前尚缺远端可恢复完成记录，不能将这条路径算作完整故障恢复。arm mode / Joint4 / 直接轨迹及采集等入口依旧待接入，整体目标保持进行中。

本阶段最终 npm test 全部通过（892 前端 / 157 Rust / 3 运行库测试及其余脚本），日志 /tmp/260-controller-final-all-tests.log。前端、文档、独立 Debug Tauri bundle 构建及严格 codesign 核验通过，日志 /tmp/260-controller-final-{build,docs-build,bundle}.log。新增回归覆盖真实 loopback 会话的页面/配置/代次拒绝、调用 future 消失后工作继续持有占用、未发送撤销、未知结果保持锁、旧编号与伪造 Bridge 终态无效、Controller 与迁移两线程竞争，以及类型/目标状态/帧龄/重复名称校验。

退出旧隔离包后启动最新构建，离线 Motion 从管理姿态库入口加载，完成一次拆出和收回，当前 Tab 与姿态库保留，未连接时执行按钮保持禁用。本轮未在真实窗口发起 Controller 切换；任务互斥和结果提示的证据来自上述测试，离线页面检查不等于实机控制验证。未安装正式应用、未部署 Bridge、未操作生产机械臂。


## Controller 远端完成记录与 SSH 回复丢失恢复

本阶段补充前一节缺少的远端记录：每个 Controller 任务分配随机编号，固定命令绑定 SHA-256；Rust 提交方法一次性消费命令内容，后续接口只能查询。远端先持久化 reserved，再由脱离 SSH 标准流的有限子进程执行，父进程退出不丢弃结果。原子记录保留 succeeded / 启动前 rejected / uncertain；恢复时核对版本、编号、摘要和结果字段。succeeded 后仍需原机器人同配置连接的新鲜 Controller 目标状态，不能用记录代替状态核验；明确 rejected 且 started=false 可释放未执行任务。

SSH 回复丢失可以通过只读记录查询恢复；CLI 本身失败/超时、记录缺失或不匹配不自动解锁、不重新发送。记录保留容量为 256 项、每项 16 KiB，仅淘汰已完成的成功/启动前拒绝项。Jetson 只读检查了实际安装的 ros2controlcli switch_controllers.py，确认其成功退出来自 ControllerManager response.ok；没有调用该服务。该机制尚不提供整个桌面进程重启后的活跃任务恢复；其他控制入口、全局停止后的控制模式协调及完整性能/发布验收仍在目标范围内。

最终 npm test 通过（892 前端 / 160 Rust / 3 运行库测试及全部其余脚本），日志 /tmp/260-controller-journal-final-tests.log；前端和文档构建通过。一次测试失败来自 macOS Python 在隔离 HOME 下写字节码缓存，现通过测试环境的 PYTHONDONTWRITEBYTECODE 保留“不创建目录”的原断言；定向和最终全量重跑均通过。Python helper 的 7 项进程/文件回归在 Mac 与 Jetson 临时目录均通过（/tmp/260-controller-journal-jetson.log），覆盖回复丢失、父进程退出、重复提交不执行第二次、只读查询、摘要冲突、超时/异常不误判完成、启动前拒绝、落盘先于启动、记录容量及输出边界。

另以两条独立 SSH 连接验证提交回复被丢弃后可读回成功结果，重复查询不重复执行；命令只向专属临时目录写测试文件，验证后目录已清理（/tmp/260-controller-journal-ssh-recovery.log），没有调用 ROS 控制服务。Mac 当前锁屏，已请求解锁；本轮完成 npm run tauri build -- --debug --no-bundle --config /tmp/260-native-window-test.json，日志 /tmp/260-controller-journal-native-build.log。现有隔离 .app 尚未更新，不得用于声称本轮原生 UI 已复验；正式应用、Bridge 进程与机械臂未更新或操作。完整目标仍保持进行中。
