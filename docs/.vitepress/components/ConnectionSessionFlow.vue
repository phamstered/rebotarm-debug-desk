<template>
  <figure class="rdd-diagram" role="img" aria-labelledby="rdd-conn-title" aria-describedby="rdd-conn-desc">
    <p id="rdd-conn-title" class="rdd-diagram__title">连接阶段 · Connection sequence</p>
    <p id="rdd-conn-desc" class="rdd-diagram__sr">
      连接按阶段推进：SSH 检查 → micro-ROS Agent → 若未监听则启动 Bridge →
      ssh -N -L 本地端口转发 → WebSocket。
    </p>

    <div class="rdd-steps rdd-steps--row" aria-hidden="true">
      <div class="rdd-step rdd-step--accent">
        <strong>SSH 检查</strong>
        <small>batch 模式连通性</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step">
        <strong>micro-ROS Agent</strong>
        <small>服务状态探测</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step rdd-step--ok">
        <strong>启动 Bridge</strong>
        <small>若未监听 loopback</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step">
        <strong>ssh -N -L</strong>
        <small>本地端口转发</small>
      </div>
      <div class="rdd-step-arrow"><span></span></div>
      <div class="rdd-step rdd-step--accent">
        <strong>WebSocket</strong>
        <small>连本地转发端口</small>
      </div>
    </div>

    <p class="rdd-diagram__caption">
      失败时界面展示具体阶段与原因；首选本地端口被占用时使用实际选出的端口。
    </p>
  </figure>
</template>
