import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import SystemArchitecture from '../components/SystemArchitecture.vue'
import DataFlowDiagram from '../components/DataFlowDiagram.vue'
import ConnectionSessionFlow from '../components/ConnectionSessionFlow.vue'
import UiLayoutDiagram from '../components/UiLayoutDiagram.vue'
import RobotViewDataFlow from '../components/RobotViewDataFlow.vue'
import MotorControlFlow from '../components/MotorControlFlow.vue'
import TcpTrajectoryFlow from '../components/TcpTrajectoryFlow.vue'
import Joint4CalibrationFlow from '../components/Joint4CalibrationFlow.vue'
import ToolbarOverview from '../components/ToolbarOverview.vue'
import './diagrams.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('SystemArchitecture', SystemArchitecture)
    app.component('DataFlowDiagram', DataFlowDiagram)
    app.component('ConnectionSessionFlow', ConnectionSessionFlow)
    app.component('UiLayoutDiagram', UiLayoutDiagram)
    app.component('RobotViewDataFlow', RobotViewDataFlow)
    app.component('MotorControlFlow', MotorControlFlow)
    app.component('TcpTrajectoryFlow', TcpTrajectoryFlow)
    app.component('Joint4CalibrationFlow', Joint4CalibrationFlow)
    app.component('ToolbarOverview', ToolbarOverview)
  },
} satisfies Theme
