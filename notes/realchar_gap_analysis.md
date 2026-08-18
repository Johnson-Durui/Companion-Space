# RealChar Gap Analysis

## 可以借鉴的部分

- 交互形态灵感
- 语音角色产品体验参考
- 前端角色化呈现方式

## 不作为生产主干的原因

- 原始定位不完全贴合法硕 RAG 场景
- 供应商与模型集成方式偏旧
- 2026 语音、检索、头像和可观测性要求更高

## 本仓库采取的策略

- 不在 RealChar 基础上硬改
- 直接新建可维护 monorepo
- 先稳住 provider abstraction、prompt contract 和后续扩展边界
