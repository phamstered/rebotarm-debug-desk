import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import SystemArchitecture from '../components/SystemArchitecture.vue'
import DataFlowDiagram from '../components/DataFlowDiagram.vue'
import './diagrams.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('SystemArchitecture', SystemArchitecture)
    app.component('DataFlowDiagram', DataFlowDiagram)
  },
} satisfies Theme
