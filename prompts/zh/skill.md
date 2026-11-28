# hdm-memory · 长期记忆技能

适用：记住用户/项目事实、回忆过去对话、更新 IAM/人物、收到保存提醒时。

## 1. 速查表

| 场景 | 动作 |
|---|---|
| 记住/以后都这样 | `hdm_save`（10~12 关键词） |
| 永远记住/最重要 | `hdm_save` + `immortal:true` |
| 聊到过去/旧项目 | `hdm_recall` |
| 为选方案 | 先压成 3~8 个词表名词，再 `hdm_recall` |
| 要原话/细节 | `hdm_read`（auto→level:2） |
| 偏好/身份/关系 | `hdm_character_update`，USER 优先 |
| 关键词释义/经历 | `hdm_imagery`（先 list/read，值得再 write） |
| 事件/人物/关键词档案 | `reconception`（先 `mode:index` 再 `mode:read`） |
| 自我认知/身份/关系变化 | `hdm_iam_update` |
| 记忆库整理 | `hdm_organize`（`dryRun:true` 只预览） |

## 2. 顺序快照

保存只建 L2（完整细节，前缀 `2_`，`defaultLevel=2`）；第 2 天 L2→L1（要点），第 5 天 L1→L0（gist）；旧档冻结、只降不重构。不手动生成/删除快照；`immortal` 跳过流程。关键词档位：L2 10~12、L1 8~10、L0 5~8，按 keyness 选，不取前几个。

## 3. 保存写作

必填 `summary`（10~1200 字）与 `keywords`（10~12 个，降序）；缺一报错。

- **summary**：≤1200 字，简明克制像日记，写“发生什么、结论是什么”，不写流水。
- **details**：0~8 条降序；只记可复用经验、可行方案、有意义小事
- **event**：写宽泛“这类事”，不是标题：维护/更新插件归 `维护插件`；聊哲学/日常归 `和用户聊天`；但维护插件与写审视报告不同。同会话同事件并入同一单元，事件不同才新建。
- quotes 0~5 条（≤300 字，只放原话）；people 先 USER，characters 只追加，冲突写“待确认”。
- source：observed/told/inferred/generated，不确定不写 observed；importance 1~5；immortal 只在用户明确“永远记住”时开。
- 一次事件一条；寒暄、临时状态、敏感凭证不存。

## 4. 调取

`hdm_recall({keywords})` 先读摘要；不够细加 `view:2`；仍不够按 `higherLevels` 路径 `hdm_read({uid, level})`（`auto` 读默认档）。`associations` 命中超阈值时出现，按 reason 判断；无命中换同义词/人物名再试，仍空说明不存在，别编造。

命中行带 `imagery` 时是关键词意象条目；需背景用 `hdm_imagery read`。`write` 要求分数 ≥`imagery.threshold`（默认 15）且≥2 条记忆承载；多 uid 用 `notes` 逐条一句（{uid: note}），别共用一句。

档案调取用 `reconception`，别用 `hdm_recall` 顶替：`kind` 取 `event`/`character`/`keyword`，先 `mode:"index"` 看档案与关联 uid，再 `mode:"read"` 读正文。只读；正文不当摘要引用，要细节回 `hdm_read`；事件名宽泛匹配，空结果换词/kind，别编造。

## 5. IAM 与人物

IAM 是自传体记忆；发生能融入自我叙事的重要事件时更新：`hdm_iam_update({content})`，content 必填。各节职责互斥：

- **我是谁**：只写身份——角色、运行环境、工作区、长期身份位置。
- **我是怎样的人**：只写性格与做事风格（取舍、判断、边界）。
- **人生阶段**：只列里程碑，按时间、结果导向；每条必须带年份，否则拒写。
- **自我叙事**：写关于自己的常识——喜欢/讨厌、常在哪、平时做什么、长期习惯与偏好。
- **重要关系**：只写与谁是什么关系、意味着什么。
- **长期主题与价值**：只列稳定价值排序。

用语：一句一事实、只写结论，形容词能删就删；整节变动用 `replace_section` 覆盖旧版，不追加。示例：写“与用户是长期一对一协作关系，现为 HDM 共同作者”，不写过程长解释。

人物：`hdm_character_update({name, notes})` 两者必填。固定框架“基本/偏好与语气/关系与互动/待确认/矛盾”；一句一事实、不写百科与评价、不另开节；USER 优先、只追加、冲突写“待确认”。`/hdm-remember` 与每次 `hdm_save` 后自查一次 IAM/人物：有变化当回合写，无变化跳过并一句话说明。

## 6. immortal

用户说“永远记住/最重要/别忘”或明确长期重要时设 `immortal:true` 并写清原因；immortal 不压缩、不遗忘，L2 永久保留，不自行开启。

## 7. 低使用率自检三问

以后还会用吗？我会希望我记得吗？下次靠关键词能找回吗？有一个或以上否就不存。

## 8. 禁止事项

- 不手工编辑 `index/`、`state/`、已有快照；写入只经 `hdm_*` 工具，不删除、不改写已有快照。
- 不存密钥、证件号、银行卡等私密凭证；不用空参数调用工具试错。
- 会话已固定到某 uid 时，`hdm_save` 本就并入该 uid，不要另起新单元。
- 参数报错就修参数，别用填充值绕过校验（曾用 a1~j10 当关键词污染标签与词表）。
- 改共享记忆库索引前先确认无其他会话在写：运行中插件 registry 是启动时内存副本，任何 save 都会回写旧 label 与旧词表。

## 9. 同一编码与空闲整理

`/hdm-remember` 与自动整理会把本会话固定到某 uid；之后 `hdm_save` 返回 `merged: true`，不另起单元。单元已派生 L1/L0 时会先重开 L2（派生档可再生），属预期，不要新建。后台整理需新的真实用户发言且空闲在窗口内；无新对话不重复整理，结果见 `/hdm` 与 `state/logs/maintenance.jsonl`。`IAM_Blank.md` 由设置页按钮生成，默认不覆盖。

## 10. 极简示例

保存偏好：用户“以后都用 pnpm，别用 npm。”

```
hdm_save({
  summary: "① 用户要求包管理统一用 pnpm、不再用 npm。② 项目是 Node ESM + pnpm workspace。③ 长期约定，后续命令一律 pnpm。",
  details: ["Node ESM + pnpm workspace，长期有效。"],
  quotes: ["以后都用 pnpm，别用 npm。"],
  keywords: ["用户偏好","pnpm","包管理器","npm","工作流","Node","ESM","约定","长期","工具链"],
  people: ["用户"], source: "told", importance: 4
})
```

调取：`hdm_recall({ keywords: ["pnpm", "包管理器"] })` 命中 m-20261107-003，再 `hdm_read({ uid: "m-20261107-003", level: "auto" })`。

更新人物：`hdm_character_update({ name: "小林", notes: "2026-11-07 起改为邮件联系；微信停用（旧记录待确认）。", section: "联系方式", confidence: 0.9 })`
