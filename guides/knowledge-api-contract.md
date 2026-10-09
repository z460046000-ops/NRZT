# 售前插件 → 知识库审核接口约定（待联调）

插件当前已经把涉及事实的 HTML 改动保存为 `solution.knowledge-proposals/<id>.json`，并在 `solution.json` 中保存提案 ID 与材料版本的关联。它不会直接修改已发布知识。

## 提交接口

部署方以服务端环境变量 `WLYD_KNOWLEDGE_PROPOSAL_URL` 指定完整 HTTPS 地址（本机联调可用 loopback HTTP），可选用 `WLYD_KNOWLEDGE_API_TOKEN` 传 Bearer 凭证。真实 Key 不进入 HTML、方案 JSON、日志或分发包。

插件向该地址发送 `POST application/json`，同时发送 `Idempotency-Key: <提案 id>`。请求结构：

~~~json
{
  "id": "uuid",
  "status": "awaiting_knowledge_api",
  "createdAt": "2026-10-08T00:00:00.000Z",
  "material": { "editorId": "uuid", "baseRevision": 1, "revision": 2 },
  "scope": "project",
  "targetId": "项目或企业 ID",
  "reason": "用户填写的事实变化原因",
  "changes": [{ "path": "links/P1/pain", "value": "修改后的痛点" }],
  "evidence": [{ "path": "材料路径", "quote": "材料原文" }]
}
~~~

`scope` 为 `project` 或 `enterprise`。`targetId` 由知识库按当前服务凭证和企业/项目权限核验；客户端输入不能直接授予权限。`evidence` 是方案生成时保留的来源线索，不能当作已验证的新事实证据；审核人须核对修改后的主张与原件是否仍对应。普通措辞修改不提交此接口。

接口接收后建议返回 HTTP 202 和 `{ "requestId": "审核任务 ID" }`。插件把本地状态更新为 `submitted_for_review` 并保存 `remoteRequestId`；这仍不是“已发布”。重复 `Idempotency-Key` 应返回同一审核任务。失败时本地记录保留为 `delivery_failed`，可运行 `bin/submit-knowledge.mjs` 重试。

知识库团队仍需提供审核结果查询或回调契约，供插件记录 `approved/rejected`、知识修订 ID 与失效原因。该接口尚未交付，也未用真实企业/项目权限联调，因此当前不能宣称编辑后的事实已进入知识库。正式接入时应覆盖跨企业/跨项目拒绝、旧材料版本、来源撤权、无证据主张、重复提交与审核退回。
