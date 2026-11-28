# HDM（类陈述记忆 / Human-like Declarative Memory）

> 本地、纯文件、超长期的大语言模型陈述性记忆系统。给 DSH 一个可配置的「母文件夹」，像人一样按日期归档会话、整理、遗忘、联想和回忆。

版本：0.4.0 · 包名：`dsh-hdm` · 无第三方运行时依赖 · 纯 ESM

---

## 特性

| 能力 | 说明 |
|---|---|
| 全局记忆 | 所有会话写入同一个母文件夹，跨项目共享 |
| 顺序快照 | 每条记忆创建时只有 `level2`（最详细）；第 2 天压缩成 `level1`；第 5 天再压缩成 `level0`（只剩梗概）。只从上一档派生，旧档冻结、不再改动 |
| 记忆调取 | 模型给关键词，脚本按「命中关键词数 + 记忆等级 + boost」排序，返回 top 3；命中过的记忆会带回 `higherLevels`（更详细档位）供继续阅读 |
| 联想 | 高频记忆被调取时，附带少量相关记忆（同人/同日/同事件/共同关键词），总字数受限 |
| 日记 | 每天 23:30 自动把当日记忆汇总成日记，启动时补写最近 7 天；模型不可用时走确定性摘要 |
| 自传体记忆 | 母文件夹下的 `IAM.md`，首轮注入全文、每 6 轮注入短锚点、上下文压缩后重新注入 |
| 人物档案 | `characters/` 下每人一份 `.md`；框架固定四节（基本 / 偏好与语气 / 关系与互动 / 待确认 / 矛盾），不另开新节。写法与意象同源：一句一事实、只写可核对的事实与结论，不铺陈、不写百科与评价。用户（USER）永远第一优先；只追加不覆盖，冲突标注「待确认 / 矛盾」。召回命中人物关键词时行内附档案摘录**并提示先读档案**，首轮另注入「用户档案」一段 |
| 永久豁免 | 用户说「永远记住」、重要性 ≥5、或 30 天内被调取 ≥6 次的记忆永不压缩、不进遗忘流水线 |
| 低使用率兜底 | 新会话自动接力上一段对话；之后每条用户消息自动召回；每 6 个用户回合轻提醒一次；上下文到 50% 提醒保存 |

## 安装

```bash
# 在 DSH 会话中：
# plugin_manager install_bundle  target = <本仓库克隆后的本地路径>
# 安装后确认：cordis_inspect_query Config.listConfigs  name = dsh-hdm
```

安装层若要求重启 DSH，重启后生效。插件默认启用（`enabled: true`），母文件夹默认 `~/.dsh-hdm`。

## 配置

