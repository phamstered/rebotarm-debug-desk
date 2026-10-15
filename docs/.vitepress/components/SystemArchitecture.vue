<template>
  <figure class="rdd-diagram" role="img" aria-labelledby="rdd-arch-title" aria-describedby="rdd-arch-desc">
    <p id="rdd-arch-title" class="rdd-diagram__title">系统架构 · System architecture</p>
    <p id="rdd-arch-desc" class="rdd-diagram__sr">
      macOS 上的 Rebotarm Debug Desk（Tauri / React / Three.js）经 SSH 隧道连接 Jetson 上仅监听
      127.0.0.1:8765 的 C++ WebSocket Bridge；Bridge 通过 ROS 2 Humble / DDS 对接 micro-ROS Agent、
      STM32 与电机。桌面端不直接加入 DDS。
    </p>

    <!-- Mobile / single-column stack -->
    <div class="rdd-arch" aria-hidden="true">
      <div class="rdd-arch__layer rdd-arch__layer--mac">
        <span class="rdd-arch__badge">macOS</span>
        <p class="rdd-arch__name">Rebotarm Debug Desk</p>
        <p class="rdd-arch__meta">Tauri · React · Three.js · Rust SSH session</p>
        <div class="rdd-arch__chips">
          <span class="rdd-arch__chip">WebView UI</span>
          <span class="rdd-arch__chip">Tauri invoke</span>
          <span class="rdd-arch__chip">本地转发端口</span>
        </div>
      </div>

      <div class="rdd-arch__arrow" aria-hidden="true">
        <span>SSH 隧道 · 认证 / 主机密钥 / 加密</span>
      </div>

      <div class="rdd-arch__layer rdd-arch__layer--tunnel">
        <p class="rdd-arch__name" style="margin:0">ssh -N -L → Jetson <code>127.0.0.1:8765</code></p>
        <p class="rdd-arch__meta">Mac 不安装、不加入本地 ROS / DDS</p>
      </div>

      <div class="rdd-arch__arrow" aria-hidden="true"><span>WebSocket（loopback）</span></div>

      <div class="rdd-arch__layer rdd-arch__layer--jetson">
        <span class="rdd-arch__badge">Jetson · Ubuntu 22.04</span>
        <p class="rdd-arch__name">easy_debug_bridge</p>
        <p class="rdd-arch__meta">C++ · Boost.Beast WebSocket · rclcpp</p>
        <div class="rdd-arch__chips">
          <span class="rdd-arch__chip">只监听 127.0.0.1</span>
          <span class="rdd-arch__chip">topic / graph / resource</span>
          <span class="rdd-arch__chip">joint_command</span>
          <span class="rdd-arch__chip">trajectory_command</span>
        </div>
      </div>

      <div class="rdd-arch__arrow" aria-hidden="true"><span>rclcpp / Fast DDS</span></div>

      <div class="rdd-arch__layer rdd-arch__layer--ros">
        <span class="rdd-arch__badge">ROS 2 Humble</span>
        <p class="rdd-arch__name">ROS graph</p>
        <p class="rdd-arch__meta">Topics · Controllers · package:// 资源 · URDF</p>
        <div class="rdd-arch__chips">
          <span class="rdd-arch__chip">/robot_description</span>
          <span class="rdd-arch__chip">/stm32/joint_states</span>
          <span class="rdd-arch__chip">/controller_manager</span>
          <span class="rdd-arch__chip">JointTrajectoryController</span>
        </div>
      </div>

      <div class="rdd-arch__arrow" aria-hidden="true"><span>Micro XRCE-DDS Agent</span></div>

      <div class="rdd-arch__layer rdd-arch__layer--hw">
        <span class="rdd-arch__badge">固件 / 硬件</span>
        <p class="rdd-arch__name">micro-ROS · STM32 · 电机</p>
        <p class="rdd-arch__meta">JointCommand · HardwareStatus · 相机等实体</p>
        <div class="rdd-arch__chips">
          <span class="rdd-arch__chip">/stm32/joint_commands</span>
          <span class="rdd-arch__chip">HardwareStatus</span>
          <span class="rdd-arch__chip">active_joint_mask</span>
        </div>
      </div>
    </div>

    <p class="rdd-diagram__caption">
      Bridge 仅绑定 Jetson loopback；信任边界为 SSH。桌面端从不直接加入 DDS。
    </p>
  </figure>
</template>
