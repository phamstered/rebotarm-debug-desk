# 3D Gaussian Splatting：Desk 应用集成方案（Draft）

> 方案日期：2026-11-24。跟踪 [Issue #301](https://github.com/phamstered/rebotarm-debug-desk/issues/301)。
> **本文只设计 rebotarm-debug-desk 的应用集成，不实现产品代码、固件、Bridge、界面或训练进程。**
> 采集契约和环绕扫描轨迹由 [rebotarm-ros2-stack](https://github.com/phamstered/rebotarm-ros2-stack) 另写设计文档。那份文档才是这两部分的规范来源。本文不充当其事实来源。

stack 侧草稿由独立代理撰写：<https://cursor.com/agents/bc-34623bf8-5cc2-54a6-b587-4b77573b6918>。截至本文写入时，对应 Draft PR 尚未贴出。贴出后把链接补进 [§4](#_4-共享假设-采集与环绕归-stack)，并以该 PR 为准。在链接出现之前，§4 只保留 2026-11-24 已经对齐的共享假设，不能当作采集或轨迹实现的依据。

## 1. 分工

| 仓库 | 本轮职责 |
| --- | --- |
| rebotarm-debug-desk | Brush 训练 sidecar、Robot View 溅射层、环绕路径的预览与确认、按现有 SSH/会话把数据集拷到 Mac、导入 `.ply` |
| rebotarm-ros2-stack | 采集契约与环绕扫描轨迹的规范文本；Jetson 上的采集和运动 |
| rebotarm-executor | 本轮不改固件。只审阅 [§3](#_3-已同意约束-供-executor-审阅) 的短约束 |

3DGS 是离线工作场景模型，用于示教和检查。它不是实时控制传感器，也不进入电机命令流。现有腕部 RGBD 实时单帧彩色点云继续负责当前视野；3DGS 不替换它，也不替换视觉 Pick 或桌面包围盒。

## 2. 已核对的 Desk 基线

核对对象是 2026-11-24 的本仓 `main`（`0d25567`，`fix: reconcile Motor stop latch on verified reconnect (#300)`）。下面只写在这些文件里读到的行为。仓库内检索 `gaussian`、`3dgs`、`3DGS`、`splat`、`Nerfstudio`、`transforms.json` 没有命中，当前没有 3DGS 实现。

| 已有能力 | 本仓事实 | 对 3DGS 的含义 |
| --- | --- | --- |
| 腕部实时彩色点云 | Robot View 使用 `/cameras/left_arm/wrist/` 下的彩色图、对齐深度和 CameraInfo。点云按整组替换：新的完整帧丢掉上一组，不把多帧累加进同一几何。`docs/todo.md` 把多帧累积、TSDF、连续三角面和模型导出留作后续，并写明点云显示不引入自动避障或运动控制 | 实时点云保持单帧当前视野。3DGS 是另一层离线模型 |
| 图像时刻的位姿 | Bridge 用 RGB 的 `header.stamp`、零超时查询 `target_frame ← rgb.header.frame_id`，默认目标坐标系是 `base_link`。失败最多再等 150 ms，不用最新关节状态顶替。协议把该位姿记为采集时刻的 `target_frame ← source_frame` | 现有预览链已经按图像时间取 TF。采集数据集是否改用 `camera_info.header.frame_id`，由 stack 契约规定；本仓预览查询读的是 RGB `frame_id` |
| 桌面 AABB 与视觉 Pick | 检测在 `base_link` 给出轴对齐包围盒的中心和边长（米）。视觉 Pick 在当前 RGBD 订阅上选择物体并请求预览；执行仍走既有 PositionMotion。RGBD 点云不自动写入 Planning Scene | 环绕中心可以引用这些已有物体。Desk 只展示 stack 给出的路径，不在桌面生成规范轨迹 |
| Trajectory / MoveIt | Status 的一键 Trajectory 经 SSH 启动 `start_arm_teleop.sh --position-controller=trajectory --gravity=true`，自检通过后再 `moveit_manage start`。功能文档写明随后启动 `real_move_group.launch.py`。点位与定时 TCP 经 Bridge 的 `/move_action` 在 Jetson 规划执行；桌面不直接发布 MIT，也不拆分中间点。服务端速度 / 加速度上界的现有要求是 2 rad/s、2 rad/s² | 环绕运动沿用这条 Jetson 规划 / 执行路径。Desk 的确认按钮不自己发布关节命令 |
| 会话边界 | 桌面经 SSH 隧道访问只监听 `127.0.0.1` 的 Bridge。Mac 不加入 DDS。安装版由 Rust 会话管理器连接转发后的 WebSocket | 数据集拷贝和训练都留在这条 SSH/会话边界上 |
| 场景坐标 | URDF 以 `rotation={[-π/2, 0, 0]}` 放进 Three.js。点云用 `urdfToScenePoint` 做同一映射：`[x, y, z] → [x, z, -y]`。点云网格是场景子节点，和机器人 `primitive` 并列，不挂在被拖拽的连杆上。TCP 拖拽只对机器人调用 `setJointValue` | 溅射层跟点云一样放在场景根上，只做这一次显示映射 |
| 命令流中断 | `/stm32/joint_commands` 停发后，TRACK 下约 100 ms 进入 HOLD（effort 为 0，无重力补偿），约 500 ms 锁存 fault 11。`command_timeout_ms` 只对齐 host，不改 MCU 编译期超时。V1 `/stm32/joint_commands` 只表示 MIT；POS_VEL 走单独的 V2 话题，现有 Controller / Teleop / JTC 不增加 POS_VEL。Trajectory 的停止脚本会 `safe_stop` 或 `disable`，并 `moveit_manage stop` | 采集停稳拍照时必须保持 TRACK 且 JTC 继续发令。Desk 在采集会话中不调用这条停止路径 |

核对过的文件：

- `docs/todo.md`（Robot View RGBD 一节）
- `docs/architecture.md`（SSH/DDS 边界、Trajectory 执行、腕部 RGBD、桌面检测与视觉 Pick）
- `docs/protocol.md`（RCD1 位姿与默认话题、`command_timeout_ms`、MoveIt 执行）
- `docs/basic-features.md`（一键 Trajectory、`real_move_group.launch.py`、2 rad/s 与 2 rad/s²、腕部点云、桌面 AABB、V1 MIT / V2 POS_VEL 分工、fault 11）
- `docs/vla.md`（TRACK 100 ms HOLD、500 ms fault 11）
- `docs/gravity-identification.md`（`command_timeout_ms` 不改 MCU 超时）
- `docs/positions-moveit-design.md`（只作既有方案文体参照；其中“点云尚未落地”是 2026-10-25 的旧表述，以上表为准）
- `src/types.ts`、`src/rgbdPointCloudLogic.ts`、`src/RgbdPointCloud.tsx`、`src/kinematicsLogic.ts`、`src/UrdfViewer.tsx`
- `bridge/easy_debug_bridge/src/bridge_node.cpp`（RGBD 预览的 `lookupTransform`）
- `src-tauri/src/lib.rs`（Trajectory 启动与停止脚本）

本仓没有通用的 Jetson 数据集拉取命令。数据采集的图像、视频和 parquet 留在 Jetson。控制日志下载只允许固定的日志路径。3DGS 的目录拷贝是以后要新增的、白名单内的 SSH 文件传输，不是现成接口。

房间把实时电机命令流称为 250 Hz 路径。本仓协议写明的是首帧之后固件 100 ms 命令 watchdog，以及 Bridge / 原生 250 ms 写流监视。本文不把 250 Hz 写成已在本仓源码里核对到的周期。3DGS 不进入这条命令流。

## 3. 已同意约束（供 executor 审阅）

房间共识（2026-11-24）。本节是三仓已经对齐的约束，供固件审阅。它不扩大成固件改动，也不代替 stack 的采集和轨迹正文。

- **命令路径。** Jetson 做采集和运动。Mac 做训练 sidecar 和查看。Mac 不加入 DDS。3DGS 流程不从 Mac 或 Desk 发布 `/stm32/joint_commands`，也不从 Mac 发出任何运动。用户确认之后，运动由现有 Jetson Trajectory / MoveIt 路径启动；真正发到 `/stm32/joint_commands` 的仍是 Jetson 上的控制器。
- **停稳拍照时命令流不断。** 控制器保持 TRACK，JTC 继续发布命令。这样命令流不会在 100 ms 掉进 HOLD，也不会在 500 ms 锁存 fault 11。Desk 在采集会话期间不停止产生命令的控制栈，不调用现有 arm-mode 的 `safe_stop` / `disable` 停止，也不把 Trajectory 控制器切走。
- **v1 环绕使用现有 MIT TRACK。** 第一段环绕走 Jetson 规划、Bridge 会话和 `/stm32/joint_commands` 上的 MIT。第一段不使用 POS_VEL。executor 侧这条路径的固件默认仍是 MIT。
- **固件本轮不改。** 现有带时间戳的 `/stm32/joint_states` 和时钟同步足够在图像时刻取位姿。固件侧采集触发或更紧的时间对齐另案处理。

## 4. 共享假设（采集与环绕归 stack）

以下条目是 2026-11-24 房间已经对齐、Desk 集成所依赖的共享假设。字段、目录布局、准入细节、不可达视角的跳过规则和轨迹生成，以 stack Draft PR 为准。该 PR 尚未贴出；贴出后把 URL 写在这里。在那之前，不要按本节实现采集或轨迹。

**采集（stack 拥有）**

- 数据集是 Nerfstudio 风格的 `transforms.json`，加上 RGB 图像、可选的对齐深度和 `camera_info`。
- 位姿在图像时间戳上查找：`base_link ← optical`。`optical` 是 `camera_info.header.frame_id`。不用 `camera_link`，也不用最新关节状态。这与本仓实时预览当前使用的 RGB `frame_id` 可能不同，由 stack 契约写明二者的关系。
- `transform_matrix` 是 camera-to-world。世界坐标系固定为 `base_link`（ROS，Z 向上，米）。不把世界改成 Y 向上。
- TF 查找之后右乘 `diag(1, -1, -1, 1)`，把 ROS 光学轴（X 右、Y 下、Z 前）换成 Nerfstudio/OpenGL 相机轴（X 右、Y 上、Z 后）。这一步发生在数据集写出侧。
- 内参来自 `camera_info` 的 OPENCV 模型：`fl_x` / `fl_y` / `cx` / `cy` / `w` / `h`。
- 录制准入：时间戳有效、控制器处于 TRACK、`fault_code=0`、TF 查找成功。关键帧在位姿变化时取 2–5 Hz。
- 训练和导出关闭自动重定向与 up-axis 转换。`.ply` 也在 `base_link`。Desk 导入时不再做第二次世界坐标变换。

**环绕（stack 拥有，Desk 只预览和确认）**

- 物体中心来自现有视觉 Pick 或桌面 AABB。
- 生成半球相机位姿，光轴指向中心。
- 位姿之间用 MoveIt PTP。到位后停稳再拍照。v1 不做连续线性插值。
- 不可达或碰撞的视角跳过，并报告覆盖率。
- 速度 / 加速度上限 2 rad/s、2 rad/s²。避开腕部自遮挡。
- 路径先在 Robot View 预览，用户确认后才执行。
- 运动由 Jetson 上现有 Trajectory / MoveIt 路径启动。

## 5. Desk 集成（本仓规范）

### 5.1 训练

训练进程是 [Brush](https://github.com/ArthurBrussee/brush)（Apache 2.0，Metal/WebGPU，读取 Nerfstudio `transforms.json`，导出 `.ply`）的 sidecar CLI。它是独立操作系统进程。训练不放进 Tauri 或 WebView 进程。

Mac 训练器不用 Nerfstudio/gsplat 的 splatfacto：那是 CUDA 路径，不适合 Mac 上的 Desk。不捆绑 [OpenSplat](https://github.com/WebODM/OpenSplat)（AGPL）。

sidecar 的启动参数必须关闭自动重定向和 up-axis 转换，使导出的 `.ply` 留在 `base_link`。具体旗标在实现时按 Brush 当时的 CLI 文档填写，本文不预设旗标名称。

### 5.2 查看

优先把 [Spark](https://sparkjs.dev/) 合成到现有 Robot View 的 Three.js 场景里，与 URDF 和实时 RGBD 点云同时显示。

- 资产坐标系与实时点云相同，都是 ROS `base_link`、米、Z 向上。
- 显示只使用场景里已经存在的那一次映射：URDF 的 `[-π/2, 0, 0]`，点的 `[x, y, z] → [x, z, -y]`。导入不再叠加训练侧已经禁止的 up-axis 转换。
- 溅射节点与机器人 `primitive` 并列，不挂到被 TCP 拖拽改写关节的模型下面，也不跟随 `setJointValue` 的预览关节运动。
- 显隐独立于实时点云开关。关掉溅射层不影响 RGBD 订阅；关掉点云不影响已导入的模型。
- 断线或重连时，和点云一样清掉本会话的导入结果与未完成训练任务。迟到的 `.ply` 不能画进新连接。

若 Spark 无法干净地共用现有渲染循环，v1 改用 [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D)（MIT，Three.js）。它仍然能工作，但上游已不再积极开发。回退层遵守同一套坐标系、显隐和 TCP 隔离。

### 5.3 预览与确认

Desk 拥有 Robot View 里的路径预览和确认界面。预览数据来自 stack 规划结果。Desk 不在本地生成作为规范的半球或 PTP 轨迹。

交互沿用现有 TCP 确认的顺序：先看到预览，再由用户显式确认。仅打开预览、拖动相机或勾选安全确认都不会启动运动。确认之后 Desk 经现有 SSH/Bridge 会话请求 Jetson 开始采集环绕。这个请求不是 `/stm32/joint_commands`，也不是 Motor 页的 MIT/POS_VEL 指令。请求的操作名和字段跟 stack 契约一起定，本文不先发明协议操作。

不可达或被跳过的视角要在预览里看得见，覆盖率用 stack 返回的结果展示。用户拒绝或取消预览时不启动采集。

### 5.4 编排

```text
Robot View 预览 stack 给出的环绕路径
  → 用户确认
  → Desk 经现有 SSH/Bridge 会话请求开始采集
  → 等待 stack 在 Jetson 上做 PTP 环绕并写好数据集
  → 经现有 SSH 会话把数据集拷到 Mac（不经 DDS）
  → 启动 Brush CLI
  → 把 base_link 下的 .ply 导入 Robot View
```

拷贝走现有 SSH 会话，不加入 DDS，也不让 WebView 去订阅 ROS 话题。它是以后新增的白名单传输：只拉取本次采集目录，不沿用控制日志那份固定文件名单，也不把数据采集留下的 Jetson 文件改成自动同步。拷贝失败时保留 Jetson 上的数据集，并在界面给出阶段和原因；不因此停止 JTC。

训练失败、导入失败和用户取消都停在对应阶段。取消采集请求只通知 stack 结束本次采集会话；它不调用 Trajectory 停止脚本。stack 如何在保持 TRACK 的前提下结束环绕，写在 stack 文档里。

### 5.5 采集期间保持命令流

采集会话存活时，Desk 不执行会停掉 `/stm32/joint_commands` 的操作。现有 Trajectory 停止会先做硬件 `safe_stop` 或 `disable`，再 `moveit_manage stop`。这条路径会让 TRACK 命令流中断，从而触发 §3 的 100 ms HOLD 和 500 ms fault 11。采集中的「取消」不能复用这个停止按钮。

全局断开若仍要按现有连接逻辑做安全停止，必须先明确告诉用户这会中断采集并可能锁存 fault 11。本文不改变断开时的既有电机停止行为，只要求采集流程自己不要主动停命令流。

## 6. 决策

| 事项 | 决定 | 归属 |
| --- | --- | --- |
| 训练进程 | Brush CLI，独立 sidecar | Desk |
| Mac 训练器 | 使用 Brush。splatfacto 与 OpenSplat 不进入应用 | Desk |
| 查看 | Spark 叠进现有 Three.js；不能共用渲染循环时用 GaussianSplats3D | Desk |
| 模型坐标 | `.ply` 保持 `base_link`。显示只做现有 Z-up 到 Three.js Y-up 的那一次映射 | stack 导出，Desk 显示 |
| 运动 | 预览后确认，由 Jetson Trajectory/MoveIt 执行 | stack 执行，Desk 确认 |
| 采集与轨迹正文 | stack Draft PR | stack |
| 固件 | 本轮不改。executor 只审 §3 | executor |

## 7. v1 不做

- 用溅射模型做碰撞检查、规划或下发运动。
- 在 Jetson 上做实时 3DGS。
- 替换实时 RGBD、视觉 Pick 或桌面包围盒。
- 改固件协议，或由 MCU 触发采集。
- 让 Mac 加入 DDS，或让 Desk 站在电机命令流上。
- 环绕过程中做连续插值。那是以后的轨迹切片，归 stack。
- 把自动 COLMAP 当作主位姿来源。TF 是主来源；COLMAP 只作为以后的手眼漂移诊断，归 stack。

## 8. 本文不交付的内容

本文件是设计评审稿。合并或关闭 Issue #301 只表示方案文本被接受，不表示 3DGS 已经可以采集、训练或查看。实现需另建 Issue，并按仓库要求跑全量测试和相应的现场验收。本轮没有改运行代码，也没有在 Jetson 或机械臂上验证。