在 DSH 配置中为 `dsh-hdm` 增加配置项即可，全部可省略。常用键：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `homeDir` | `~/.dsh-hdm` | 母文件夹，支持 `~` |
| `timeZone` | `Asia/Shanghai` | 日期归属时区 |
| `promptLang` | `zh` | 提示词语言 |
| `save.threshold` | `0.50` | 上下文压力达到该比例时提醒保存 |
| `save.step` | `0.15` | 下一次提醒的压力增量 |
| `save.maxPerSession` | `4` | 单会话最多提醒次数 |
| `recall.topK` | `0` | 默认返回条数；`0` = 跟随本次输入的关键词个数（上限 12） |
| `recall.levelBias` | `1` | 权重中的等级系数 |
| `handoff.enabled` | `true` | 新会话接力 |
| `handoff.maxChars` | `2000` | 接力内容上限 |
| `autoRecall.enabled` | `true` | 自动召回 |
| `autoRecall.minScore` | `2` | 低于该分数不注入 |
| `autoRecall.gistEnabled` | `true` | L2 派生 gist 并直接注入自动召回 |
| `autoRecall.gistChars` | `120` | 单条 gist 字数上限 |
| `autoRecall.gistRefreshMinutes` | `30` | gist 巡检间隔（分钟） |
| `nudge.everyUserTurns` | `6` | 低使用率提醒间隔 |
| `nudge.staleMinutes` | `45` | 距上次保存超过该分钟数且已积累 3 轮发言时补一次提醒（`0` 关闭）；防止「存完又干很久、那段工作没落盘」 |
| `iam.maxChars` | `6000` | `IAM.md` 上限 |
| `iam.anchorEveryTurns` | `6` | 自我锚点间隔，`0` 关闭 |
| `diary.time` | `23:30` | 日记生成时间 |
| `forget.days` | `[2, 5]` | 快照派生天数 |
| `forget.exemptMode` | `tiered` | `delay` / `skip` / `tiered` |
| `association.triggerCount` | `4` | `hitCount` 超过该值才联想（`hitCount` 是加权浮点，见下节） |
| `association.recencyWindowDays` | `30` | 联想的时间衰减窗口：越旧权重越低，保底 0.2 |
| `association.maxChars` | `1500` | 联想总字数上限 |
| `characters.maxChars` | `12000` | 单人物档案上限 |
| `characters.injectOnRecall` | `true` | 召回命中人物时附档案摘录、首轮注入「用户档案」 |
| `characters.snippetChars` | `200` | 单条人物摘录字数上限 |
| `autoRecall.vocabTop` | `50` | 记忆词表向模型展示的词数（按 keyness × 时间衰减排） |
| `autoRecall.vocabChars` | `1200` | 记忆词表注入字数上限（`0` = 不注入） |
| `imagery.enabled` | `true` | 意象层（关键词线索记忆）开关 |
| `imagery.threshold` | `15` | 关键词进入意象层的最低记忆质量分 |
| `imagery.minMemories` | `2` | 关键词至少出现在几条记忆里才建意象 |
| `imagery.injectOnRecall` | `true` | 召回命中已建意象时附条目路径 |
| `imagery.maxReadChars` | `6000` | `hdm_imagery read` 单次返回字数上限 |
| `imagery.maxSummaryChars` | `120` | 召回时附带的释义概述字数上限（取「释义」首句） |
| `sharing.enabled` | `false` | 跨会话记忆共享总开关 |
| `sharing.level` | `0` | `0` 关 / `1` 只共享活跃会话 / `2` 再加旧会话 uid |
| `events.enabled` | `true` | 事件索引与 `Events/` 事件档案开关 |
| `events.maxLines` | `400` | 单份事件档案行数上限，超了自动开第二份（`维护插件1.txt`） |
| `events.maxReadChars` | `6000` | `reconception read` 事件档案的字数上限 |
| `profileCompact.enabled` | `true` | IAM 与人物档案定期压缩开关 |
| `profileCompact.hours` | `6` | 压缩间隔（小时） |
| `profileCompact.minIntervalMinutes` | `60` | 最短间隔（分钟），防止配置写小后反复调模型 |
| `maintenance.provider` / `maintenance.model` | 空 | 后台维护模型，空则用默认模型 |
| `maintenance.maxTokens` | `100000` | 后台调用输出预算；宿主会按模型窗口向下钳制，填大了不报错 |
| `maintenance.timeoutSeconds` | `600` | 单次后台调用超时（秒） |
| `idle.enabled` | `true` | 空闲对话自动整理 |
| `idle.idleMinutes` | `180` | 空闲下限（分钟）：低于它不整理 |
| `idle.maxIdleMinutes` | `720` | 空闲上限（分钟）：达到它视为陈旧、不整理 |
| `idle.checkMinutes` | `15` | 扫描间隔（分钟），只决定检查频率 |
| `idle.minIntervalMinutes` | `60` | 同一会话两次整理的最小间隔 |
| `idle.maxRunsPerDay` | `12` | 每日整理次数上限（`0` = 不限） |
| `idle.minUserMessages` | `2` | 少于该用户消息数不整理 |
| `idle.maxInputChars` | `12000` | 单次送模型的增量文本上限 |

完整配置见 [PLAN.md](./PLAN.md) §3。

## 目录结构

```
<母文件夹>/
├── IAM.md                       # 自传体记忆（固定标题）
├── memory/
│   └── 2026-11-07/
│       └── 2_2026-11-07_001_旅行_杭州_西湖_…/
│           ├── level2.txt       # 创建时唯一快照（详细）
│           ├── level1.txt       # 第 2 天从 L2 派生
│           ├── level0.txt       # 第 5 天从 L1 派生
│           └── meta.json        # uid/关键词/等级/命中/豁免等
├── diary/
│   └── 2026-11-07.txt           # 每日日记
├── characters/
│   └── USER.md                  # 用户档案（第一优先）
├── Backup/
│   ├── memories.json.bak        # 索引写入前的备份
│   └── keywords.json.bak
├── index/
│   ├── memories.json            # uid -> meta
│   └── keywords.json            # 关键词 -> uid/最高档
└── state/
    ├── sessions.json            # 每会话状态
    └── jobs.json                # 维护任务幂等记录
```

- `IAM.md` 的「记忆索引」是系统维护的有界摘要：只放统计 + 最近 12 条，完整清单以 `index/memories.json` 为准，记忆上千条也不会把 IAM 撑大。
- `Backup/` 只放索引文件的 `.bak`；整库版本快照在**母文件夹之外**（`<主目录>/.dsh-hdm-backups/<母文件夹slug>/`，可用 `backup.dir` 改），母文件夹被整个删掉也不丢。

- 记忆 `uid` 形如 `m-20261107-001`，稳定不变；文件夹名前缀是当前默认档（`2_` → `1_` → `0_`），派生快照时自动改名。
- 关键词数量按档位固定：L2 需 10–12 个、L1 8–10 个、L0 5–8 个。

## 工具

