<template>
  <figure class="rdd-diagram" role="img" aria-labelledby="rdd-ui-title" aria-describedby="rdd-ui-desc">
    <p id="rdd-ui-title" class="rdd-diagram__title">界面结构 · UI layout</p>
    <p id="rdd-ui-desc" class="rdd-diagram__sr">
      左侧 Navigation 含 Dashboard、Motor 与 Calibration；Dashboard 中心面板局部 Tab 为 Robot View 与 Topic Graph；
      可折叠侧栏含 Topics 列表、ROS Control 与 Topic Inspector。Motor 是独立的七关节控制页。
    </p>

    <div class="rdd-panels rdd-panels--3" aria-hidden="true">
      <div class="rdd-panel rdd-panel--nav">
        <p class="rdd-panel__title">左侧 Navigation</p>
        <div class="rdd-panel__items">
          <div class="rdd-panel__item">Dashboard</div>
          <div class="rdd-panel__item">Motor</div>
          <div class="rdd-panel__item">Calibration</div>
        </div>
      </div>
      <div class="rdd-panel rdd-panel--center">
        <p class="rdd-panel__title">中心面板局部 Tab</p>
        <div class="rdd-panel__items">
          <div class="rdd-panel__item">Robot View</div>
          <div class="rdd-panel__item">Topic Graph</div>
        </div>
      </div>
      <div class="rdd-panel rdd-panel--side">
        <p class="rdd-panel__title">可折叠侧栏</p>
        <div class="rdd-panel__items">
          <div class="rdd-panel__item">Topics 列表 + 搜索</div>
          <div class="rdd-panel__item">ROS Control</div>
          <div class="rdd-panel__item">Topic Inspector</div>
        </div>
      </div>
    </div>

    <p class="rdd-diagram__caption">
      Dashboard 页呈现中心面板与侧栏；Motor 与 Calibration 各自使用独立左侧导航页。
    </p>
  </figure>
</template>
