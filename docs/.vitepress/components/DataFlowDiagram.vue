<template>
  <figure class="rdd-diagram" role="img" aria-labelledby="rdd-flow-title" aria-describedby="rdd-flow-desc">
    <p id="rdd-flow-title" class="rdd-diagram__title">数据流 · Data flow</p>
    <p id="rdd-flow-desc" class="rdd-diagram__sr">
      遥测经 Bridge 进入桌面：topic_message、HardwareStatus、JointState。控制经 Bridge 下发：
      joint_command、trajectory_command，并返回 ACK。断开连接时若电机命令流在运行，先请求 DISABLE。
    </p>

    <div class="rdd-flow" aria-hidden="true">
      <div class="rdd-flow__legend">
        <span><i class="leg-in" aria-hidden="true"></i>入站（遥测）</span>
        <span><i class="leg-out" aria-hidden="true"></i>出站（控制）</span>
        <span><i class="leg-ack" aria-hidden="true"></i>ACK</span>
        <span><i class="leg-safe" aria-hidden="true"></i>安全停机</span>
      </div>

      <div class="rdd-flow__bands">
        <!-- Inbound -->
        <div class="rdd-flow__band">
          <p class="rdd-flow__section-title">入站 · App ← Bridge ← ROS / 固件</p>
          <div class="rdd-flow__row rdd-flow__row--3">
            <div class="rdd-flow__node rdd-flow__node--ros">
              <strong>ROS / STM32</strong>
              <small>Topics · HardwareStatus · JointState</small>
            </div>
            <div class="rdd-flow__edge rdd-flow__edge--in">
              <span class="rdd-flow__edge-label">subscribe / topic_message</span>
              <span class="rdd-flow__arrow" aria-hidden="true">→</span>
              <span class="rdd-flow__edge-label">status · joint_states</span>
            </div>
            <div class="rdd-flow__node rdd-flow__node--bridge">
              <strong>Bridge</strong>
              <small>解码 · 注册表 · 共享订阅</small>
            </div>
            <div class="rdd-flow__edge rdd-flow__edge--in">
              <span class="rdd-flow__edge-label">WebSocket JSON</span>
              <span class="rdd-flow__arrow" aria-hidden="true">→</span>
              <span class="rdd-flow__edge-label">SSH 隧道</span>
            </div>
            <div class="rdd-flow__node rdd-flow__node--app">
              <strong>桌面 App</strong>
              <small>Inspector · Robot View · Motor</small>
            </div>
          </div>
        </div>

        <!-- Outbound commands -->
        <div class="rdd-flow__band">
          <p class="rdd-flow__section-title">出站 · App → Bridge → ROS</p>
          <div class="rdd-flow__row rdd-flow__row--3">
            <div class="rdd-flow__node rdd-flow__node--app">
              <strong>桌面 App</strong>
              <small>Motor Control · TCP 拖拽</small>
            </div>
            <div class="rdd-flow__edge rdd-flow__edge--out">
              <span class="rdd-flow__edge-label">joint_command</span>
              <span class="rdd-flow__arrow" aria-hidden="true">→</span>
              <span class="rdd-flow__edge-label">trajectory_command</span>
            </div>
            <div class="rdd-flow__node rdd-flow__node--bridge">
              <strong>Bridge</strong>
              <small>白名单 · 预检 · 发布</small>
            </div>
            <div class="rdd-flow__edge rdd-flow__edge--out">
              <span class="rdd-flow__edge-label">/stm32/joint_commands</span>
              <span class="rdd-flow__arrow" aria-hidden="true">→</span>
              <span class="rdd-flow__edge-label">…/joint_trajectory</span>
            </div>
            <div class="rdd-flow__node rdd-flow__node--ros">
              <strong>ROS / 控制器</strong>
              <small>JointCommand · JointTrajectory</small>
            </div>
          </div>
        </div>

        <!-- ACK -->
        <div class="rdd-flow__band">
          <p class="rdd-flow__section-title">确认 · ACK</p>
          <div class="rdd-flow__row rdd-flow__row--3">
            <div class="rdd-flow__node rdd-flow__node--bridge">
              <strong>Bridge</strong>
              <small>接受并发布后回执</small>
            </div>
            <div class="rdd-flow__edge rdd-flow__edge--ack">
              <span class="rdd-flow__edge-label">joint_command_ack</span>
              <span class="rdd-flow__arrow" aria-hidden="true">→</span>
              <span class="rdd-flow__edge-label">trajectory_command_ack</span>
            </div>
            <div class="rdd-flow__node rdd-flow__node--app">
              <strong>桌面 App</strong>
              <small>request_id · sequence</small>
            </div>
            <div class="rdd-flow__edge" style="visibility:hidden" aria-hidden="true">
              <span class="rdd-flow__arrow">·</span>
            </div>
            <div class="rdd-flow__node" style="visibility:hidden" aria-hidden="true"></div>
          </div>
        </div>

        <!-- Disconnect safety -->
        <div class="rdd-flow__band">
          <p class="rdd-flow__section-title">断开安全 · Disconnect</p>
          <div class="rdd-flow__row rdd-flow__row--3">
            <div class="rdd-flow__node rdd-flow__node--app">
              <strong>用户断开 / 会话结束</strong>
              <small>关闭 WebSocket · SSH 隧道</small>
            </div>
            <div class="rdd-flow__edge rdd-flow__edge--safe">
              <span class="rdd-flow__edge-label">若命令流在运行</span>
              <span class="rdd-flow__arrow" aria-hidden="true">→</span>
              <span class="rdd-flow__edge-label">先 joint_command DISABLE</span>
            </div>
            <div class="rdd-flow__node rdd-flow__node--bridge">
              <strong>Bridge → STM32</strong>
              <small>清零通道 · 递增 sequence</small>
            </div>
            <div class="rdd-flow__edge rdd-flow__edge--safe">
              <span class="rdd-flow__edge-label">固件约 100 ms HOLD</span>
              <span class="rdd-flow__arrow" aria-hidden="true">→</span>
              <span class="rdd-flow__edge-label">约 500 ms 后 DISABLE</span>
            </div>
            <div class="rdd-flow__node rdd-flow__node--ros">
              <strong>电机安全停机</strong>
              <small>DISABLE 始终可用、无需解锁</small>
            </div>
          </div>
        </div>
      </div>
    </div>

    <p class="rdd-diagram__caption">
      入站以 <code>topic_message</code> 为主；出站为 <code>joint_command</code> /
      <code>trajectory_command</code>，对应 ACK 见协议。断开时若电机命令流在运行，先请求 DISABLE。
    </p>
  </figure>
</template>
