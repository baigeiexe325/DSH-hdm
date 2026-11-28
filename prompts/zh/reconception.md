# reconception · 档案调取

> 适用：想回看「这类事以前发生过吗」「这个人的偏好是什么」「这个词对我意味着什么」时。只读。

## 1. 速查表

| 场景 | 动作 |
|---|---|
| 这类事以前发生过吗 | `reconception({ kind: "event" })` |
| 手上没有确切事件名 | `reconception({ kind: "event", mode: "index" })` 看事件表 |
| 某个人的基本/偏好/关系 | `reconception({ kind: "character", term: "用户" })` |
| 某个词对我意味着什么 | `reconception({ kind: "keyword", term: "母文件夹" })` |
| 要记忆单元的原话与细节 | `hdm_recall` + `hdm_read`（不是这个工具） |

## 2. 三类档案

- `event` → `Events/<事件名>.txt`：一段跨天跨会话的经历，事件名是宽泛的一类事。
- `character` → `characters/<人物>.md`：USER 优先，只追加、冲突写「待确认」。
- `keyword` → `Imagery/<词>.md`：这个词的释义与相关经历。

## 3. 怎么用

1. 先 `mode: "index"`（默认）：看有哪些档案，以及每条的 `uids`（关联记忆）与 `file`。
2. 再 `mode: "read"`：读正文，`term` 用 index 里看到的 `title`。

- `kind: "event"` 且 `term` 为空时，index 直接列出事件表（最多 `reconception.maxIndexItems` 条）。
- `kind: "character"` / `kind: "keyword"` 必须给 `term`，缺了会报「需要 term」。
- 人物可用别名（`我` / `用户` / `你` → `USER`）；关键词 index 按包含匹配，先给宽词再收窄。

## 4. 宽泛事件名

事件名按「一类事」写，不是精确标题：

- `维护插件` 包含维护/更新 HDM、更新 LOT 等插件；`和用户聊天` 包含聊哲学、聊日常。
- `维护 HDM 插件` 与 `生成一份 HDM 的审视报告` 是两个不同事件；`维护插件` 与 `维护插件1` 也是。

所以 index 命中多条是正常现象：先看 `uids` 与 `file` 判断哪份是你要的，再 read。

## 5. 铁律

- 只读：reconception 不写任何文件。
- 档案正文不当摘要引用：要细节或原话，回到 `hdm_read`（`uid` 取 `uids` 里的值）。
- 命中为空就换词、换 kind 或改走记忆检索，**不要编造**档案内容。
- 与 `hdm_recall` 的分工：recall 检索「记忆单元」（摘要、快照档位、keyness），reconception 调取「档案」；先看档案看全貌，再用 recall/read 取细节。
