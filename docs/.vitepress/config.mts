import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Rebotarm Debug Desk',
  description:
    'macOS ROS 2 Humble debug console — Tauri + React + Three.js, Jetson WebSocket Bridge over SSH',
  base: '/rebotarm-debug-desk/',
  cleanUrls: true,
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: '介绍', link: '/' },
      { text: '架构', link: '/architecture' },
      { text: '连接', link: '/connect' },
      { text: '功能', link: '/features' },
      { text: 'VLA', link: '/vla' },
      { text: '安装', link: '/install' },
      { text: '部署 Bridge', link: '/deploy-bridge' },
      {
        text: 'GitHub',
        link: 'https://github.com/phamstered/rebotarm-debug-desk',
      },
    ],
    sidebar: [
      {
        text: '开始使用',
        items: [
          { text: '项目介绍', link: '/' },
          { text: '架构概览', link: '/architecture' },
          { text: '连接与 Bridge', link: '/connect' },
          { text: '功能概览', link: '/features' },
          { text: 'VLA 使用指南', link: '/vla' },
          { text: 'macOS 安装 (install:mac)', link: '/install' },
          { text: '部署 Bridge (deploy:bridge)', link: '/deploy-bridge' },
        ],
      },
      {
        text: '参考',
        items: [
          { text: '基本功能与测试覆盖', link: '/basic-features' },
          { text: 'Bridge 协议', link: '/protocol' },
          { text: 'Joint4 标定', link: '/joint4-calibration' },
          { text: '重力辨识（设计）', link: '/gravity-identification' },
        ],
      },
    ],
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/phamstered/rebotarm-debug-desk',
      },
    ],
    outline: { level: [2, 3] },
    search: { provider: 'local' },
    footer: {
      message: 'User docs for Rebotarm Debug Desk',
      copyright: 'Source: README.md and docs/ in the repository',
    },
  },
})