| 工具 | 用途 |
|---|---|
| `hdm_save` | 保存一段记忆：`summary`、`keywords`（10–12，按重要性降序）、可选 `details`/`quotes`/`people`/`scene`/`event`/`emotion`/`source`/`importance`/`immortal`/`characters`/`relatedUids` |
| `hdm_recall` | 按关键词调取：`keywords`、`topK`、`view`（auto/0/1/2）、`sameDayOf`、`boost`、`includeAssociations` |
| `hdm_read` | 读指定记忆的指定快照：`uid`、`level`、`offset`、`limit` |
| `hdm_character_update` | 更新人物档案：`name`、`notes`，可选 `section`（基本 / 偏好与语气 / 关系与互动 / 待确认 / 矛盾）/`aliases`/`confidence`/`evidenceUid`/`mode` |
| `hdm_iam_update` | 更新 `IAM.md`：`content`、`mode`（append/replace_section/rewrite）、`section` |
| `hdm_organize` | 主动整理：修复 meta 漂移、清理临时文件、重建索引；`dryRun:true` 只预览 |
| `hdm_backup` | 版本快照（存在母文件夹之外）：`action=status/snapshot/restore`；恢复必须 `confirm:true`，IAM/人物/记忆/日记原样还原 |
| `hdm_imagery` | 意象层（关键词线索记忆）：`action=list/read/write`；`write` 需 `term`，质量分达 `imagery.threshold` 且 ≥`imagery.minMemories` 条记忆承载才允许写 |
| `reconception` | 档案调取：`kind=event/character/keyword`、`term`、`mode=index/read`；与 `hdm_recall` 分工——recall 查记忆单元，reconception 调取 `Events/`、`characters/`、`Imagery/` 正文 |

## 上一段对话选谁（0.2.6）

「上一段对话」注入的是别的对话最近的一段记忆。0.2.6 修了三个选错的成因：

| 问题 | 行为 |
|---|---|
| 本会话自己的单元被当成「上一段对话」 | 固定单元及其追加过的单元一律排除 |
| `H:/a` 与 `H:\A` 被判成两个目录 | 比较工作目录时忽略斜杠方向与大小写 |
| 多条 `updatedAt` 相同，选谁取决于遍历顺序 | 依次比 `updatedAt`、`createdAt`，最后按 uid 兜底 |

同时修掉派生 L1/L0 会刷新 `meta.updatedAt` 的问题：那是系统维护动作，不是对话活动。
不修的话旧单元的「最后活动时间」会变成今天——`handoff` 把它当最近对话，
跨天保存也会误判成「3 小时内还有对话」而追加进旧日期单元。

## 同一对话的记忆边界（0.2.5）

固定到同一个单元（`/hdm-remember`、空闲整理成功）之后，**不是永远续写同一个单元**：

| 情形 | 行为 |
|---|---|
| 同一天 | 一直追加，哪怕中间隔了 10 小时 |
| 跨天，且距上次写入 ≤ `save.gapHours`（默认 3 小时） | 继续追加 |
| 跨天，且距上次写入 > `save.gapHours` | **另起一条新记忆**，固定单元自动跟到新的那条 |

为什么要这条边界：一条记忆的 `date` 是它创建那天，跨天继续 append 会让「当天的记忆」永远是 0 条，
日记直接报 `no memories`，旧单元也会被越写越长。判据用的是 `meta.updatedAt`（每次追加都会刷新），
所以连续对话会滚动续期。

## 分级记忆检索（0.2.4）

设置页「自动召回」行里有档位，全局一档，改完即生效：

| 档 | 行为 |
|---|---|
| L0 | 不自动注入召回，只在首轮给一份「记忆词表」；读不读由模型判断 |
| L1 | 默认。真实用户回复时，关键词命中就附「可能相关的记忆」 |
| L2 | L1 + **方案决策点**（上一轮发起了非纯文件类工具，模型正要决定怎么做）+ 子代理首步 |

配套的是一条提示词协议：模型要为达成目标挑方案时（例如抓网页正文——用命令还是用用户桌面浏览器），先把问题压成 3~8 个词表里的名词，再 `hdm_recall`。词表来自 `index/keywords.json`，按 keyness × 时间衰减排，默认给前 `autoRecall.vocabTop`（50）个；`autoRecall.vocabChars` 只卡字数上限（0 = 不注入）。

- 每轮最多自动召回一次（`recallTurn`），已注入的 uid 记在 `recalledUids` 里不重复。
- 纯文件读写续步不算方案决策点（对应「文件写入不算」）；判据是 `FILE_TOOL_RE`，属启发式。
- `autoRecall.subagent` 控制 L2 下子代理首步要不要召回；子代理只召回，不注入 IAM/handoff。

## 记忆词表与检索顺序（0.3.0）

