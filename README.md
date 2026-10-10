# DSH 售前解决方案插件

本包是一个 DeepSeek Harness（DSH）插件。本地售前流程使用以下两个工具：

| 工具 | 用途 |
| --- | --- |
| wlyd_ingest | 读取本地材料，提取文字并记录图片 |
| wlyd_solution | 把结构化章节输出为 Markdown、HTML、DOCX 和 JSON |

还提供 /presales 命令和“售前解决方案”对话关键词入口。直接说“给我一份 CallWan 的产品售前解决方案”，插件会自动查找当前账号有权限且名称匹配的内容中台知识库；未找到或暂不可读时，尝试公开检索，然后直接生成客户版初稿，不再要求先上传路径或确认大纲。未说明客户接触阶段时默认初次接触，可在请求中说“深入接触版”。只有产品名而没有可读资料时会说明缺口，不把未知产品能力写成事实，也不交付空白幻灯片。产品名缺失、同分匹配多个不同知识库时才询问用户。明确指定本地材料或“材料=平台”仍走材料选择、证据判断和可调整大纲流程。章节建议约 3—6 章，按业务背景、典型挑战与对应做法、产品价值、场景落地和有依据的企业介绍组织；技术接口材料只作能力依据。初稿须人工复核后再使用。

## 拿到压缩包后安装

接收方需要：

- 可正常启动的 DSH，且其工具运行时已包含调度器标识修复（见下方“常见问题”）。
- Node.js 22 或更新版本、pnpm，以及安装依赖时可访问 npm 软件包源的网络。
- DSH 当前会话可用的模型服务。自动生成时，模型负责按资料写正文；模型不可用时会提示失败，不会把占位结构稿当成正式方案。使用本地材料入口时才需要本地文件。

把 wlyd-dsh-presales-solution-0.8.4.tgz 放在本机任意目录，执行：

~~~sh
dsh plugin --profile web add "/绝对路径/wlyd-dsh-presales-solution-0.8.4.tgz"
~~~

安装成功后**重启**正在运行的 DSH Web：

~~~sh
dsh web
~~~

若 DSH Web 已在运行，先在其终端按 Ctrl+C，再运行上述命令。浏览器按终端给出的地址和认证方式打开。插件自带 cordis.patch.yml；正常安装时，DSH 会自动把它加入 web profile 的 bundle 列表，不需要手改配置文件。

## 五分钟试用

先准备一份纯文本示例材料：

~~~sh
mkdir -p "$HOME/dsh-presales-demo/materials"
printf '# 示例产品\n\n客户痛点：售前资料分散，查找费时。产品提供统一资料管理，帮助团队集中整理售前资料。\n' > "$HOME/dsh-presales-demo/materials/产品介绍.md"
~~~

在 DSH Web 新建对话，先用普通文字输入下面这句。将路径换成你电脑上的**实际绝对路径**；不要把字符串 $HOME 原样粘进对话框。

~~~text
用材料=/Users/你的用户名/dsh-presales-demo/materials 生成售前解决方案
~~~

已有会话中也可输入 `/presales /Users/你的用户名/dsh-presales-demo/materials` 直接运行命令。当前 DSH Web 在空白新会话中输入斜杠命令可能不会建立会话，所以首次试用优先使用普通文字入口。也可以直接输入“给我一份 CallWan 的产品售前解决方案”，无需事先上传材料。插件先查匹配知识库，必要时查公开资料，直接交付初稿。只输入“售前解决方案”而没说产品名时，插件只会询问产品名称。

明确提供本地路径或“材料=平台”时，当前模型先判断材料并给出大纲草案。此时**尚未生成正式方案**。DSH WebUI 会在输入区按章节显示简短的大纲与“按此大纲生成”选项，也能直接输入修改意见；其他客户端可回复“第2章改为：实施路径”“合并第2章和第3章为：方案与能力”“删除第3章”“新增章节：交付计划”或“顺序：2,1,3”。每次调整都会再次展示大纲；说**“就按这个生成”**、**“可以，开始吧”**或“确认大纲”都会开始生成；不明确的回复会先澄清。输出的章节标题和顺序与确认稿一致。建议保持 3—6 章，调整范围为 2—8 章。

明确提供材料的流程中，如果材料缺少明确客户问题，插件先从场景和能力归纳候选痛点；模型会再次独立核对“问题—做法”是否在同一场景、做法是否直接起作用。仍不足且已启用 `web_search` 时，插件自动用预设行业和主题词查询公开资料，不把企业资料原文或客户名放进搜索词。最多保存 5 条 URL、时间和摘要到 `presales-runs/<运行目录>/research/public-sources.md`；也可主动说“帮我网上找找公开资料”重试。公开结果只支持行业问题，不能证明本公司能力或客户收益。仍拿不准时，DSH WebUI 在输入区展示选择和自由补充；没有问答界面的客户端会给出文字问题。你可补充信息、先看待确认大纲，或停止。补充事实标待核实，不会自动发布到知识库。大纲可用日常说法修改和确认。这个人工选择流程在模型不可用时会停在提问状态；直接产品请求若正文仍不足，也会停止交付并说明原因。直接使用 `wlyd_solution` 工具时必须提交 `pain_solution_links`；没有可靠对应关系时传空数组。平台生成工具 `wlyd_platform_generate` 也必须传入已确认的 `outline_headings`，并检查返回章节与确认稿一致。

