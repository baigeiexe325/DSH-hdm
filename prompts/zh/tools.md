# HDM 工具文案（键值行；首个 ASCII 冒号+空格分隔；行首两空格为续行；# 起头为注释）

## hdm_save

hdm_save.description: 保存一条跨会话记忆。铁律：summary 与 keywords 必填，缺任一项直接返回参数错误，不建文件夹、不写索引。
  一次事件一条；值得跨会话记住的事实、偏好、决定、关系变化才存，寒暄和临时状态不存。
  关键词按重要性从高到低给 10~12 个，keyness 由系统计算，不要自己编分数。
  本会话已有快照时再次保存会新建记忆单元并用 relatedUids 关联，不覆盖旧快照。
hdm_save.param.summary: 必填，10~1200 字。自足摘要：谁、做了什么、结论或决定、为什么；将来只看它也能懂。
hdm_save.param.details: 可选，0~8 条，每条 ≤500 字，按重要性降序；一条一个事实。
hdm_save.param.quotes: 可选，0~5 条，每条 ≤300 字，只放用户原话关键句，不改写。
hdm_save.param.keywords: 必填，10~12 个，按重要性从高到低；用名词或专有词。缺失或数量越界会报错。
hdm_save.param.people: 可选，0~10 人；用户写“用户”，其他人用人物档案名。
hdm_save.param.scene: 可选，场景（地点/项目/语境），一句话。
hdm_save.param.event: 可选，事件短名，用于同日关联。
hdm_save.param.emotion: 可选，用户或对话的情绪基调。
hdm_save.param.source: 可选，observed（亲见，默认）/ told（用户告知）/ inferred（推断）/ generated（生成）。
hdm_save.param.importance: 可选，1~5，默认 3；长期重要才设 ≥4。
hdm_save.param.immortal: 可选，布尔，默认 false；用户说“永远记住/最重要”时设 true，L2 永久保留。
hdm_save.param.characters: 可选，[{name, notes?, section?, confidence?}]；USER 优先，只追加，冲突写“待确认”。
hdm_save.param.relatedUids: 可选，关联的旧记忆 uid 数组。
hdm_save.out.ok: 是否成功；false 时看 error。
hdm_save.out.uid: 新记忆稳定 ID，形如 m-YYYYMMDD-NNN。
hdm_save.out.label: 记忆文件夹名，含档位前缀。
hdm_save.out.folder: 记忆文件夹绝对路径。
hdm_save.out.path: level2.txt 绝对路径。
hdm_save.out.defaultLevel: 当前默认档，新建记忆为 2。
hdm_save.out.keywordScores: 每个关键词的 keyness 与所在档位。
hdm_save.out.relatedUids: 本单元关联的记忆 uid。
hdm_save.out.next: 后续动作提示（更新 IAM/人物、下次提醒阈值等）。

## hdm_recall

hdm_recall.description: 按关键词调取记忆。铁律：keywords 必填且 1~12 个，缺失或为空直接报错，不做全量返回。
  默认返回当前默认档；需要细节用 view:2，结果里的 higherLevels 指向更完整档位，再用 hdm_read 读。
  权重 = 命中关键词数 + 档位等级 × recall.levelBias（默认 1）+ boost 加成。
  每次命中 hitCount 增加（按本次命中词 keyness 之和 × 0.2 加权，不是固定 +1）；命中数超过 association.triggerCount（默认 4）时附带联想记忆。
  命中行若与人物名匹配，会附带 characters 摘录（USER 优先），可直接引用，不必再读档案文件。
  要用它为某个目标选方案（例如抓网页正文：用命令还是用用户浏览器）时，先把问题压成 3~8 个词表里的名词再检索，别整句搜索。
  检索顺序（0.3.0）：先拿 keyness × 时间衰减排成的词表，在前 50 个词上模糊匹配；凑不够期望条数就进 50~100 并降低期望，一直循环到第 250 个词；还没找到就回退精确倒排细找。返回条数默认等于 keywords 个数（上限 12）。
hdm_recall.param.keywords: 必填，1~12 个；用人物、项目、事件、专有名词，先给最关键的。
hdm_recall.param.topK: 可选，1~12；省略时等于 keywords 个数（上限 12）。
hdm_recall.param.view: 可选，auto（默认，用 defaultLevel）/ 0 / 1 / 2；请求档不存在时回退最近可用档。
hdm_recall.param.sameDayOf: 可选，某条记忆 uid；返回同一天的记忆，两边都写了 eventKey 时还要求 eventKey 相同。
hdm_recall.param.boost: 可选，none（默认）/ usage / recency / pinned。
hdm_recall.param.includeAssociations: 可选，布尔，默认 true；false 时不返回联想。
hdm_recall.out.matches: 命中列表，含 uid、label、defaultLevel、level、path、higherLevels、weight、matchedKeywords、hitCount、characters、imagery、immortal、views。imagery 是命中关键词里已建意象的条目（term/file/score），正文用 hdm_imagery read 自取。
hdm_recall.out.associations: 联想列表，含 uid、label、level、path、gist、reason、chars。
hdm_recall.out.associationTruncated: 联想是否因字数预算被截断。
hdm_recall.out.viewFallback: 请求档不存在而回退时为 true。
hdm_recall.out.search: 检索诊断，含 stage（coarse=词表模糊命中 / fine=精确倒排 / empty=都没找到）、expected、aim、windows、terms、fuzzyTerms。

## hdm_imagery

