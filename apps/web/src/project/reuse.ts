/**
 * Project 屏借用会话屏的地方，集中在这里。
 *
 * 主对话与 Thread 面板复用既有的消息渲染、计划面板与会话事件投影 —— 它们描述的是同一件
 * 事（Session 的模型可见历史），Project 只是换了一个装配方式。
 */
export { MessageBlock } from '../conversation/Transcript'
export { PlanPanel } from '../PlanPanel'
export { projectEvents } from '../projectEvents'
export { latestPlanFromEvents } from '../planDisplay'
export type { DisplayMessage } from '../types'
export type { DisplayPlan } from '../planDisplay'