确认大纲后，插件从可读材料中提炼段落、要点和步骤，并核对每个内容块附带的引用是否逐字存在、是否属于该章来源；不合格内容不进入初稿。导入时先去掉 HTML 的样式、脚本、标签和明显的 PDF 乱码，再按长度截取可读正文，避免长 CSS 挤掉业务内容；行内标签之间的文字会保留，模型返回的代码或乱码段落也会被拒绝。整稿输出被截断时按章重试；若仍有超过一半章节没有有依据的正文，会明确停止交付，不生成占位幻灯片。少量资料缺口仍标待确认。推断及公开痛点的待确认状态会保留在 JSON、HTML、Markdown、DOCX 与编辑界面。特殊字体编码的 PDF 仍可能需要人工检查或重新提供可选中文字版本。

产物写在该 DSH 会话的工作目录下，每次使用独立的 presales-runs/<时间>-<随机码>/ 目录：

| 文件 | 内容 |
| --- | --- |
| analysis/materials.json | 材料清单、提取状态与摘录 |
| analysis/corpus.md | 提取的文字 |
| solution.md | 从 JSON 同步生成的 Markdown |
| solution.html | 可在 DSH 编辑入口修改的幻灯片，亦可打印保存 PDF |
| solution.docx | Word 初稿 |
| solution.json | 唯一结构化源稿，含编辑版本和稳定内容 ID |
| solution.versions/ | 每次保存时保留的历史版本 |
| solution.knowledge-proposals/ | 涉及事实的修改所生成的待审核记录 |

DSH 的结果消息会显示方案结构预览、章节列表，以及“打开幻灯片并编辑”“下载 Word/Markdown/JSON”入口。这些地址由 DSH Web 提供，须先按启动终端给出的方式完成认证，再在同一浏览器中打开；下载内容与本轮 `solution.json` 同步。文件仍保存在会话工作目录的 `presales-runs/` 下，可按上表查找。HTML 的 PDF 输出使用浏览器“打印 → 保存为 PDF”，并非服务端生成 PDF。