hdm_imagery.description: 意象层——以关键词为线索的经历记忆，与按时间的 memory/ 互补。铁律：write 的 term 必填；分数未达 imagery.threshold（默认 15）或承载记忆少于 imagery.minMemories（默认 2）直接报错，不写半成品。只追加不覆盖，词义与经历分开记；保存权重与人物档案同级。
hdm_imagery.param.action: 可选，list（默认，列出已建意象）/ read / write。
hdm_imagery.param.term: read/write 必填，关键词原词。
hdm_imagery.param.meaning: write 可选，≤300 字；写“这个词对你意味着什么”，克制叙述，不写教程或百科。
hdm_imagery.param.uids: write 可选，最多 5 个记忆 uid，写进「经历」与「记忆索引」。
hdm_imagery.param.note: write 可选，本次经历的一句话笔记；只有 1 个 uid 时用这句。
hdm_imagery.param.notes: write 可选，按 uid 给各自一句话（{uid: note}）。多个 uid 时优先用它；缺省则自动填该记忆的事件名与日期——不要给多条写同一句，否则「经历」会变成复读。
hdm_imagery.out.items: list 时的条目数组（term/score/memories/file）。
hdm_imagery.out.text: read 时的条目正文（受 imagery.maxReadChars 截断）。

## hdm_read

hdm_read.description: 读取指定记忆的某个快照。铁律：uid 必填，缺失直接报错；只读，不改文件。
  请求档不存在时回退到最近可用档。
hdm_read.param.uid: 必填，记忆稳定 ID（m-YYYYMMDD-NNN）或文件夹名。
hdm_read.param.level: 可选，auto（默认，读 defaultLevel）/ 0 / 1 / 2。
hdm_read.param.offset: 可选，按字符偏移，默认 0，用于长文分页。
hdm_read.param.limit: 可选，最多返回字符数，默认 6000，允许 200~12000。
hdm_read.out.uid: 记忆稳定 ID。
hdm_read.out.level: 实际读取的快照档位。
hdm_read.out.path: 实际读取的文件绝对路径。
hdm_read.out.text: 快照正文（受 offset/limit 限制）。
hdm_read.out.truncated: 是否因 limit 截断。

## hdm_character_update

hdm_character_update.description: 追加或更新人物档案。铁律：name 与 notes 必填，缺失直接报错；只追加不覆盖，冲突写“待确认”；USER 永远第一优先。
  单文件超过 characters.maxChars 时拒绝写入并提示压缩，不会截断原文。
hdm_character_update.param.name: 必填，人物名；用户本人写 USER。
hdm_character_update.param.notes: 必填，本次要追加的事实，带日期与证据更佳。
hdm_character_update.param.section: 可选，章节名（如“偏好”“关系”“联系方式”），默认“记录”。
hdm_character_update.param.aliases: 可选，别名数组，用于合并同一人物。
hdm_character_update.param.confidence: 可选，0~1 置信度，默认 0.5。
hdm_character_update.param.evidenceUid: 可选，证据记忆 uid。
hdm_character_update.param.mode: 可选，append（默认，追加）/ replace_section（替换该章节内容，保留标题）。
hdm_character_update.out.ok: 是否成功。
hdm_character_update.out.path: 人物档案文件路径。
hdm_character_update.out.section: 实际写入的章节。
hdm_character_update.out.priority: 写入优先级，USER 最高。
hdm_character_update.out.pending: 是否写入“待确认”冲突段。

## hdm_iam_update

hdm_iam_update.description: 更新自传体记忆 IAM。铁律：content 必填，缺失直接报错；保留固定标题，超 iam.maxChars 拒绝并提示压缩。
  只在自我定位、长期目标、重要关系变化时更新；冲突写“待确认”，不要静默覆盖。
  各节职责互斥：我是谁=只有身份；我是怎样的人=只有性格与做事风格；人生阶段=里程碑罗列；当前目标=当前要达成的大目标；自我叙事=关于自己的常识（喜欢/讨厌什么、常在哪、平时做什么）；重要关系=与谁什么关系；长期主题与价值=价值排序。
  写法：一句一事实、只写结论，不写过程与运行细节（报错、命令、路径清单、测试数字不进 IAM），能删的形容词都删；单节 ≤5 点、整文 ≤2000 字。
  模式：整节改写用 replace_section（覆盖旧版本）；append 只在确实新增一条独立事实时用，且不要往「当前目标」追加——会让新旧目标并存、变成长篇大论。
hdm_iam_update.param.content: 必填，要写入的正文。
hdm_iam_update.param.mode: 可选，replace_section（整节改写，推荐）/ append（默认，仅新增独立事实）/ rewrite（重写全文）。
hdm_iam_update.param.section: 可选，mode=replace_section 时必填；职责见 description，记忆索引自动维护勿手改。
hdm_iam_update.out.ok: 是否成功。
hdm_iam_update.out.chars: 更新后 IAM 的字符数。
hdm_iam_update.out.mode: 实际使用的更新模式。

## hdm_organize

hdm_organize.description: 主动整理记忆库：扫描 meta.json，修复快照/关键词/文件夹前缀漂移，清理原子写临时文件，重建索引，并报告日记与遗忘待办量。
  只修元数据，不删除记忆、不改写快照正文；固定标题与已有正文保持原样。
hdm_organize.param.dryRun: 可选，布尔，默认 false；true 只扫描并报告，不写入任何文件。
hdm_organize.out.memories: 扫描到的记忆单元数。
hdm_organize.out.repaired: 被修复的记忆及变更字段。
hdm_organize.out.warnings: 无法自动修复的问题（孤立文件夹、缺快照、关键词过少等）。
hdm_organize.out.indexCount: 重建后的索引条数；预览模式为 null。
hdm_organize.out.diaryPending: 待生成日记的日期。
hdm_organize.out.forgetDue: 待遗忘巡检的记忆条数。

