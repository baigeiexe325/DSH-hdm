# hdm-memory · 长期记忆技能

> 适用：记住用户/项目事实、回忆过去对话、更新 IAM/人物、收到保存提醒时。

## 1. 速查表

| 场景 | 动作 |
|---|---|
| 记住/以后都这样（或类似表达） | `hdm_save`（10~12 关键词） |
| 永远记住/最重要（或类似表达） | `hdm_save` + `immortal:true` |
| 聊到过去或旧项目 | `hdm_recall` |
| 为达成目标选方案 | 先压成 3~8 个词表名词，再 `hdm_recall` |
| 要原话/细节 | `hdm_read`（auto→level:2） |
| 偏好/身份/关系 | `hdm_character_update`，USER 优先 |
| 长期目标/自我变化 | `hdm_iam_update` |
| 记忆库需要整理 | `hdm_organize`（`dryRun:true` 只预览） |

## 2. 顺序快照

- 保存只创建 L2（完整细节），前缀 `2_`，`defaultLevel=2`。
- 第 2 天读 L2 生成 L1（要点），L2 冻结，前缀 `2_→1_`。
- 第 5 天读 L1 生成 L0（gist），前缀 `1_→0_`，L1/L2 冻结。
- 不手动生成/删除快照；`immortal` 跳过整个流程。
- 关键词档位：L2 10~12、L1 8~10、L0 5~8；按 keyness 选，不是取前几个。

## 3. 保存写作

必填 `summary`（10~1200 字）与 `keywords`（10~12 个，降序）；缺一个就报错。

**summary 分点写**：3~6 点、降序，行内「①②③」编号、不换行；每点一句话只讲一个事件或结论，脱离上下文也能懂；首点「谁 + 做了什么」，末点结论/决定或遗留。

**details 分点写**：0~8 条、降序，每条一句话只讲一个可核对的事实（数字、路径、参数、报错、工具返回），不写背景、不重复 summary。

- quotes 0~5 条（≤300 字，只放原话）。
- people 先 USER；characters 只追加，冲突写“待确认”。
- source：observed/told/inferred/generated；不确定不写 observed。
- importance 1~5；immortal 只在用户明确“永远记住”时开。
- 一次事件一条；寒暄、临时状态、敏感凭证不存。

## 4. 调取

1. 默认档：`hdm_recall({keywords})`，先读摘要。
2. 不够细：加 `view:2`。
3. 仍不够：用 `higherLevels` 里的路径 `hdm_read({uid, level})`；`level:"auto"` 读默认档。
4. 联想：`associations` 命中数超阈值才出现，按 reason 判断相关性。
5. 无命中：换同义词/人物名再试；仍空说明记忆不存在，别编造。

## 5. IAM 与人物

- IAM：自我定位、长期目标、重要关系变化时更新；`hdm_iam_update({content})`，content 必填。
- IAM 各节沿用 §3 的记忆写法：3~6 点降序、行内「①②③」、一句一事实、可核对、不堆形容词。
- `当前目标`：写进行中的事 → 已完成结论 → 未做/阻塞，**末点写下一步**；整节变更用 `replace_section`，不追加新标题。
- `我是怎样的人`：写行为与判断倾向（怎么做事、怎么取舍、边界），与 `我是谁`（身份/处境/关系位置）分工。
- 人物：姓名、偏好、承诺、关系变化时更新；`hdm_character_update({name, notes})` 两者必填。
- USER 第一优先，其余按重要度；只追加不覆盖，冲突写“待确认”。

## 6. immortal

用户说“永远记住/最重要/别忘（或类似表达）”或明确长期重要时设 `immortal:true` 并写清原因；immortal 不压缩、不遗忘，L2 永久保留。不要自行开启。

## 7. 低使用率自检三问

- 这条以后还会用吗？
- 用户会希望我记得吗？
- 下次靠关键词能找回来吗？

有两个或以上否就不存。

## 8. 禁止事项

- 不手工编辑 `index/`、`state/`、已有快照；只读这些，写入只经 `hdm_*` 工具。
- 不删除、不改写已有快照。
- 不存密钥、证件号、银行卡等凭证。
- 不用空参数调用工具试错。
- 会话已被固定到某个 uid 时，不要试图用 `hdm_save` 另起新单元：它本来就并入该 uid。

## 9. 同一编码与空闲整理

- `/hdm-remember` 与自动整理会把本会话固定到某个 uid；之后 `hdm_save` 返回 `merged: true`，不另起单元。
- 单元已派生 L1/L0 时会先重开 L2（派生档可再生），属预期，不要新建单元。
- 后台整理需要新的真实用户发言且空闲在窗口内；没有新对话不重复整理，结果见 `/hdm` 与 `state/logs/maintenance.jsonl`。
- `IAM_Blank.md` 由设置页按钮生成，默认不覆盖（没有同名命令）。

## 10. 示例

### 示例 1：保存偏好

用户：“以后都用 pnpm，别用 npm。”

```
hdm_save({
  summary: "① 用户要求包管理统一用 pnpm、不再用 npm。② 项目是 Node ESM + pnpm workspace。③ 长期约定，后续命令一律 pnpm。",
  details: ["Node ESM + pnpm workspace，长期有效。"],
  quotes: ["以后都用 pnpm，别用 npm。"],
  keywords: ["用户偏好","pnpm","包管理器","npm","工作流","Node","ESM","约定","长期","工具链"],
  people: ["用户"], source: "told", importance: 4
})
```

### 示例 2：调取并读细节

```
hdm_recall({ keywords: ["pnpm", "包管理器"] })
→ 命中 m-20261107-003，defaultLevel 2
→ hdm_read({ uid: "m-20261107-003", level: "auto" })
```

### 示例 3：更新人物并处理冲突

```
hdm_character_update({
  name: "小林",
  notes: "2026-11-07 起改为邮件联系；微信停用（旧记录待确认）。",
  section: "联系方式", confidence: 0.9
})
```
