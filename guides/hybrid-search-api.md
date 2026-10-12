# 内容中台混合检索接入

插件通过当前账号登录，并确认项目与知识库绑定后，调用 WeKnora 通用 API：

```http
POST /api/v1/knowledge-bases/{id}/hybrid-search
Authorization: Bearer <token>
X-Tenant-ID: <tenant_id>
Content-Type: application/json
```

线上通用 Swagger 的请求体引用 `SearchParams`，主要字段如下：

```json
{
  "query_text": "产品名称 客户挑战 产品能力",
  "match_count": 6,
  "knowledge_ids": ["knowledge-id"],
  "skip_context_enrichment": true
}
```

`knowledge_ids` 只传当前账号可见且属于当前绑定知识库、解析状态为 `completed` 的文档 ID。权限仍由平台接口执行，插件不以本地筛选代替服务端授权。

成功响应为 `{ "success": true, "data": [SearchResult] }`。线上 Swagger 的 `SearchResult.id` 是 chunk ID，`knowledge_id` 是文档 ID，`content` 是分块正文，`score` 是召回分；`knowledge_title`、`knowledge_filename`、`chunk_index` 和 `seq` 用于引用展示。插件同时兼容矩阵所记录的 `chunk_id` 与 `matched_content` 字段名，但要求最终得到 chunk ID、文档 ID 和可读正文才纳入证据。

售前检索按企业背景、客户挑战、产品能力/场景、实施/服务发起四个主题查询，每次请求最多取 6 条；按 chunk ID 合并重复结果后，最多保留 20 个高分片段。生成用引用路径包含文档标题、分块位置及 chunk ID。原始请求和命中内容保存到每次运行目录的 `research/retrieval-snapshot.json`，可用于重现和后端排查。

空命中与接口错误不回退到整篇文档下载。HTTP 错误应保留状态码、后端错误码/信息及 `X-Request-ID`；将这些信息与知识库 ID、运行时间一并提供给后端排查，不能在日志中附带访问令牌或密码。

契约核对来源：`https://agentwan.stelladream.cn/swagger/doc.json`、`https://agentwan.stelladream.cn/swagger/index.html`。接口响应仍需在有数据的授权知识库中做线上联调；自动测试以符合 Swagger 字段的 mock 响应验证调用和引用逻辑。
