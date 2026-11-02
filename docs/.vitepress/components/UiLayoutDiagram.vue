<template>
  <figure class="rdd-diagram" role="img" aria-labelledby="rdd-ui-title" aria-describedby="rdd-ui-desc">
    <p id="rdd-ui-title" class="rdd-diagram__title">界面结构 · UI layout</p>
    <p id="rdd-ui-desc" class="rdd-diagram__sr">
      左侧 Navigation 含 Status、Topics、Motion、Monitor 等页面。Topics 展示 Topic Graph、Inspector 与只读 Controller；
      Motion 提供 Robot View、位置、动作组、可折叠 Controller 管理与共享日志；Status 保留整栈模式管理。
    </p>

    <div class="rdd-panels rdd-panels--3" aria-hidden="true">
      <div class="rdd-panel rdd-panel--nav">
        <p class="rdd-panel__title">左侧 Navigation</p>
        <div class="rdd-panel__items">
          <div class="rdd-panel__item">Status</div>
          <div class="rdd-panel__item">Topics</div>
          <div class="rdd-panel__item">Motion</div>
          <div class="rdd-panel__item">Monitor</div>
          <div class="rdd-panel__item">数据采集</div>
          <div class="rdd-panel__item">Motor</div>
          <div class="rdd-panel__item">Calibration</div>
          <div class="rdd-panel__item">重力辨识</div>
        </div>
      </div>
      <div class="rdd-panel rdd-panel--center">
        <p class="rdd-panel__title">工作区职责</p>
        <div class="rdd-panel__items">
          <div class="rdd-panel__item">Topics · Graph / Inspector</div>
          <div class="rdd-panel__item">Motion · Robot View / 位置 / 动作组</div>
          <div class="rdd-panel__item">Status · 整栈模式</div>
        </div>
      </div>
      <div class="rdd-panel rdd-panel--side">
        <p class="rdd-panel__title">可折叠侧栏</p>
        <div class="rdd-panel__items">
          <div class="rdd-panel__item">Topics 列表 + 搜索</div>
          <div class="rdd-panel__item">Topics · Controller 只读</div>
          <div class="rdd-panel__item">Motion · Controller 管理</div>
          <div class="rdd-panel__item">Topic Inspector</div>
        </div>
      </div>
    </div>

    <p class="rdd-diagram__caption">
      Topics 集中浏览与诊断；Motion 集中运动操作，任务进行时跨页显示状态与取消入口。
    </p>
  </figure>
</template>