- **词表**：全库关键词跨记忆累加 `(keyness + 1) × 时间衰减`（30 天线性降到 0.25），从高到低排；领域泛词（>30% 记忆都有）不进候选。默认展示前 50 个（`autoRecall.vocabTop`），`vocabChars` 只卡字数。
- **检索顺序**：`hdm_recall` 先在前 50 个词上做模糊匹配（同词 / 双向包含且短边 ≥2 字 / 拉丁词编辑距离 ≤1），用命中的词条取记忆；凑不够期望条数就进 50~100 并降低期望（×0.8，最低 1），一直循环到第 250 个词。
- **兜底**：粗查一路扫完仍不够时，按原倒排做一次精确细找，两条来源按 uid 合并；全都没有才返回空结构。返回里的 `search` 字段带 `stage`（coarse/fine/empty）、`expected`、`aim`、`windows`、`terms`、`fuzzyTerms`，方便排查为什么没找到。
- **返回条数**：默认等于本次输入的关键词个数（上限 12），显式 `topK` 优先；`recall.topK=0` 就是这个默认值。

## 意象层 Imagery（0.3.0）

- **定位**：`Imagery/` 下一个关键词一个 `.md`，记「这个词对我意味着什么」与相关经历；memory/ 按时间，Imagery 按关键词。
- **门槛**：`score = (ΣhitCount + 3×immortal数) × (0.5 + keyness/10)`，默认 `imagery.threshold=15`。现库 252 个词里达标 12 个（IAM 94.6、HDM 82.6、plan 52.6、母文件夹 51.5、goal 39、我是怎样的人 38.5…）。
- **写入**：`hdm_imagery(action=write, term, meaning, uids)`，不达标直接报错；md 只追加不覆盖，索引 `index/imagery.json` 可从 md 重建（`hdm_organize` 一并重建）。
- **召回**：命中行带 `imagery` 字段（term/file/score/**summary**）；`summary` 是「释义」首句（≤`imagery.maxSummaryChars`，默认 120 字），够判断是否相关，正文仍用 `hdm_imagery read` 自取；`imagery.injectOnRecall` 可关。
- 快照覆盖 `Imagery/`，母文件夹之外也存一份。

## 跨会话共享（0.3.0）

- **档位**：`sharing.level` 0 关（默认）/ L1 只共享活跃会话 / L2 再加旧会话 uid；设置页「跨会话共享」下拉可改。
- **活跃判定**：本进程 pre-step 心跳 `busyWindowMinutes`（默认 10）内，或 `lastUserAt` 在 `recentWindowMinutes`（默认 60）内；旧会话指 1h~24h。
- **注入**：首轮与每个真实用户步追加 `===== 跨会话共享 =====`；L1 给 uid + 档位 + 摘要（≤200 字），L2 再给旧会话 uid（≤400 字，只给编号）；按 `state.sessions[id].sharedUids` 去重（最新 200），自身会话不注入自己。
- **跨进程假设**：「正在工作」只能用本进程心跳近似，跨进程退化为 `lastUserAt`。

## 自动召回的 gist（0.3.1）

自动召回过去只塞 L2 摘要的前 120 字——而摘要按规范是「首点 + 末点（结论/遗留）」，**被截掉的恰恰是最有用的末点**。所以给还停在 L2 的记忆派生一条 gist：

| 项 | 行为 |
|---|---|
| 谁需要 | `snapshots` 里只有 L2 的记忆；**已派生 L1/L0 的不管**（L1 本身就是要点），immortal 也不做 |
| 存哪 | 记忆目录下 `gist.txt` + `meta.gist` / `meta.gistAt`；`gistAt >= updatedAt` 视为新鲜，不重写 |
| 谁压 | 维护模型（≤`autoRecall.gistChars`，默认 120 字，要求保留「谁做了什么 + 结论 + 未完成」）；模型不可用时退回**确定性兜底**：取摘要首点 + 末点 |
| 何时跑 | `startGistTimer` 每 `autoRecall.gistRefreshMinutes`（默认 30 分钟）巡检一次；档位 0 或 `autoRecall.enabled=false` 时直接跳过（没有消费者，不烧模型）；首轮延迟一个间隔，避免启动即调模型 |
| 注入 | L2 命中优先用 `meta.gist`；没有 gist 才回退摘要前 120 字，并在末尾标「（摘要未派生，仅前段）」，让模型知道那不是全部 |

## 豁免门槛提高（0.3.1）

`hitCount` 现在是加权浮点（每次召回约 +2.2），原来的 3 次/6 次门槛太容易达到，调整为 ×3：

| 配置 | 旧 | 新 |
|---|---|---|
| `forget.exemptRecallCount`（进 delay） | 3 | **9** |
| `forget.autoImmortalRecallCount`（自动永久豁免） | 6 | **18** |
| `MAX_HIT_COUNT`（计数上限，四处常量） | 10 | **30** |

上限必须同步抬高：18 > 10 会让自动永久豁免**永远不可达**，规则等于被删掉。上限 30 约等于 14 次加权命中。

## 召回块提示读全文（0.3.1）

自动召回注入的每一块开头从「可能相关的记忆（仅供参考）」改为「可能相关的记忆（仅供参考；摘要可能不足以判断，命中相关就用 hdm_read 读全文）：」。

起因是 2026-11-22 的一次自审：一整个长对话里自动召回注入 9 条 uid，`hdm_read` 被调用 **0 次**——所有判断都建立在 120 字摘要上，`path` 给了但没人去读。写提示比改数据结构便宜，先试这一条；若 `hdm_read` 仍然为 0，再考虑把摘要换成一两句结论或直接内联 L1。

## IAM、人物与意象的 0.3.1 调整

- **IAM 删掉「当前目标」节**：目标会频繁变动，写进自传体记忆只会让 IAM 反复膨胀且与记忆重复。固定标题从 8 个减到 7 个；`hdm_iam_update` 的 `section` 枚举同步收窄，旧 `IAM.md` 里残留的「当前目标」不再被锚点或模板补回。
- **人物档案写作要求向意象看齐**：`CHARACTER_SECTIONS` 固定四节（基本 / 偏好与语气 / 关系与互动 / 待确认 / 矛盾），`hdm_character_update.section` 的枚举即为这四节；模板头写死写作要求（一句一事实、不铺陈、不写百科与评价），新建档案起就带约束。
- **意象命中给概述**：`imageryRefs` 现在从条目的「释义」取首句（≤`imagery.maxSummaryChars`，默认 120 字）一起返回；`hdm_recall` 渲染与自动召回注入都显示「term——释义首句（路径）」，人物命中则追加「先读档案再判断」。

## 事件档案 Events（0.4.0）

记忆按时间、意象按关键词，事件按「这类事」。一条事件 = 一段跨天跨会话的经历，不是精确标题：

- **事件名宽泛**：`维护插件` 含维护/更新 HDM 与 LOT 等插件；`和用户聊天` 含聊哲学、聊日常。但 `维护 HDM 插件` 与 `生成 HDM 审视报告` 是不同事件（slug 不同）。
- **数据形态**：`<home>/Events/<事件名>.txt` 是权威，`index/events.json` 可丢可重建。
- **行数上限**：单份超过 `events.maxLines`（默认 400）时由模块自己开第二份 `维护插件1.txt`；调用方不得自带序号，`维护插件` 与 `维护插件1` 视为不同事件。

配套新工具 **`reconception`**（只读）：`kind=event/character/keyword` + `term` + `mode=index/read`。与 `hdm_recall` 分工——recall 检索记忆单元，reconception 调取已写下的成文档案（`Events/`、`characters/`、`Imagery/`）；未命中返回空列表而不是报错。

## 档案定期压缩（0.4.0）

IAM 与人物档案每 `profileCompact.hours`（默认 6 小时）用维护模型写短一点，最短间隔 `profileCompact.minIntervalMinutes`（默认 60）防止反复调模型。

与 gist/forget 分开的原因：那两个管记忆快照，IAM 与人物是「长期身份与关系」，压缩原则完全不同（同义替换、同方面合并、**保留全部节**）。

- **只压缩、不改事实**：标题与节结构、日期前缀、证据/置信度标注必须保留。
- **校验不过就整轮放弃**：缺节、串味、变长都不写盘。
- 写盘前 `snapshotIfChanged` 先备份，与其它写入路径一致。

## 压缩前记忆（0.2.4）

`/compact` 动手前先记一笔，压完再交回来：

1. `compaction/start` 时同步拍下压缩前对话（跳过 HDM 自己的注入，取尾部 `compaction.maxChars`），后台用维护模型总结成一条记忆并落盘（`pin:true`，沿用本会话编码）。
2. `compaction/end` 按 `compaction.waitMs` 等它完成；成功就登记「下一步重注入 + 把这条记忆交回去」，超时/失败只记 `lastCompactError`，**绝不阻塞压缩**。
3. 下一步的 pre-step 注入 `===== 压缩前记忆 =====`（uid + 摘要 + 路径）、按开关重注 IAM/handoff，然后清空标记。
4. 开关：`compaction.memorize`（设置页「压缩前记忆」）、`iam.fullReinjectAfterCompaction`、`handoff.reinjectAfterCompaction`。子代理的压缩不存记忆（它的日志会汇入父会话）。

### 看得见的两行字（0.2.7）

后台钩子写记忆时不产生工具调用，界面上原本**一点痕迹都没有**，容易被当成“压缩前没记”。现在注入块第一行写明结果：

| 情况 | 注入块首行 |
|---|---|
| 真的写了 | `【本轮压缩前已保存】写入 并入同一记忆（第 5 次合并）（2026/11/18 16:38:25，耗时 10.7s）` |
| 刚写过、跳过 | `【本轮未重复写入】3 分钟前刚存过这段工作，直接沿用那条记忆，没有再次总结。` |

去重窗口由 `compaction.dedupeMinutes` 控制（默认 5 分钟，`0` 关闭）。判据是本会话固定单元的 `updatedAt` —— 派生 L1/L0 不刷新它，所以不会被遗忘巡检误判成“刚写过”。

## IAM 锚点、人物摘录与加权 hitCount（0.2.8）

- **自我锚点取「首句 + 末句」且不漏节**：以前每节只取前两句，后追加到节尾的新事实永远进不了锚点。现在按三遍择优填充——① 富信息遍（每节首句+末句，最完整）；② 公平遍（每节只取末句，节尾优先，放不下的截尾补上）；③ 均分遍（预算按节平分，标题必现）。取覆盖节数最多的一遍，实机 400 字预算下 8 节全部出现。
- **人物档案随召回同步**：命中行 `meta.people` 与查询词（含别名）匹配时，`hdm_recall` 结果与自动召回注入里都带 `characters: [{ name, path, excerpt }]`（每人 ≤`characters.snippetChars`，每行 ≤2 人）；首轮另注入 ≤200 字「用户档案」。由 `characters.injectOnRecall` 控制。命中人物时注入块另行提醒「先读人物档案再判断」——摘录只是入口，不代替全文；档案只有模板标题（摘录为空）时也给路径。另：人物名本身不是关键词，改成「人物名也算检索词」——显式 `hdm_recall` 把 people 字面命中的记忆并入候选（不参与权重），自动召回把人物名当检索词，但「用户 / USER」这类出现在过半记忆里的泛称不进，免得注入块被刷满。
- **hitCount 按 keyness 加权**：自动召回与手动 `hdm_recall` 的增量 = `Σ(本次命中词 keyness) × 0.2`（示例：命中 keyness 8.5 与 6.0 两个词 → +2.9），保留两位小数、上限 10；`hdm_read` 读全文仍固定 +1。`registry.bumpHits` 支持 `[{uid, delta}]` / `Map` 入参，`hdm_organize` 不再把小数截断。
- **`/hdm-remember` 同轮更新 IAM 与人物**：投递的指令要求保存后立即自查长期状态——身份/关系/自我认知变化写 `hdm_iam_update`，人物偏好/承诺写 `hdm_character_update`；都没有时可跳过并一句话说明。

## 版本快照（0.2.3，母文件夹之外）

母文件夹里的 `Backup/*.bak` 只保护索引文件，**整目录被删时一起消失**（2026-11-08 真实发生过）。
0.2.3 起改用外部版本快照：

| 项 | 行为 |
|---|---|
| 快照根 | 默认 `<主目录>/.dsh-hdm-backups/<母文件夹slug>/`；可用 `backup.dir` 改。配置落在母文件夹内部会被拒绝并回退（否则重蹈覆辙） |
| 一版内容 | `IAM.md`、`IAM_Blank.md`、`characters/`、`memory/`、`diary/` 的完整镜像 + `manifest.json`（逐文件 sha256、字节数、内容 digest、计数） |
| 何时拍 | `hdm_save` / `hdm_character_update` / `hdm_iam_update` 之后；15 分钟心跳（覆盖日记与第 2/5 天派生）；**母文件夹迁移之前**；`hdm_backup action=snapshot` |
| 去重 | 内容 digest 与最新一版相同则跳过，不产出空版本 |
| 保留 | 最近 `backup.keep` 版（默认 20），最新的永不删 |
| 恢复 | `hdm_backup action=restore`（必须 `confirm:true`，可带 `version`）：先校验哈希 → 给当前状态拍 `pre-restore` 回滚点 → 替换数据项 → 复核 digest；校验失败或拷回失败都不把母文件夹留在半截状态 |
| 不动的 | `index/`（由 `meta.json` 重建）、`state/`（会话本地状态） |

保存时关键词的 keyness 是加法式：`3 + 顺序分 + 摘要命中 + 人物 + 细节频率 + IDF + 专有名词 + 场景/事件`，再按档位取前 N 个，而不是简单截断。各项取值见 `lib/memory.js` 的 `computeKeyness`：
`3`（基础分）+ 顺序分（0~2）+ 摘要命中 1.5 + 人物 1 + min(2, 0.5 × 出现次数) + 0.6 × ln((N+1)/(df+1)) + 专名 0.6 + 场景/事件各 0.4，最后夹到 0.1~10。
顺序分为模型排序的线性插值：第一位 2 分、最后一位 0 分；N=1 时固定 2 分。

## 命令

| 命令 | 用途 |
|---|---|
| `/hdm` | 状态：母文件夹、记忆数、固定单元、空闲整理与维护模型、本会话使用次数 |
| `/hdm-diary [date]` | 强制生成/重生成日记 |
| `/hdm-forget [uid\|all]` | 强制执行遗忘巡检（唯一手动推进 L1/L0 的入口） |
| `/hdm-remember` | 把本会话固定到一个记忆编码，并在**这一轮**让模型调用 `hdm_save` 写入（之后都续写同一编码） |
| `/hdm-idle [force]` | 立即扫描一次空闲整理；`force` 忽略空闲时长门槛（验收用） |

> 0.2.2 起用户侧只保留上面 5 个命令。检索、整理/重建索引、永久豁免、IAM 空白模板分别由
> `hdm_recall` / `hdm_organize` 工具、`hdm_save` 的 `immortal:true`、设置页「IAM 空白模板」按钮提供。

## 会话编码与空闲自动整理（0.2.0）

**会话编码（pin）**：`/hdm-remember` 与自动整理成功后会把这个会话固定到某条记忆的 uid。
之后本会话的 `hdm_save` 都并入该单元（返回 `merged: true`），不会另起一条。
如果该单元已经派生过 L1/L0，会先「重开 L2」（删掉可再生的派生档、把文件夹前缀改回 `2_`、
记录 `reopenCount`），保证同一编码下的内容始终最新。`/hdm` 状态里的「固定单元」就是它。

**为什么 `/hdm-remember` 会当轮保存**：宿主的命令（`/xxx`）只返回 `success`/`error`，
命令与结果都不进入模型消息、也不产生模型回合；HDM 的 `pre-step` 注入又只认真实用户消息。
所以命令登记后由 handler 通过 `agent.followup()` 把「强制记忆」指令作为一条 `plugin:hdm`
消息投进当前对话并唤醒 driver —— 模型因此在**这一轮**就调用 `hdm_save`。
投递不出去（老宿主 / 无 agent）时保持登记，由下一次 `pre-step` 注入兜底。

**空闲自动整理**：后台每 `idle.checkMinutes` 分钟扫一次，只处理满足全部条件的会话：

1. 最后一次真实用户发言距今落在 `[idle.idleMinutes, idle.maxIdleMinutes)` 分钟；
2. 自 `lastOrganizedAt` 之后**有新的真实用户发言**（插件注入的消息、子智能体会话不算）；
3. 距上次整理超过 `idle.minIntervalMinutes`；4) 今日次数未超过 `idle.maxRunsPerDay`。

满足就取「增量文本 + 已固定单元的摘要（≤300 字）」做**一次**无状态模型调用，要求严格 JSON：
要么 `{"skip":true,"reason":"…"}`，要么给出 summary/keywords(10–12)/details/quotes。成功即写入记忆并 pin。
失败**不重试**：水位线推进到已消费的发言之后，错误写进 `state/sessions.json` 的 `lastOrganizeError` 与日志。

**维护范围**：一次整理只碰目标记忆单元自己的文件（`memory/<date>/<label>/level2.txt`），
不碰 IAM、人物档案和其它记忆；因此上下文与误改面都被限制住。

**怎么调**：设置 → HDM 记忆页的「空闲自动整理」卡片改三档（下限分钟、上限小时、扫描间隔），
「维护模型」卡片填 provider/model（留空 = 跟随默认模型），「记忆维护预算」卡片改 token 预算与日记字数上限；
更多旋钮（`minIntervalMinutes`、`maxRunsPerDay`、`minUserMessages`、`maxInputChars`、`maintenance.timeoutSeconds`）
在 设置 → 插件 → dsh-hdm 的内置表单里。

**成本与审计**：输出预算默认 `maintenance.maxTokens=100000`（四个维护入口共用；宿主
`clampMaxTokensToContext` 按模型上下文窗口向下钳制，只压不报错），超时 `timeoutSeconds=600`；
输入被 `idle.maxInputChars` / `diary.inputMaxChars` 截断；每次运行写一行
`state/logs/maintenance.jsonl`（时间、会话短 id、目标 uid、ok/skip/fail、输入输出字数、模型）。
预算给小了会先被 `finish: max-tokens` 截断（尤其推理模型会把预算花在思考上），日志的 `reason` 会写明。

## 技能

插件注册 `hdm-memory` 技能（运行时注入、模型可调用、用户不可直接调用）。命中「回忆/记住/整理记忆」类任务时加载，包含速查表、快照生命周期、写作准则、调取策略、示例。

## 提示词热更新（改完不用重启）

**改提示词不用重启**：`prompts/zh/*.md` 与 `tools.md` 的缓存按文件 mtime 失效，改完下一次读取即生效。
`system-guide.md`（每次请求注入）与 `skill.md`（技能正文）遵循同一规则；`lib/prompts.js` 的 `loadPrompt()` 本来就每次读盘。
缓存内容与读取时的 `mtimeMs` 一起保存，每次调用先 `statSync` 比对；文件缺失时不缓存负结果，补回文件后立即恢复。
注意：这是运行时热更新，所以线上注入的正文永远等于磁盘上的最新版本 —— 如果发现 DSH 注入的仍是旧文案，先确认 `prompts/zh/*.md` 的 mtime 是否真的变了（某些编辑器延迟落盘）。

## 写入边界：谁写记忆，谁写人物档案

分工是**刻意这样设计**的（用户 2026-11-08 拍板，方案 B）：

| 写入者 | 写什么 | 不写什么 |
|---|---|---|
| 对话智能体（我） | `hdm_save` / `hdm_character_update` / `hdm_iam_update`：记忆、`characters/*.md`、`IAM.md`、`/hdm-remember` 的内容 | — |
| 维护模型（后台） | L2→L1→L0 降级、日记、遗忘巡检、空闲整理产出的记忆单元 | **`characters/*.md`** |

维护模型从对话里解析出的 `people` 只落到该记忆单元的 `meta.people`（检索用），**不会**变成
`characters/USER.md` 的条目。人物档案是对话智能体的责任，只有它在对话中显式调用工具才会更新。
这样做的原因是：人物条目带证据 uid 与置信度，需要判断语境，交由拥有完整对话的一方写比后台批量追加更可靠。

## 设置页与迁移

HDM 提供两处设置入口：

1. **设置 → HDM 记忆**（独立页面，Client 半 `lib/client.js`，按官方 UI 插件模板的
   ModuleLoader 格式注册到 `settings.section`）：
   - 母文件夹 `homeDir`（文本框，含自动迁移说明）
   - 总开关、日记、遗忘、自动召回：**开关（role=switch，可点）**
   - 保存触发阈值：**滑块 0.01–0.95**，右侧实时显示百分比
   - 保存 / 重新读取 / 恢复默认；数据优先走宿主 `configForms`（与内置设置页同一条
     describe/mutate 通道，嵌套项用 `mutate` 的路径操作），拿不到时退回 `remote.settings`
   - 页面底部显示当前数据通道与配置项 namespace；配置尚未读到时控件短暂禁用并提示「正在读取宿主配置…」
2. **设置 → 插件 → dsh-hdm**（内置自动表单）：全部高级配置项。

- 修改 `homeDir` 后插件会以新配置重新加载；插件在主目录维护指针文件 `~/.dsh-hdm.home.json`，发现位置变化时**自动迁移**旧母文件夹（同盘 rename、跨盘复制、目标非空合并不覆盖）。
- 客户端页面依赖最新的客户端模块加载格式；更新后需刷新一次 Web 页面。
- 若插件更新（尤其是 Client 半）导致 Web 无法启动，运行一次性修复脚本恢复启动安全配置：
  ```powershell
  pwsh -File "<仓库路径>/tools/repair-hdm.ps1"
  ```
  然后重启 DSH。`known-good-cordis.patch.yml` 与 `safe-cordis.patch.yml` 在 `tools/` 下。
- 注意：包依赖 `@deepseek-ai/schemastery`；若把本包拷到别处使用，需先执行 `pnpm install`。

## 测试

```bash
# Node 由 DSH 提供
NODE="<DSH 自带的 node 可执行文件>"
"$NODE" --test test/
```

- `test/core.test.mjs` 存储、命名、索引、状态
- `test/recall.test.mjs` 评分、view 回退、联想
- `test/identity.test.mjs` IAM、人物、USER 优先
- `test/maintenance.test.mjs` 日记、顺序快照、豁免、回退
- `test/prompts.test.mjs` 提示词完整性
- `test/integration.test.mjs` fake ctx 端到端
- `test/organize.test.mjs` 主动整理：修复、dryRun、临时文件、报告
- `test/client-page.test.mjs` 设置页组件

## 隐私

只存摘要、有限细节和少量原话，不存密钥、证件号等敏感信息。日记与遗忘压缩会把当日记忆摘要发送给配置的维护模型；不需要时设 `diary.enabled=false` / `forget.exemptMode=skip`，或全程用确定性回退（`maintenance.provider` 留空且模型不可用时自动回退）。

## 故障排查

| 现象 | 处理 |
|---|---|
| 母文件夹不可写 | 检查 `homeDir` 权限；插件会记录错误并在工具返回明确提示，不会崩溃 |
| 索引损坏 | 自动用 `Backup/` 下的 `.bak`，再不行扫描 `meta.json` 重建；也可调 `hdm_organize`（会重建索引） |
| 多实例并发 | 进程内互斥 + `state/.lock` 文件锁，best-effort |
| 日记/遗忘没跑 | 检查 `enabled` 开关与定时器；可用命令强制触发 |
| 上下文压力读不到 | 回退到 token 估算；仍失败则本轮不提醒 |

## 许可

内部使用。
