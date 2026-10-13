<template>
  <figure class="rdd-diagram" role="img" aria-labelledby="rdd-rv-title" aria-describedby="rdd-rv-desc">
    <p id="rdd-rv-title" class="rdd-diagram__title">Robot View 数据流 · URDF / JointState</p>
    <p id="rdd-rv-desc" class="rdd-diagram__sr">
      /robot_description String 与 JointState Topic 进入 Bridge；Bridge 向 Robot View 提供
      URDF XML、package:// 网格与纹理、以及关节位置。
    </p>

    <div class="rdd-flow" aria-hidden="true">
      <div class="rdd-flow__row rdd-flow__row--3">
        <div class="rdd-flow__node rdd-flow__node--ros">
          <strong>/robot_description</strong>
          <small>std_msgs/String</small>
        </div>
        <div class="rdd-flow__edge rdd-flow__edge--in">
          <span class="rdd-flow__edge-label">URDF XML</span>
          <span class="rdd-flow__arrow" aria-hidden="true">→</span>
        </div>
        <div class="rdd-flow__node rdd-flow__node--bridge">
          <strong>Bridge</strong>
          <small>TRANSIENT_LOCAL · package://</small>
        </div>
        <div class="rdd-flow__edge rdd-flow__edge--in">
          <span class="rdd-flow__edge-label">XML · mesh · 纹理</span>
          <span class="rdd-flow__arrow" aria-hidden="true">→</span>
        </div>
        <div class="rdd-flow__node rdd-flow__node--app">
          <strong>Robot View</strong>
          <small>Three.js · urdf-loader</small>
        </div>
      </div>

      <div class="rdd-flow__row rdd-flow__row--3" style="margin-top:0.55rem">
        <div class="rdd-flow__node rdd-flow__node--ros">
          <strong>JointState Topic</strong>
          <small>默认 /stm32/joint_states</small>
        </div>
        <div class="rdd-flow__edge rdd-flow__edge--in">
          <span class="rdd-flow__edge-label">name / position</span>
          <span class="rdd-flow__arrow" aria-hidden="true">→</span>
        </div>
        <div class="rdd-flow__node rdd-flow__node--bridge">
          <strong>Bridge</strong>
          <small>共享订阅解码</small>
        </div>
        <div class="rdd-flow__edge rdd-flow__edge--in">
          <span class="rdd-flow__edge-label">关节位置</span>
          <span class="rdd-flow__arrow" aria-hidden="true">→</span>
        </div>
        <div class="rdd-flow__node rdd-flow__node--app">
          <strong>Robot View</strong>
          <small>驱动关节姿态</small>
        </div>
      </div>
    </div>

    <p class="rdd-diagram__caption">
      名称末段为 <code>/robot_description</code> 的 Topic 使用 RELIABLE + TRANSIENT_LOCAL + KeepLast(1)。
    </p>
  </figure>
</template>