HTML 使用 16:9 页面，按浏览器视口完整缩放。封面只展示方案主题和必要抬头，目录单独成页。正文按内容选择大字主张、能力清单、流程时间线、痛点与方案连接图、截图和表格；标题、正文与依据有明确层级。可纵向浏览，也可点“下一页”或用方向键、PageUp/PageDown、空格、Home/End 逐页演示。页码控制旁的“隐藏来源”按钮可切换来源注释、痛点依据和表格依据列的显示；再次点击“显示来源”即可恢复。这只影响当前 HTML 的展示与打印，不删除 JSON、Markdown、Word 中的依据。浏览器打印输出全部页面。随包附带的 `guides/slide-design.md` 和 `skills/wlyd-presales-html-ppt/SKILL.md` 记录设计与检查规则；安装后该原创 Skill 会注册到 DSH Skill 目录，确定性渲染器已把页型选择和层级规则落实在 HTML 中。参考 Codex `impeccable`、`html-design-master`、`guizang-ppt-skill` 的设计方法以及 [SkillHub html-ppt-skill 2.3.0](https://skillhub.cn/skills/user_e9af5021/html-ppt-skill)，本包没有复制外部模板或代码。当前**没有可编辑 PPTX 导出**，也不依赖 WorkBuddy 的 `tencent-pptx`。

生成阶段会要求模型使用面客话语；写入同版 JSON 前还会转换已知的内部制作文案，再同步输出 HTML、Markdown 和 Word。封面不出现内部复核提示，来源引文与路径不被润色。没有足够证据的内容仍会明确写“待与贵方确认”，不能把推断当作已确认的客户事实。

0.6.1 起长段落、列表、表格和痛点依据会按文字量拆页，超长路径可换行；页面内保留边界安全区。封面主标题、章节标题、内容页标题和卡片小标题有明确字号层级。极端长内容若仍超出单页容量，会留在页内可滚动区域，打印前建议逐页检查。

## 在 HTML 中编辑并同步文件

生成结果会给出 **HTML 编辑入口**，例如 `http://127.0.0.1:3080/wlyd-presales/doc/.../solution.html`。请在已完成 DSH Web 认证的同一浏览器中打开，点击右下角“编辑方案”。可修改标题、章节、段落、列表、表格、指标、图片说明和 PNG/JPEG 图片；痛点与对应做法在同一组中修改。保存后产生新版本，并从 `solution.json` 统一重生成 Markdown、HTML、DOCX；旧版保留在 `solution.versions/`。若另一窗口已保存新版，旧窗口会提示刷新，不会覆盖新版。

直接双击本地 `solution.html` 可以预览和打印，但离线页面无法连接 DSH 的授权保存接口，因此不能完成跨文件与知识库同步。Word 或 Markdown 中的单独修改也不会自动反向同步；请在 HTML 编辑入口完成需保持一致的修改。

修改涉及产品事实时，勾选“提交知识审核”并说明原因。插件将变更与来源记录到 `solution.knowledge-proposals/`。当前尚未拿到正式知识库接口，记录状态会明确显示 `awaiting_knowledge_api`，**不等于已入库**。知识团队提供审核入口后，可在运行 DSH 的服务端配置 `WLYD_KNOWLEDGE_PROPOSAL_URL`，需要令牌时配置 `WLYD_KNOWLEDGE_API_TOKEN`；本插件只提交待审核请求，不直接发布知识。请求契约见 `guides/knowledge-api-contract.md`。配置完成后，新修改会立即尝试提交；旧记录可用以下命令重试：

~~~sh
node bin/submit-knowledge.mjs "/方案所在目录" solution
~~~

## 材料与当前边界

支持本地文件、目录和 ZIP。可提取 md、txt、csv、json、html、docx、pdf、pptx 的文字；图片会登记为素材。图片扫描版 PDF 若没有可提取的文字，当前不会做 OCR。远程链接和聊天附件尚未接入。内容中台读取先校验项目绑定，再将解析完成的文档下载到本轮独立目录 `presales-runs/<运行目录>/platform-materials/<知识库ID>/`，避免混入上次资料或覆盖同名文档。每篇最多 20 MB，每轮最多 100 MB/400 篇；超过限额会明确停止。账号与地址来自部署方配置（`WLYD_PLATFORM_*`）；服务端仍负责最终读写权限校验。材料没有可提取正文时，插件会提示并停止生成。

### 向内容中台上传资料

部署方在运行 DSH 的机器上配置 `WLYD_PLATFORM_BASE_URL`、`WLYD_PLATFORM_EMAIL`、`WLYD_PLATFORM_PASSWORD`、`WLYD_PLATFORM_TENANT_ID`；密码只放服务端环境或 `$DSH_HOME/.env`，不要放入对话、浏览器或分发包。`wlyd_platform_setup` 用于新建项目、绑定知识库并上传 1—10 个工作区文件；`wlyd_platform_upload` 用于上传到已有项目，需传 `project_id`、`knowledge_base_id` 和 `files`。后者先核验知识库属于该项目，再上传并查询解析状态。文本文件直接上传；DOCX/PDF/PPTX 先提取文字再按 Markdown 上传；图片和 ZIP 不作为平台上传件。上传不会自动发布修改后的方案事实，HTML 编辑后的事实仍须走知识审核。

0.8.0 已用独立合成资料验证登录、项目绑定、上传、解析完成、列表读取和原文下载。该联调账号是租户级测试账号，不能代表每位业务用户的权限；项目成员和企业间隔离仍应使用各自身份做验收。其他接收方需要自己的合法平台账号与项目授权。

插件只处理当前会话可访问的本地路径。给其他人分发压缩包时，**材料文件不会包含在包内**，需要他们在自己的电脑上准备。不要把真实 API Key 或客户敏感材料放进分发包。

如需离线恢复渲染，可修改 `solution.json`，再用包内 `bin/render.mjs` 重生成文件；这种手工方式不建立编辑版本，也不提交知识审核记录。

## 确认安装与常见问题

- 安装后没有 /presales：确认安装命令使用的是 web profile，并重启 DSH Web；检查安装日志中是否成功加入 @wlyd/dsh-presales-solution bundle。
- 提示找不到材料：使用真实绝对路径，确认运行 DSH 的用户有读取权限。
- 提示“没有可提取的正文”：先用带文字的 md/txt/docx 等文件试运行；扫描图像需要另外的 OCR 能力。
- 提示材料不足或模型判断失败：先核对当前会话模型能否正常回复，再补充客户痛点和对应产品做法；不要把待确认项当成已核实事实。
- 编辑入口提示 401：用 DSH Web 启动时给出的带令牌地址登录，再从结果消息打开编辑链接。
- Word/Markdown/JSON 链接打不开：确认 DSH Web 仍在运行、插件已重启加载，并在同一浏览器完成认证；直接打开会话目录下的相对路径不是浏览器下载地址。
- 知识状态为 `awaiting_knowledge_api`：文件已保存，但知识库尚未接入；待知识团队提供接口并配置后重试。
- 出现 Cannot read properties of undefined (reading 'prepare')：接收方的 DSH 工具运行时可能缺少调度器修复。需使用包含 packages/core/tools/src/index.ts 中 Symbol.for('@deepseek-ai/dsh-tools.scheduler') 修复的 DSH 构建，并重启 DSH；只重装此插件无法修复宿主程序。

## 开发与打包

在插件源码目录运行：

~~~sh
npm ci
node --test test/*.test.mjs
node test/selftest.mjs /tmp/dsh-presales-selftest
mkdir -p dist
npm pack --pack-destination dist
~~~

npm pack 生成可分发的 .tgz；安装后的运行依赖由包管理器获取。包内只收录 README、入口与渲染代码、DSH 挂载声明，不收录本机 node_modules、材料或凭证。
