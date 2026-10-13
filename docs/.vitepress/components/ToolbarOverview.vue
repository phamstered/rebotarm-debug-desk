<template>
  <figure class="rdd-diagram" role="img" aria-labelledby="rdd-tb-title" aria-describedby="rdd-tb-desc">
    <p id="rdd-tb-title" class="rdd-diagram__title">顶部工具栏 · Toolbar</p>
    <p id="rdd-tb-desc" class="rdd-diagram__sr">
      顶部工具栏提供连接配置、全部刷新、暂停或恢复显示、rosbag、诊断快照、重置布局与设置，
      以及连接状态与断开。
    </p>

    <div class="rdd-fan" aria-hidden="true">
      <div class="rdd-fan__hub">
        <div class="rdd-step rdd-step--accent" style="display:inline-block;min-width:10rem">
          <strong>顶部工具栏</strong>
          <small>全局操作 · 右侧状态</small>
        </div>
      </div>
      <div class="rdd-step rdd-fan__leaf">
        <strong>连接配置</strong>
        <small>保存不中断会话</small>
      </div>
      <div class="rdd-step rdd-fan__leaf">
        <strong>全部刷新</strong>
        <small>Topics + ROS Control</small>
      </div>
      <div class="rdd-step rdd-fan__leaf">
        <strong>暂停 / 恢复显示</strong>
        <small>不断开 Bridge</small>
      </div>
      <div class="rdd-step rdd-fan__leaf rdd-step--ok">
        <strong>rosbag</strong>
        <small>Jetson 上 record -a</small>
      </div>
      <div class="rdd-step rdd-fan__leaf">
        <strong>诊断快照</strong>
        <small>脱敏 JSON</small>
      </div>
      <div class="rdd-step rdd-fan__leaf">
        <strong>重置布局 / 设置</strong>
        <small>刷新周期等</small>
      </div>
      <div class="rdd-step rdd-fan__leaf rdd-step--warn">
        <strong>连接状态 · 断开</strong>
        <small>端口 · Agent</small>
      </div>
    </div>

    <p class="rdd-diagram__caption">
      暂停只冻结算消费；断开桌面端不会自动停止远端 rosbag 录制。
    </p>
  </figure>
</template>
