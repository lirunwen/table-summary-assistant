# 表格汇总助手 · 架构设计

> 面向 Windows 办公室内网的本地数据汇总工作台。无公网依赖，双击启动，浏览器作为界面，数据全部留在本机。

## 1. 目标与约束

| 约束 | 设计回应 |
| --- | --- |
| 同事各自在自己的 Windows 电脑使用，不要求同时在线 | 单机单实例架构，不做账号、并发与权限系统 |
| 办公室内网可能完全断网 | 前端零 CDN、零 web font、零构建产物拉取；后端依赖随程序分发 |
| 需要处理 Excel、CSV、Outlook 邮件/附件 | 服务端统一解析为“数据表”，前端只面对表、列、行 |
| 汇总到“指定的目标 Excel” | 支持上传模板，复制模板后填数据，保留版式、列宽、公式列 |
| 每一列单独指定来源 | 列级映射模型：来源表 + 字段 + 处理方式 + 缺省值 |
| 支持数据对比 | 按主键对两次结果/任意两表做行级与单元格级 diff，可导出报告 |
| 界面美观、卡片式、清晰 | 原生 CSS 设计系统，左栏工作台布局，语义化卡片与状态色 |
| 部署与更新方便 | 单目录分发；`data/` 与程序分离；升级只替换程序文件 |

## 2. 技术选型

| 层 | 选择 | 原因 |
| --- | --- | --- |
| 运行时 | Python 3.11+ | Windows 普及、Office 生态成熟、打包简单 |
| Web 框架 | Flask 3 | 轻量、纯 Python、路由与文件上传够用；不需要前后端分离部署 |
| WSGI 服务 | waitress | 纯 Python、Windows 稳定，避免开发服务器警告与 Linux 依赖 |
| Excel 读写 | openpyxl | 保留模板样式、列宽、合并单元格、公式；支持 `.xlsx/.xlsm` |
| 旧版 `.xls` 读取 | xlrd | 兼容 Office 97-2003 输入 |
| Outlook | extract-msg + 标准库 email | `.msg/.oft` 与 `.eml` 本地解析，提取正文表格和附件 |
| 元数据 | SQLite（标准库） | 零安装、单文件、事务可靠；方案/运行记录/设置 |
| 前端 | 原生 HTML + CSS + ES Modules | 无需 Node、无构建步骤、无框架 CDN；离线最稳，升级只改静态文件 |
| 打包 | PyInstaller（Windows） | 生成免安装目录，目标机无需 Python；也可用“嵌入 Python + wheelhouse”方案 |

刻意不使用：

- **Electron**：体积大、需要 Node 工具链，Office 文件解析能力反而弱。
- **pandas**：对本工具的数据规模（办公表格，通常几万行）收益有限，打包体积与启动成本明显增加。
- **CDN / Google Fonts / 图标库**：内网断网会直接破相；所有图标为本地 SVG sprite，字体使用系统字体栈。
- **前端框架 + 构建链**：页面数量可控，原生模块足够；避免“源码能跑、构建产物丢失”的部署风险。

## 3. 运行拓扑

```text
┌──────────────────────────── 本机（127.0.0.1） ────────────────────────────┐
│                                                                          │
│   Chrome / Edge  ──HTTP──▶  Flask + waitress（仅监听回环地址）             │
│        │                         │                                       │
│        │                         ├─ 数据接入：Excel / CSV / .msg / .eml   │
│        │                         ├─ 汇总引擎：join / append + 列映射       │
│        │                         ├─ 模板写入：openpyxl                    │
│        │                         ├─ 对比引擎：按主键 diff                  │
│        │                         └─ SQLite 元数据 + data/ 文件仓           │
│        │                                                                  │
│        └── 静态资源全部来自 /css /js /assets（本地文件）                   │
└──────────────────────────────────────────────────────────────────────────┘
```

启动时 `app.py` 先初始化目录与数据库，再寻找可用端口（默认 9090，可用 `--port` 或环境变量 `HUIYI_PORT` 覆盖），启动 waitress，并自动打开浏览器。服务只绑定 `127.0.0.1`，同一内网的其他电脑无法访问。

## 4. 模块划分

```text
huiyi/
├─ app.py                 启动器：日志、端口、waitress、打开浏览器
├─ backend/
│  ├─ config.py           路径、常量、支持格式、默认设置
│  ├─ db.py               SQLite schema 与查询封装
│  ├─ utils.py            ID、值规整、日期/数字解析、表头评分
│  ├─ readers.py          Excel / xls / CSV 读取、表头识别、表元数据
│  ├─ email_reader.py     .msg / .eml 解析、HTML 表格提取
│  ├─ ingest.py           落盘、类型分派、邮件附件递归登记、删除
│  ├─ templates.py        模板文件落盘、工作表/表头解析、从表头派生字段
│  ├─ tmplib.py           数据模板服务层：字段契约、校验规则、版本、引用关系
│  ├─ column_match.py     列名匹配：严格同名 → 括号备注名（唯一规则来源）
│  ├─ formula.py          Excel 风格公式：词法、语法、白名单函数、逐行求值
│  ├─ appcontrol.py       桌面快捷方式（PowerShell -EncodedCommand）与进程退出
│  ├─ engine.py           配置校验、join/append、映射、统计
│  ├─ writer.py           模板填充或新建工作簿、样式与公式保护
│  ├─ diff.py             主键对比、差异明细、Excel 报告
│  └─ api.py              Flask 路由、序列化、清理策略
├─ web/
│  ├─ index.html          应用壳层（侧栏、顶栏、挂载点）
│  ├─ css/app.css         设计系统与所有页面样式（无外部资源）
│  ├─ assets/icons.svg    本地 SVG 图标 sprite
│  └─ js/
│     ├─ app.js           哈希路由、壳层、错误兜底
│     ├─ api.js           fetch 封装与错误规范
│     ├─ store.js         全局数据、数据表选择器、配置规范化
│     ├─ ui.js            Toast / Modal / 格式化 / 表单片段
│     ├─ components.js    方案卡片、新建方案、运行详情、模板→目标列
│     └─ pages/           工作台、数据源、模板列表/编辑器、方案、编辑、对比、记录、设置
├─ samples/               可试用的示例 Excel / CSV / EML / XLS
├─ tests/                 端到端 API 冒烟测试、UI 截图工具
├─ packaging/             Windows 打包脚本、spec、图标、离线 wheels 脚本
├─ data/                  运行时生成（不入库）
└─ requirements*.txt
```

## 5. 数据模型

SQLite 只存“元数据 + 配置”，原始表格与结果文件留在磁盘。

```text
sources(id, name, kind, path, size, parent_id, created_at, meta JSON)
templates(id, name, path, size, created_at, updated_at, description, category,
          tags JSON, status, origin, version, meta JSON)
template_versions(id, template_id, version, note, snapshot JSON, created_at)
profiles(id, name, note, config JSON, created_at, updated_at, last_run_at)
runs(id, profile_id, profile_name, created_at, status, output_path,
     output_name, summary JSON, config_snapshot JSON, error, duration_ms)
compares(id, name, path, created_at, summary JSON)
settings(key, value JSON)
```

### 数据表（Table）

一个上传文件可能产生多张“数据表”：

- Excel：每个非空工作表一张；
- CSV / TSV：整份文件一张；
- Outlook 邮件：正文中的每个 HTML 表格一张 + 每个支持的附件作为独立子数据源（附件里的每个工作表再各一张）。

表 ID 形如 `source_id::s0` / `source_id::b0`：

- `s0` 是工作表序号，`b0` 是正文表格序号；
- 表 ID 稳定地对应“某个数据源中的第几张表”；
- 方案只存表 ID 与列索引，不复制整表数据；源文件更新后重新运行即可。

`meta` 中保存工作表名、表头行、表头数组、行数、前 8 行样例等。读取时按表头行重新解析，用户可在数据源预览中调整表头行。

### 方案配置（Profile.config）

```json
{
  "mode": "join",
  "primary_table": "s_ab12::s0",
  "primary_keys": [0],
  "lookups": [
    { "table_id": "s_cd34::s0", "keys": [0] }
  ],
  "append_tables": [],
  "auto_by_name": true,
  "target": {
    "kind": "template",
    "template_id": "t_ef56",
    "sheet": "人员汇总",
    "header_row": 2,
    "write_mode": "replace",
    "columns": [
      { "key": "c_x1", "name": "工号", "type": "text",
        "included": true, "template_col": 0 }
    ]
  },
  "mappings": {
    "c_x1": {
      "mode": "table",
      "sources": [
        { "table_id": "s_ab12::s0", "column_index": 0, "transform": "trim" }
      ],
      "combine": "first",
      "fallback": ""
    },
    "c_x2": {
      "mode": "table",
      "sources": [
        { "table_id": "s_cd34::s0", "column_index": 3, "transform": "date" }
      ],
      "combine": "latest",
      "order_by": { "table_id": "s_cd34::s0", "column_index": 5 },
      "date_format": "YYYY年M月D日"
    },
    "c_x3": {
      "mode": "table",
      "sources": [
        { "table_id": "s_cd34::s0", "column_index": 2, "transform": "number" }
      ],
      "combine": "sum"
    },
    "c_x4": {
      "mode": "table",
      "sources": [
        { "table_id": "s_ab12::s0", "column_index": 7, "transform": "direct" },
        { "table_id": "s_cd34::s0", "column_index": 1, "transform": "direct" }
      ],
      "combine": "first",
      "separator": "、"
    },
    "c_x5": {
      "mode": "table",
      "formula_on": true,
      "formula": "=IFERROR([单价]*[数量],0)",
      "fallback": ""
    }
  },
  "options": { "dedupe": true }
}
```

映射有三种模式：

- `table`：指定**来源链**（至少一条 `sources`），可叠加处理方式、合并方式与缺省值；
- `const`：整列固定值；
- `blank`：显式留空。

`table` 模式下每条来源是 `{table_id, column_index, transform}`，数组顺序即优先级。
`mode: "table"` 保留下来只为兼容前端已有分支与老配置，判定「有没有来源」一律看 `sources`。

**老配置兼容**：`{mode:"table", table_id, column_index, transform}` 被读成
「单来源链 + `combine: first`」（见 `fieldmap.sources_of`），所以 0.3.x 的方案不用迁移；
`config.version` 也没有升——结构是向后兼容地扩字段，不是破坏性变更。

每条映射还带几个可选的列级增强字段，公式优先于来源链：

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `combine` | `string` | 多行/多来源的合并方式，见 §6.7；非法值回落 `first` 并给警告 |
| `order_by` | `{table_id, column_index}` | 仅 `combine: "latest"` 用；必须和某条来源同表，否则退回按本列自身比较 |
| `separator` | `string` | 仅 `combine: "concat"` 用，默认 `、` |
| `formula_on` | `bool` | 该列是否启用公式。只有显式 `true` 才生效，老方案缺省即关闭 |
| `formula` | `string` | 公式正文，如 `=[单价]*[数量]`；`formula_on` 为真但正文为空会直接报配置错误 |
| `date_format` | `string` | 日期列的展示格式键（见 §7），仅在首条来源的 `transform` 为 `date` 或列类型为 `date` 时参与写入 |

`formula_on` 与 `formula` 拆成两个字段，是为了让「关掉公式但留住内容」不丢配置：
用户在界面上取消勾选公式后，`formula` 仍留在 JSON 里，下次打开还能接着改。

启用公式的列会**跳过** `sources` / `combine` / `transform`：
取值完全由公式决定，来源表只用来提供可引用的字段名（见 §6.4）。

## 6. 汇总引擎

### 6.1 主表关联（join）

- 主表决定输出行数与顺序；
- 主键支持组合键（多个列索引）；
- 每个关联表建立 `normalized_key → row` 索引，重复键取第一条并告警；
- 目标列按映射从主表或关联表取值；
- 未命中、空值 → `fallback`；仍为空则写空字符串；
- 可选“主键重复只保留第一行”。

键归一化会做：NFKC、去首尾空白、压缩空白、`1.0 → 1`、日期统一为 ISO。避免 Excel 里“看起来一样但匹配不上”的常见问题。

### 6.2 多表纵向合并（append）

- 按用户选定顺序遍历表；
- 映射指定了当前表 → 取当前表字段；
- 否则若开启“同名列自动匹配”，按目标列名在当前表中查找同名列；同名列不存在时，
  再试目标列名括号里的备注名（见 §6.5）；
- 都没有 → 缺省值；
- 适合多个月份、多个部门的同构表汇总。

### 6.3 处理方式

`direct / trim / text / number / date / upper / lower`。数值会去掉千分位、货币符号，
百分比按数学语义折算（`50%` → `0.5`，写回时套 `0.00%` 格式）；日期支持
`YYYY-MM-DD`、`YYYY/M/D`、中文日期等。**裸数字不猜日期**：`46000` 既可能是
日期序列号也可能是真实编号，一律原样保留（真正的 Excel 日期单元格由 openpyxl
读成 datetime，不经过这条推断）。

**歧义日期不猜**：`03/04/2026` 这类日月两段都 ≤12 的输入无法从单条数据判断顺序，
保持原文并在警告里汇总条数；`13/04/2026` 与 `04/25/2026` 则按数值大小正确识别为日/月、月/日。
猜错一次整列日期就是错的，而且不会有任何人发现——所以选择"不猜"。

全局"自动清理文本首尾空格"可在设置中关闭。

### 6.4 列公式

映射配了 `formula_on: true` 时，该列的值由公式算出，不再走"取某表某列"的路径。
实现在 `backend/formula.py`（978 行），分成四层：词法 → 语法 → 编译 → 求值。

**为什么自己写解析器而不是 `eval`**：公式是用户输入的字符串，`eval` 等于把
`__import__('os').system(...)` 直接交给浏览器里的任何一个同事。白名单函数表 +
自建 AST 是唯一可接受的做法。同时这也保证了行为可预测——你不可能期望
`[金额]` 这种方括号引用被 Python 的语法接受。

**词法与语法**

| 记号 | 形式 | 说明 |
| --- | --- | --- |
| 字段引用 | `[字段名]` | 名字须与数据表表头完全一致（去首尾空白后比较），支持中文、空格、括号 |
| 字符串 | `"文本"` | 内部 `""` 表示一个字面双引号 |
| 数字 | `12` / `3.14` / `-0.5` | 负号由一元运算处理，不属字面量 |
| 函数调用 | `SUM(...)` | 函数名大小写不敏感，统一转大写 |
| 参数分隔 | `,` 或 `，` | 中文逗号可直接用，避免输入法切换 |
| 运算符 | `+ - * / ^ &` `= <> > < >= <=` | `&` 是文本拼接，`^` 右结合 |

优先级从低到高：比较 → `&` → `+ -` → `* /` → `^` → 一元正负 → 原子（数字 / 字符串 /
字段 / 函数调用 / 括号）。与 Excel 一致，所以 `1&2+3` 得到 `"14"` 而不是 `"15"`。

**函数表（39 个，四大类）**

- 数学计算（11）：`SUM` `MAX` `MIN` `ABS` `INT` `MOD` `POWER` `SQRT`
  `ROUND` `ROUNDUP` `ROUNDDOWN`
- 文本处理（11）：`CONCAT` `LEFT` `RIGHT` `MID` `LEN` `TRIM` `UPPER` `LOWER`
  `SUBSTITUTE` `TEXT` `VALUE`
- 条件判断（8）：`IF` `IFERROR` `AND` `OR` `NOT` `ISBLANK` `ISNUMBER` `ISERROR`
- 日期计算（9）：`TODAY` `NOW` `YEAR` `MONTH` `DAY` `DATE` `DAYS` `EDATE` `EOMONTH`

`IF` / `IFERROR` / `ISERROR` 走**惰性求值**，不进 `FUNCTIONS` 表而是单独登记在
`LAZY_FUNCTIONS`：`IFERROR([数量]/[单价], 0)` 在 `[单价]` 为 0 时不能先抛出
`#DIV/0!` 再兜底，必须只算被选中的那一支。这也是解析层与求值层分离的直接原因。

**数值与日期的语义约定**

- 空值（`None` / `""`）在算术里按 0 参与，在文本拼接里按空字符串，在 `ISBLANK` 里为真。
- 日期用 Excel 序列号模型互通，epoch = `1899-12-30`；`TODAY()` 与 `NOW()` 取本机日期。
- `ROUND` 用 `Decimal` + `ROUND_HALF_UP`：Python 内置 `round()` 是银行家舍入，
  `round(2.5)` 得 2，会让"四舍五入"的合同数字少一分钱。
- 错误值直接沿用 Excel 的写法：`#VALUE!`（类型不对）、`#DIV/0!`（除零）、
  `#REF!`（引用的字段在本行缺失）、`#NAME?`（不认识的函数）、`#NUM!`（数值越界或嵌套过深）。

**性能**：`compile_formula()` 在进入行循环**之前**执行一次，得到 `Formula`
对象（`__slots__ = ("text", "ast", "refs")`），循环里只做 AST 求值。
5 万行 × 3 个公式列不会重复词法分析。

**字段可见性**：公式能引用的字段 = 所有参与表表头的并集，重名按"先出现者优先"。
`join` 路径用 `setdefault` 构造字段字典，关联行缺失时值为 `None` 而不是 `#REF!`——
Excel 里缺失的单元格是空的，不是错误。`append` 路径先算所有表表头的并集再逐表填，
因此引用另一张表独有的字段会得到空值；`validate_config` 会对此给出一条 warning
（"只在部分数据表中存在，缺失的行会写入 #REF!"）。

**配置校验（保存方案时阻断）**

| 情况 | 提示 |
| --- | --- |
| `formula_on` 为真但正文为空 | `列「X」启用了公式但内容为空，请填写公式或关闭公式。` |
| 语法错误 | `列「X」公式语法错误：<原因>（第 N 个字符附近）` |
| 引用了不存在的字段 | `列「X」公式引用了不存在的字段 [a]。可引用：…（最多列 8 个）` |

**运行期失败（不阻断，落 Excel 错误值并汇总告警）**：单个单元格算不出来不该让整次
汇总白跑。`_formula_value()` 捕获 `FormulaError` 后返回错误码字符串（Excel 里会被
识别为错误值），同时按列记账；运行结束拼接成一条 warning：

```text
列「总额」有 3 个单元格公式计算失败（#DIV/0! ×2、#VALUE! ×1），首个：第 12 行 除数不能为 0。结果里已写入 Excel 错误值，可用 IFERROR 兜底。
```

这条 warning 会出现在运行结果的提示区，用户能立刻知道"哪一列、多少行、第一个错在哪"，
而不是打开 Excel 肉眼找 `#VALUE!`。

### 6.5 列名匹配：同名 → 括号备注名 → 相似度

模板是别的部门定的，列名常写成「员工编号（工号）」「月薪（税前）」；数据源来自另一个
部门，列名就叫「工号」「税前」。两边都不能改，只能在中间做适配。规则集中在
`backend/column_match.py` 一个文件里，**前端不重复实现**——「按列名匹配」按钮调
`POST /api/match-columns`，纵向合并的自动补齐调同一个模块的 `TableMatcher`。

**规则一句话**：**目标列名里带括号备注的，先取括号里的备注名去数据源里找；
不带括号的，才直接按列名找。**

模板列写成「名称（备注）」，意思就是"这一列在数据源里叫『备注』"——括号里的是**权威名**，
外面那个「名称」只是给人看的说明。所以数据源里同时有「名称」和「备注」两列时，
「名称（备注）」取的是**「备注」**。

0.6.0 的层级是「同名 → 备注名 → 相似度」（先拿整串列名去撞），会先撞上「名称」，
括号里的备注等于白写，匹配结果因此显得"错乱"——0.7.0 把这一层反过来。

**三层，前一层永远优先**

| 级别 | 比什么 | 命中后 |
| --- | --- | --- |
| ① 备注名 | **仅当目标列带括号**：括号内的文字，按出现顺序逐个试 | `via=alias` |
| ② 列名 | **仅当目标列不带括号**：列名与源表列名的比较键相同 | `via=exact` |
| ③ 相似 | 有效匹配名的相似度（序列比 + 包含关系加权） | `via=similar` |

带括号的列**不会**再拿整串列名去撞：数据源里没有同名备注名时，这一列就留空（进候选列表），
而不是悄悄取一个语义相近的列——错配比留空更难发现。
多个括号按出现顺序依次试（`月薪（税前）（元）` → 先试「税前」再试「元」），
每个候选名都跨表扫一遍再进下一层。相似度比的是**有效匹配名**
（带括号时就是括号里的备注名），不是目标列的整串文字。

**比较键（`match_key`）** = 规范化（去零宽、全角转半角、压空白）→ 忽略大小写
→ 去掉分隔符（空格 / 下划线 / 连字符 / 中点 / 斜杠 / 冒号 / 逗号 / 句点）。

这一层是 0.6.0 补上的，之前只做"去首尾空格"，所以下面这些全都匹配不上：

| 目标列 | 源列 | 以前 | 现在 |
| --- | --- | --- | --- |
| 员工工号 | 员工_工号 | 未命中 | 同名 |
| 员工工号 | 员工 工号 | 未命中 | 同名 |
| EmployeeID | employeeid | 未命中 | 同名 |
| 应发工资 | 应发 工资 | 未命中 | 同名 |
| 手机号 | 手机号码 | 未命中 | 相似 93% |
| 所属部门 | 部门 | 未命中 | 相似 90% |

**相似度的两个细节**：

- 基础分是 `difflib.SequenceMatcher` 的序列比；一个键是另一个的子串时额外加权
  （`0.82 + 0.15 × 短/长`），所以「手机号 / 手机号码」这种只差一个字的分才够高。
- **最高分并列时不自动采用**（分不清是哪一个），只作为候选列出来；
  阈值 `SIMILARITY_MIN = 0.85`，命中后界面上会标出分数提醒核对。

`TableMatcher`（纵向合并的同名列兜底）**只做前两层**，不做相似度——纵向合并是
"同构表按列名对齐"，相似度兜底反而容易把两列不同的表对齐错。

只解析**目标列**的括号，不解析源表列名的括号——源表的括号在别人手里可能有别的含义
（单位、口径、备注），替它猜是制造错误而不是适配。模板文件与源表都保持原样。

**括号解析规则**

- 开括号 `（ ( 【 〔 ［ [`，闭括号 `） ) 】 〕 ］ ]`，任意「开 + 闭」组合都认：
  `（备注)` 这种全半角混用是手打时最常见的失误，认；
- 按括号深度取**最外层**内容，不递归：`金额（含税【元】）` 的候选是「含税【元】」；
- 一个列名里有多组括号，按出现顺序依次作为候选：`月薪（税前）（元）` → 先「税前」再「元」；
- 只有开括号没有闭括号的部分跳过，不影响同一列名里其它成对的括号；空括号忽略；
- 同名重复的别名去重。

**冲突怎么处理**

- **候选优先于表**：拿严格名把主表、各关联表都试一遍，都没命中才试第一个别名。
  所以「严格命中关联表」优先于「别名命中主表」；
- **表内取最左**：同一张表出现重复表头，取最左边那列；
- **表间按配置顺序**：主表 → 关联表（按用户添加顺序）；纵向合并按 `append_tables` 顺序；
- **命中即停**，不再试后续别名，结果确定可复现；
- **多个目标列命中同一个源列是允许的**（`姓名` 与 `联系人（姓名）` 都取姓名），互不排斥。

**刻意不做**：模糊匹配、包含匹配、拼音、大小写折叠、NFKC。这些都是「看起来更聪明、
实际更容易连错」的手段——列名对不上就留空让人工选，猜错比留空更难发现。

规范化只做无争议的部分：去零宽字符、全角空格转半角、连续空白压成一个、去首尾空白。

匹配行会显示「括号备注名「税前」」这行小字，让人知道这一列不是同名命中的；手改字段后
提示自动消失，不留过期信息。

## 6.6 数据模板：目标表的结构契约

0.3.0 起模板从方案里独立出来，成为与「数据源」「汇总方案」平级的模块。这一节说明边界
为什么这么切，以及切完之后哪些事情归谁。

### 边界

```text
数据模板  只描述「目标表长什么样」
          列名 / 类型 / 必填 / 校验规则 / 列宽 / 日期格式 / 可选的 Excel 样式底稿
          不做：关联、合并、去重、数据来源

汇总方案  只描述「数据从哪来、怎么进这些列」
          主表 / 主键 / 关联表 / 逐列映射 / 公式 / 转换 / 写入方式
          单向依赖模板：config.target.template_id
```

这条线的作用是让两边的变更互不牵连：模板改一列，方案里只出现一条「字段有变化」；
方案换数据源，模板完全不用动。删除被引用的模板会被拦住（`force=1` 才强删），
避免方案的目标表在用户不知情时失效。

### 字段定义为什么存在 `templates.meta.fields`

字段是**整体使用**的：打开一个模板就要全部字段，编辑一次就是提交一整份结构。单独建
`template_fields` 表会把「读一个模板」变成 N+1 次查询，换来的只有「按字段搜索」一项，
而列表页搜索直接遍历 `meta.fields` 里的列名就够了（模板数量级在几百份以内）。
所以 `meta` 里存 `{sheets, fields, sheet, header_row, warnings}`。

### 两种来源（`origin`）

| origin | 文件从哪来 | 字段变化时怎么处理 |
| --- | --- | --- |
| `fields` | 程序按字段生成 | 整份重画 xlsx：表头、列宽、日期格式、下拉都按新字段来 |
| `upload` | 用户上传的 Excel | 只改表头**单元格文本**，列宽/配色/合并/公式一律不动 |

`upload` 的反向操作是「从文件重读表头」（`PUT {resync:true}`）：文件才是真相，
此时只更新字段定义、**不**把字段名写回文件，否则会串列。

### 版本

`template_versions` 存 JSON 快照，最多 20 份。触发条件是字段签名变化：
`fields_signature()` 只比较 `name/type/required/default/width/date_format/template_col`，
改说明、改示例值不算结构变化，不会产生版本噪音。回滚本身也是一次结构变化，
所以回滚前会先把当前结构也存一份，回滚可逆。

### 校验：只提示，不阻断

7 种规则：`unique / enum / pattern / min / max / min_len / max_len`。执行时机是
`/api/preview` 与 `run_profile()`，结果以 `field_validation` + 中文 `warnings`
返回，不抛异常、不中断生成——数据质量问题应该由人判断怎么处理。

日期类型的判断复用 `utils.parse_date_value`，和 `writer` 写单元格时同一套逻辑，
所以不会出现「校验通过却写不进去」这类自相矛盾。空值只触发「必填」，其他规则跳过：
一条记录没有工号，报「必填」就够了，不该再报「格式不对」。

`origin='fields'` 的模板在生成 xlsx 时给 `enum` / `bool` 字段挂 `DataValidation` 下拉，
让 Excel 里手填也不会超出范围；`upload` 模板不动用户自己的数据验证。

### 6.7 来源链与合并方式（多源、一对多）

数据模板只描述「表长什么样」，**行基准永远是当月数据表**：关联模式看主表行数，
纵向合并看每张表的行数。模板里即使有示例数据也不参与计算——这条边界是 0.4.0 定下来的。

一列的取值分两段，规则集中在新模块 `backend/fieldmap.py`：

```
sources[]（有序）  →  每条来源从「本行/匹配到的所有行」取值 + transform
                   →  items[(值, 比较键)]
                   →  aggregate(combine, items)
```

**为什么关联表的索引要存多行**。旧实现 `index[key] = row` 只留第一条，一个人有三条加班
记录时另外两条被静默丢掉，只在警告里说「已取第一条」。现在 `index[key] = [row, ...]`，
由每列自己的 `combine` 决定用哪条、用几条。代价是 memory 里多存几行引用的指针
（行本身是同一批 list 对象，不复制），换来「求和 / 计数 / 取最新」这些本来就该有的能力。

**七种合并方式**（`fieldmap.COMBINES`，前端 store.js 的 `COMBINES` 与之一一对应）：

| key | 语义 | 需要排序键 |
| --- | --- | --- |
| `first` | 按来源链顺序，第一个非空值胜出（默认） | 否 |
| `sum` | 数值求和，非数值与空值跳过 | 否 |
| `count` | 数有值的条数 | 否 |
| `max` / `min` | 按 `sort_key` 比大小，空值不参与 | 否 |
| `latest` | 按 `order_by` 排序后取最后一条的**本列值** | 是 |
| `concat` | 去重保序，用 `separator` 连接 | 否 |

`latest` 与 `max` 的区别值得单独说：`max` 是「这一列自己取最大」（最大日期）；
`latest` 是「按排序列找到最新那行，再取这一行里的**别的列**」（最近一次就诊的医院）。
所以 `order_by` 必须和来源同表，否则语义不成立，引擎退回 `order_idx = idx` 并在
`validate_config` 里给 warning。

`sort_key` 把值折成 `(等级, 可比较值)`：空 0 / 日期 1（转成 `date` 对象）/ 数值 2 / 文本 3。
混着日期和文本时等级不同也能比较，不会因为 `str` 与 `int` 相减抛 `TypeError`。

**纵表合并的「本地来源」**。append 模式下原来靠 `auto_by_name` 全表按列名猜；
0.4.0 起先看该列有没有指定**当前这张表**的来源（`local[col_key]`），有就用来源链
（`primary_tid` 设成当前表、`matched` 传空字典，同一套 `_resolve` 即可表达
「只有当前表那条来源生效」），没有才走同名列兜底。

**预编译**。行循环里每列要跑几万次，所以 `_compile_plan()` 在进循环前把 mapping 折成
`{kind, sources, combine, separator, order_by}`，循环里只做下标取值与聚合，
不再反复解析 JSON 结构。

**列级统计**。`build()` 顺带累计 `col_filled / col_empty`，返回：

```json
[{ "key": "c1", "name": "手机号", "filled": 12, "empty": 3, "empty_rate": 0.2, "required": true }]
```

`/api/preview` 透出为 `column_stats`，预览弹窗用它渲染「列完成度」（有空的列排在前面、
必填缺值标红）。这解决的是模板驱动下最高频的一问：**哪个字段还没填上**。

### 6.10 前端：响应式、可访问性与视觉 token（0.8.0）

**响应式**。8 个页面里只有编辑器会横向溢出，原因不是栅格体系，而是编辑器里三个固定宽度：

| 位置 | 问题 | 修法 |
| --- | --- | --- |
| `.mode-grid` | 双列、无断点降级，两张 355px 卡片并排 = 722px | ≤900 改单列 |
| `.editor-head` | 标题没 `min-width:0`，按钮不换行 → 标题被压成竖排 | ≤900 标题一行、状态+按钮一行 |
| `.map-table` | `min-width:720px` 顶破 padding（768px 溢出 18px） | ≤900 取消最小宽；≤640 改卡片式 |

映射表在 ≤640 不再横向滚动：改成"列名+状态 / 来源 / 取值方式+操作"的卡片，
因为触屏上横向滚动去找右侧按钮非常难操作。

**可访问性**（这几条是回归脚本 `tests/ui/check-ux-a11y.mjs` 守着的）：

- 对比度：`--faint` 5.3:1、`--muted` 6.24:1、正文 `--ink` 16.6:1；说明文字最小 12px。
  更浅的一档只留给 `--faint-deco`（分隔符、占位）。
- 表单控件必须有可访问名称（`label[for]` / 包裹 / `aria-label` 三选一），当前 0 个无名。
- 弹层的键盘处理：**只有最上层响应 Esc 与 Tab**（`root.lastElementChild === overlay` 才处理），
  否则一次 Esc 会把两层一起关掉。
- 路由切换后 `view.focus()`，导航项带 `aria-current="page"`——读屏才知道"页面换了"。
- 每页有且只有一个 `h1`（编辑器把标题输入框包进 `h1.editor-title-line` 并重置样式）。

**视觉 token**：字号收敛到 10 档（10/11/12/13/14/16/20/22/24/26），
圆角 7 档（6/8/10/12/14/16/999）。新增元素请从这两组里取值，不要再引入 10.5px、7px 这种离群值。

**破坏性操作的约定**：

- 可挽回的（清空一列来源）→ toast 带「撤销」，5 秒内可恢复，不打断；
- 不可挽回的（删列、换模板丢映射、全部重配覆盖手工配置）→ `confirmDialog(danger: true)`，
  文案里写清"会丢什么"；
- 危险确认框的初始焦点在「取消」（`.btn-danger` 不匹配"聚焦主按钮"的选择器；另有显式保障）。

### 6.9 前端：字段映射的「一行一列」与状态模型

映射区以前是**两行一列**（主行 + 一条「取值」行），主行里还塞着主来源、来源字段、
处理方式、缺省值四个控件。0.6.0 收成**一行一列**：

| 格 | 内容 |
| --- | --- |
| 目标列 | 列名 + 类型/必填 |
| 来源 | 「表名 · 列名」摘要；多来源显示「等 N 个来源」；非默认取值方式挂一个小标签 |
| 取值 | 合并方式下拉（唯一留在行内的设置项） |
| 状态 | 「同名 / 备注名 / 相似 93% / 手动 / 未配置 / ƒx 公式」标签 |
| 操作 | 映射（弹层）、清空、规则（弹层） |

细节全部收进**「映射」弹层**：来源列、备用来源、取值方式、排序列、处理方式、日期格式、
缺省值、写公式。弹层里的改动**即时生效**（没有"草稿/应用"两段状态），
并且同一时间只留一个弹层（`mappingDialog` 变量），免得两层叠着点错。

**状态模型收敛**：以前一个映射要同时维护 `auto_matched` / `matched_via` /
`matched_alias` / `user_blank` 四个并行标记，改一处要记得改另外几处。现在：

- 匹配来源收成**一个** `matched` 字段：`{via, score, alias}`；
- 「用户明确留空」不再用标记位，而用**有没有这个键**区分：
  没有键 = 没配过（自动匹配可以填）；`mode:'blank'` = 用户清空（自动匹配不再填）；
- `store.js` 的 `normalizeMapping()` 负责把老配置折成新结构，并顺手删掉那四个旧字段，
  老方案打开时自动就整理干净了。

前端新增的三个小函数把"这一列现在是什么状态"收在一处，避免各处各写一套判断：
`mappingState(key)`（来源/公式/是否清空/匹配信息）、`setMapping(key, patch)`、
`clearMapping(key)`。

### 6.8 前端：自动预匹配与目标列折叠

这两项只动前端，但它们改变了「配置一个方案」的成本结构，所以单独记一节。

**自动预匹配（`profile.js` 的 `autoMap` / `maybeAutoMap`）**

匹配规则本身不在前端——仍然是 `POST /api/match-columns`（严格同名 → 括号备注名），
前端只负责决定"什么时候匹配、匹配给谁、结果怎么标"：

- **触发点**：选定主表、加/换/删关联表、加/删纵向合并表、选定或更换模板、打开已有方案。
  统一走 `maybeAutoMap()`，内部用**指纹**（模式 + 数据源 id 集合 + 主键 + 目标列签名）
  判断是否需要重跑，指纹不变就立刻返回——否则每次重绘都会去动用户的选择。
- **只填空位**：跳过①已有可用来源链②`formula_on` 为真③`user_blank`（用户明确选过留空）。
  `user_blank` 是 0.5.0 新增的标记位，否则用户主动留空的列会被下一次自动匹配悄悄填回去。
- **标识**：命中的列写 `auto_matched: true` 与 `matched_via: 'exact' | 'alias'`，
  界面渲染成「自动 · 同名 / 备注名」标签；用户手动改来源字段、处理方式、合并方式或
  从候选里选时，`auto_matched` 被清掉，标签随之消失。
- **候选下拉**：没匹配上的列渲染 `data-map-candidate`，选项是当前所有参与汇总的表的列
  （按表分组），同名与备注名候选打标。选中后即成为一条普通来源链。

**目标列折叠（`targetDetailOpen`）**

目标列动辄几十行，展开铺满屏幕，真正要改的往往只有一两列，所以默认收起，
收起时只显示概要（列数 / 纳入数 / 必填数 / 列名预览）。

折叠状态**只活在会话里**（不写进 `config`，刷新页面即回到默认收起），复位规则有三条：

| 事件 | 行为 |
| --- | --- |
| 点段落标题切换步骤 | 离开「目标表」时收起 |
| 选定 / 更换 / 同步模板 | 收起（目标列重建了，旧展开状态会让人以为没生效） |
| 移除模板 | 收起 |

因此状态是"收起 / 展开"这一个布尔值加上一个 `activeStep`，都在 `render()` 的闭包里，
不进入配置、不进入数据库。

## 7. 模板写入

1. 复制模板文件到本次运行的独立目录，绝不原地修改模板；
2. 用 openpyxl 打开副本（`.xlsm` 使用 `keep_vba=True`）；
3. 按 `template_col` 定位每列，找不到时按表头名回退；
4. `replace`：从表头下一行开始写，清理映射列旧值，保留行样式；
5. `append`：找到所有列中最后一个有值的行，把新数据追加到其后；
6. 新行超出模板已有数据区时，复制首行数据区样式与行高；
7. 未被纳入映射的模板列保持原样，适合公式列、签字列、手工备注列；
8. 按列的 `date_format` 套 `number_format`（见下）；
9. 保存为新的 `.xlsx` / `.xlsm`，文件名带秒级时间戳。

### 列级日期格式

`date_format` 存的是界面上的展示键，写入前由 `DATE_FORMATS` 翻译成 Excel 自定义
格式代码（`_column_date_formats()` 按输出列顺序取一遍，`_apply_number_format()`
接收第 5 个参数 `date_fmt`，空白表与模板两条写入路径都传）：

| 界面选项 | Excel 格式代码 | 显示效果 |
| --- | --- | --- |
| 跟随全局设置（空字符串） | 不设置，沿用模板/全局 | 取决于模板原有格式 |
| `YYYY-MM-DD` | `yyyy-mm-dd` | 2026-10-21 |
| `YYYY/M/D` | `yyyy/m/d` | 2026/10/21 |
| `YYYY年M月D日` | `yyyy"年"m"月"d"日"` | 2026年10月21日 |
| `YYYY-MM-DD HH:mm` | `yyyy-mm-dd hh:mm` | 2026-10-21 14:30 |
| `YYYY-MM` | `yyyy-mm` | 2026-10 |
| `M月D日` | `m"月"d"日"` | 10月21日 |
| `YYYYMMDD` | `yyyymmdd` | 20261021 |
| `DD/MM/YYYY` | `dd/mm/yyyy` | 21/10/2026 |
| `MM/DD/YYYY` | `mm/dd/yyyy` | 10/21/2026 |

两个细节：

- 中文年月日必须用双引号包住字面量（`yyyy"年"m"月"d"日"`），否则 `年`/`月`/`日`
  会被 Excel 当作格式保留字符，轻则不显示、重则报格式非法。
- 写入的是**真日期值 + 显示格式**，不是格式化后的字符串。所以单元格仍然可以排序、
  参与日期计算、被数据透视表按日期分组——"改成 2026年10月21日"不会把这列变成文本。
- 同一条格式化规则在前端预览里由 `formatDateByPattern()`（`web/js/pages/profile.js`）
  复现，token 扫描顺序与后端 `_format_date()` 保持一致；不一致会导致预览与产物对不上。

已知边界：openpyxl 不能完整保留图表、图片、数据透视表等对象；极复杂的模板建议先用 Excel 打开核对一次。模板数据区若有合并单元格，写入会给出明确错误提示。

## 8. 数据对比

- 对比对象可以是两次运行结果，也可以任意一张数据表；
- 读取运行结果时从 `summary.output.data_start` 开始，而不是固定 `header_row + 1`：
  append 模式下模板原有行位于 `data_start` 之前，不能被算作本次结果；
- 选择共同主键（支持组合键），两侧分别建立行索引；
- 统计新增行、删除行、修改行、未变化行；
- 修改按“单元格”记录：主键、字段、左侧值、右侧值；
- 单侧独有列单独列出，不误判为整行变化；
- 重复主键取第一条并提示；空主键行跳过；
- 明细在接口中最多返回 800 条变化 / 300 行新增删除，完整报告写入 Excel：
  - 对比摘要
  - 差异明细
  - 新增行
  - 删除行

## 9. API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 一次返回应用信息、数据源树、模板、方案、运行、设置、统计 |
| POST | `/api/sources/upload` | 多文件上传与解析（multipart） |
| PATCH | `/api/sources/:id` | 重命名或调整某张表的表头行 |
| DELETE | `/api/sources/:id` | 删除数据源（邮件会连同附件） |
| GET | `/api/table-preview` | 按表 ID 预览前 N 行 |
| GET | `/api/template-options` | 字段类型、规则种类、状态等可选值（前后端共用一份） |
| GET | `/api/templates` | 模板列表：`q/category/tag/status/sort`，返回 `categories/tags/stats` |
| POST | `/api/templates` | 按字段定义新建模板（同时生成 xlsx） |
| GET | `/api/templates/:id` | 模板详情：字段、版本、引用它的方案 |
| PUT | `/api/templates/:id` | 改名称/分类/标签/状态/字段；`resync:true` 表示从文件重读表头 |
| DELETE | `/api/templates/:id` | 删除；被引用时 400，`?force=1` 强删 |
| POST | `/api/templates/upload` | 上传 Excel 模板，按表头派生字段 |
| POST | `/api/templates/:id/inspect` | 按工作表/表头行重新解析（只读，不落库） |
| POST | `/api/templates/:id/duplicate` | 复制模板 |
| POST | `/api/templates/:id/versions` | 手动存一个版本快照 |
| POST | `/api/templates/:id/versions/:vid/restore` | 回滚到某个版本 |
| GET | `/api/templates/:id/export` | 导出模板定义 JSON（中文文件名走 RFC 5987） |
| POST | `/api/templates/import` | 导入模板定义 JSON，同名自动加 `(2)` |
| GET | `/api/templates/:id/file` | 下载模板 xlsx |
| POST | `/api/templates/:id/validate` | 按字段规则校验一批行，恒返回 200 |
| POST | `/api/preview` | 不落盘，按当前配置生成前 50 行预览 |
| POST | `/api/match-columns` | 按列名批量找来源列：严格同名优先，未命中回退括号备注名；返回 `matches[].{key,table_id,column_index,column_name,via,alias}` 与统计 |
| POST | `/api/profiles/:id/run` | 保存配置并生成结果 |
| GET | `/api/runs/:id/download` | 下载结果文件 |
| POST | `/api/compare` | 生成对比并导出报告 |
| GET | `/api/compares/:id/download` | 下载对比报告 |
| PUT | `/api/settings` | 日期格式、空格清理、保留条数 |
| POST | `/api/cleanup` | 清理旧运行记录与过期对比报告 |
| GET | `/api/formula/help` | 函数速查（39 个，分四组）、日期格式键、引用语法与说明 |
| POST | `/api/formula/check` | 只校验语法与字段引用，不需要完整方案；恒返回 200 |
| POST | `/api/formula/try` | 取指定表前 N 行（默认 5）真算一遍，返回 `samples[].{row,result,error,message,inputs}` |
| POST | `/api/app/shortcut` | 在桌面 / 开始菜单创建快捷方式；非 Windows 返回 400 与说明 |
| POST | `/api/app/exit` | 停止服务并结束进程（仅监听回环地址时可用） |

统一响应：`{ "ok": true, ... }` 或 `{ "ok": false, "error": "可直接展示的中文错误" }`。

`/api/formula/check` 是个例外：它用 `valid: true|false` 表达结果、HTTP 状态恒为 200，
因为前端的 `request()` 会把 `ok:false` 抛成异常，而"公式有语法错误"是编辑器里每敲一个键
都可能出现的正常中间态，不该走异常通道。同理 `/api/formula/try` 里单行算不出来也不报错，
而是给该行 `error` 与 `message`，让预览表格能一行行标红。

## 10. 前端设计系统

- 设计语言：深玉色（`#0E6B5C`）+ 暖白底 + 金色提示；卡片圆角 18px，细边框与柔和阴影。
- 布局：固定侧栏 242px + 顶栏 + 内容区；方案编辑为“主表单 + 右侧运行检查栏”。
- 全部 CSS 变量集中在 `:root`，便于换主题；响应式断点 1250 / 1080 / 900 / 640。
- 图标：`assets/icons.svg` 单文件 sprite，`<use href="...#id">`，无图标字体。
- 字体：`Segoe UI` / `Microsoft YaHei` / `PingFang SC` 系统栈，无需下载。
- 交互：本地 Toast、Modal（含 Esc / 焦点陷阱）、拖拽上传、自动保存（950ms 防抖）、预览、运行结果弹窗。
- 错误兜底：`index.html` 内联监听模块加载错误；路由层捕获渲染异常并显示可重试页面。

## 11. 存储与清理

```text
data/
├─ library/<source_id>/            原始文件；邮件正文 CSV 与附件在其工作目录
├─ templates/<template_id>/        目标模板副本
├─ runs/<run_id>/                  每次运行的结果文件
├─ compares/                       对比报告
├─ tmp/                            临时文件
├─ logs/huiyi.log                  滚动日志
└─ huiyi.db                        元数据
```

- 结果保留条数可在设置中调整（5–500，默认 30）；每次运行后自动清理更早结果。
- 对比报告默认保留 30 天，可由「设置 → 清理旧记录」触发。
- 所有路径都相对于程序目录（或 `HUIYI_DATA_DIR`），便于整目录迁移与备份。

## 12. 部署与更新

### 推荐：Windows 免安装目录版

1. 在可联网的 Windows 电脑安装 Python 3.11/3.12；
2. 运行 `packaging\build_windows.bat`；
3. 得到 `dist\HuiYi\`，内含 `HuiYi.exe`、`_internal/`、启动脚本与说明；
4. 把整个文件夹复制到目标电脑，双击「安装.bat」建桌面图标（或直接双击「启动.bat」）；
5. 首次启动自动创建 `data/`，无需管理员权限、无需安装。

### 快捷方式是怎么建的（`backend/appcontrol.py`）

`安装.bat` 本身不做任何路径拼接，只是 `HuiYi.exe --create-shortcut` 的一层壳。
真正的逻辑在 Python 里，理由有三个：

- **编码**：cmd 用 OEM 代码页，把中文路径传给 PowerShell 会变成乱码。改成
  `powershell -EncodedCommand <UTF-16LE base64>`，命令原文一个字都不会被控制台改写。
- **一致性**：页面上的「创建快捷方式」按钮和 `安装.bat` 调同一个函数，前缀、
  图标、工作目录不可能各自漂移。
- **可测**：脚本拼装是纯函数（`build_shortcut_script`），在非 Windows 上也能做断言。

细节：

| 项 | 取值 | 为什么 |
| --- | --- | --- |
| 目标 | `sys.executable`（打包后即 `HuiYi.exe`） | 指向 exe 而不是 `.bat`，双击不会先闪一个 cmd 窗口 |
| 参数 | 空 | 不写死 `--port`，让 `HUIYI_PORT` 环境变量与自动避让逻辑继续生效 |
| 工作目录 | exe 所在目录 | `DATA_DIR` 相对程序目录解析，工作目录错位会让数据落到别处 |
| 图标 | `<exe>,0` | 用 exe 自带图标，不做额外资源 |
| 位置 | `[Environment]::GetFolderPath('Desktop')` + `StartMenu\Programs` | 兼容 OneDrive / 域环境的桌面重定向 |
| 窗口样式 | 1（常规） | 不隐藏控制台：启动失败时报错行是唯一线索 |

一次运行写两个 `.lnk`，任何一个失败都不影响另一个；脚本把结果写成 UTF-8 JSON
（`Set-Content -Encoding UTF8`，Python 侧用 `utf-8-sig` 读），Python 再统一成人话提示。

### 退出：为什么必须是 `os._exit`

页面「退出应用」→ `POST /api/app/exit` → `schedule_exit()` 起一个 daemon 线程，
0.45 秒后 `os._exit(0)`。

- **不能用 `sys.exit()`**：它只结束调用它的那个线程，waitress 主循环还在，
  端口继续监听，用户会看到"点了退出但服务还活着"。
- **为什么要延迟**：得让这次 HTTP 响应先写完，否则前端拿到的是
  `net::ERR_CONNECTION_RESET`，会误报成"退出失败"。
- **界面先切换**：`showExited()` 在收到响应后立刻把页面换成「已退出」落地页，
  之后不再发任何请求——不然会连着一串"无法连接本地服务"的报错弹窗。
- **权限边界**：只有监听回环地址时才允许。`--host 0.0.0.0` 共享给同事的场景下，
  任何人都能 POST 一下把服务关掉，这是不能接受的，所以直接 400 拒绝。

### 备选：源码 + 离线 wheelhouse

1. 在联网 Windows 上运行 `packaging\prepare_offline_wheels.bat`；
2. 把项目与 `packaging\wheels` 拷到内网电脑；
3. `py -3 -m pip install --no-index --find-links packaging\wheels -r requirements.txt`；
4. 双击 `start.bat`。

### 更新

- 保留 `data/`，替换 `HuiYi.exe`、`_internal/` 与前端静态资源；
- 数据库 schema 目前只做增量建表，升级不会清空数据；
- 建议升级前整体备份 `data/` 文件夹。

## 13. 安全与边界

- 默认仅绑定 `127.0.0.1`，不对外暴露端口；
- **请求来源校验**（`before_request`）：绑回环地址时拒绝 Host 不是
  `127.0.0.1 / localhost / ::1` 的请求（防 DNS rebinding）；写操作若带
  `Origin` 必须与当前 Host 同源，`Sec-Fetch-Site` 为 `cross-site` 一律拒绝。
  没有这道校验时，任意网页都能向 `127.0.0.1:9090` 提交 multipart 表单
  （简单请求免预检），把文件塞进数据目录，或直接 `POST /api/cleanup` 清空历史记录；
- 上传文件名清洗、路径基于 UUID 目录，静态文件路由做目录穿越校验；
- 以 `=`、`+`、`-`、`@` 开头（含前导空白/换行绕过）的文本写入 Excel 时设
  `quotePrefix` 强制为文本，避免公式注入；
- 邮件附件只解析白名单扩展名，不执行任何宏/脚本；
- 响应头带 `Content-Security-Policy`（`script-src 'self'`、`object-src 'none'`、
  `base-uri 'none'`）：内联脚本与 `on*` 属性一律不生效，前端 20 多处 `innerHTML`
  即使漏了一处 `esc()`，注入的脚本也执行不了。内联兜底脚本因此移到了
  `web/js/boot-guard.js`；
- 不接入任何外部服务，代码中无遥测、无 CDN；
- **退出接口只对本机开放**：`/api/app/exit` 在 `--host 0.0.0.0` 时直接 400。
  共享给同事的场景下，一个匿名 POST 就能关停别人正在跑的服务，这是拒绝服务；
  同理 `/api/app/shortcut` 只写用户自己的桌面，这两件事都必须有边界。
- 快捷方式脚本通过 `-EncodedCommand` 传入，不经过 cmd 的代码页转换；
  脚本里所有路径走 PowerShell 单引号字面量并转义单引号，不存在拼接注入。
- 当前不做登录鉴权（单机信任模型）。若未来需要局域网共享，应增加访问令牌与 HTTPS/反向代理。

## 13.1 容量与资源上限

统一在 `backend/config.py`，避免同一件事在三个文件里各写一个魔数：

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `MAX_ROWS` / `MAX_COLS` | 200 000 / 300 | 单表最大行列 |
| `MAX_CELLS` | 3 000 000 | 单工作表单元格上限，防 OOM（约 250–400 MB） |
| `LIMIT_UPLOAD_MB` | 100 | 单个数据源文件（落盘**前**检查） |
| `LIMIT_EXCEL_MB` | 120 | 单个 Excel |
| `LIMIT_ATTACHMENT_MB` | 50 | 邮件单个附件 |
| `LIMIT_REQUEST_MB` | 200 | 单次 HTTP 请求总量（Flask `MAX_CONTENT_LENGTH`） |

读取时通过 `read_excel_grids(path, only_sheets={...})` 只解析被方案引用的工作表；
一个 20 个 sheet 的台账文件不再为了读 1 张表而全量解析 20 张。

## 13.2 数据库连接

`backend/db.py` 用 `@contextmanager session()` 保证"一次操作一个连接、成功提交、
失败回滚、无论如何 close"。**不要写成 `with sqlite3.connect(...)`**——它只提交事务，
不关闭连接，长期运行会堆积文件描述符并持有 `.db-wal` 文件锁。

## 13.3 解析结果缓存

`backend/readers.py` 的 `read_table_data_cached()` 按
「文件路径 + mtime + 大小 + 工作表 + 表头行」缓存解析结果。用户反复调字段映射
时不再每次都重新 openpyxl 读盘；文件一改 mtime 就变，缓存自动失效。

单表超过 40 万单元格时**不缓存**——大表本身已占几百 MB，再留一份会把内存翻倍。
可用环境变量 `HUIYI_TABLE_CACHE_CELLS` 调整（设 `0` 关闭）。缓存的列表约定只读。

## 14. 测试

- `tests/test_regressions.py`：pytest 单元/回归用例，覆盖已修缺陷——百分比语义、
  日期歧义、数据库连接释放、追加模式对比行数、跨站请求拦截、DNS rebinding、
  公式注入、空主键跳过、单元格上限、按需解析工作表。**CI 必跑，不过不出包。**
- `tests/test_formula.py`：68 条，覆盖公式求值 42 例（四类函数、优先级、空值语义、
  惰性求值）、Excel 错误值 4 例、语法错误 7 例（含报错位置）、`engine` 集成 6 例
  （空公式、坏引用、失败记账、日期结果、append 缺字段）、API 3 例、
  `writer` 日期格式 5+1 例（含中文格式代码与"跟随全局"）。
- `tests/test_appcontrol.py`：10 条，覆盖快捷方式脚本拼装（中文路径、单引号转义、
  `.format` 花括号是否写错）、PowerShell 输出归一化（单元素数组被拍平成标量）、
  非 Windows 降级提示、退出钩子、以及「监听 0.0.0.0 时拒绝远程退出」。
- `tests/smoke.py`：Flask test client 端到端覆盖上传、模板、关联汇总、预览、表头调整、运行、下载、两次结果对比、结果对源表、纵向自动匹配、`.xls`、真实 `.msg`、公式注入、模板追加。
- `tests/ui/check-formula-mapping.mjs`：23 项浏览器断言，覆盖公式按钮、弹窗、
  实时校验状态条、试算表、日期格式下拉与预览列格式化。
- `tests/test_templates.py`：22 条，盯住模板这条边界——字段清洗与规则校验、改名后
  Excel 表头真的跟着改、只改说明不产生版本、版本回滚、被引用时删不掉、导入导出往返、
  上传模板重读表头不串列、日期校验与写入同一套判断、老库迁移补齐新列。
- `tests/ui/check-templates.mjs`：31 项，覆盖列表页统计/筛选/搜索/多选批量条、
  编辑页五个标签渲染、改列宽 → 未保存态 → 保存 → 落库、预览弹窗，以及方案侧
  「按分类分组选模板 + 字段摘要 + 跳转模板库」。
- `tests/ui/check-template-entry.mjs`：6 项，守住「模板入口在三张卡片第一层」这个回归。
- `tests/ui/check-app-control.mjs`：12 项，覆盖侧栏退出按钮、设置页两个入口、
  取消不退出、确认后落地页出现、以及**端口真的不再响应**（脚本会关掉被测服务，
  所以必须跑在独立数据目录上，且放在最后）。
- `tests/test_column_match.py`：25 条，盯住列名匹配这条规则——括号解析（全半角/混用/
  六种括号/多组/嵌套/未闭合/空括号/去重）、规范化边界（不做大小写折叠与 NFKC）、
  两级优先级（严格名跨表优先于别名）、表内取最左、多个目标列共用一个源列、
  `TableMatcher` 缓存、`/api/match-columns` 接口，以及一条**纵向合并端到端**用例：
  模板列「月薪（税前）」真的能从「税前」那一列取到数。
- `tests/ui/check-alias-mapping.mjs`：9 项，覆盖「按列名匹配」按钮的两级命中、映射行上
  的别名提示、提示文案区分同名/备注名、结果落库、手改字段后提示消失。
  0.5.0 起新增前提：先把三列标成 `user_blank`，验证**自动匹配不覆盖用户明确留空的列**，
  而手动点按钮仍然会填。
- `tests/test_combine.py`：18 条，盯住来源链与合并方式——七种合并方式的边界（空值不参与
  最大最小、`concat` 去重保序、`count` 不数空、`sum` 跳过非数值）、新旧两种配置结构的读取、
  多来源兜底、一对多聚合、`latest` 取「排序列最新那行的本列值」、纵向合并里「每张表用
  自己那条来源」、未知 `combine` 降级加警告、`column_stats`、必填无来源的提示、
  多行警告里出现 `multi_keys / max_rows_per_key`。
- `tests/ui/check-mapping-chain.mjs`：19 项，覆盖段落顺序（数据来源 → 目标表 → 字段映射）
  与编号、每列都渲染取值条、多来源 chip 与合并方式回显、`latest` 的排序列下拉、
  预览里的列完成度、切合并方式后说明文字跟着变、追加来源、**取消勾选一列不再误报
  模板差异**、模板卡片「建方案」预填与模板锁定。
- `tests/ui/check-auto-match.mjs`：24 项，覆盖「目标列详情」默认收起、展开可编辑、
  切换步骤与更换模板后复位收起；打开方案即自动预匹配（9 列里配出 8 列）、
  严格同名命中「工号 → 人员信息表」、括号备注名命中「月薪（税前）→ 税前」、
  自动标识出现、手动改来源后标识消失、没匹配的列给出候选下拉并可选中。
- `tests/ui_shot.py`：开发期用 Chrome DevTools Protocol 截图与检查浏览器异常。
- `samples/make_samples.py`：生成可复现的示例文件。

- `tests/test_match_rules.py`：16 条，盯住新的三层匹配规则（比较键对大小写/空格/下划线/
  全角的折叠、三层优先级、相似度阈值、并列不采用、候选排序、"精确命中在后面的表"优先）。
- `tests/ui/check-mapping-ui.mjs`：21 项，覆盖字段映射的新界面——每列只占一行、行内只剩
  五个格子、三个操作按钮齐全、命中标识（同名/备注名/相似）、相似度命中、映射弹层能改来源、
  清空后自动匹配不回填、规则弹层显示模板校验要求。

- `tests/ui/check-ux-a11y.mjs`：25 项，守住 0.8.0 这批 UX/可访问性修复——对比度、
  表单控件命名、编辑器 h1、`aria-current`、Esc 只关最上层、清空可撤销、全部重配先确认、
  切页焦点、390/768 无横向溢出与头部高度、未匹配筛选、待处理清单。

当前基线：`pytest tests -q` → **219 passed**；九个 UI 巡检脚本共 180 项断言
（本轮 180 项全部实跑通过：字段映射新界面 22、自动预匹配 23、字段来源链 23、
括号备注名 9、模板 31、公式 23、模板入口 12、退出与快捷方式 12、UX 与可访问性 25）。

## 14.1 发布流水线

`.github/workflows/build-windows.yml`：

- 触发：推送 `v*` tag，或 Actions 页面手动 Run workflow；
- 环境：`windows-latest` + Python 3.12 x64（PyInstaller 不能跨平台交叉编译，必须 Windows）；
- 步骤：装依赖（含 `red-black-tree-mod` sdist 解包失败的兜底）→ 校验 import →
  跑 `pytest` → 跑 `smoke.py` → PyInstaller → 组装目录 → zip → Artifacts / Release；
- 产物：`TableSummaryAssistant-vX.Y.Z-windows-x64.zip`，解压双击「启动.bat」即用。

## 14.2 打包：为什么既不用 `tar -a` 也不用 `Compress-Archive`

压缩这一步踩过两次坑，都跟中文文件名有关，现在统一交给 `packaging/make_zip.py`。

**`tar -a -c -f`（bsdtar）** 本身是 Unicode 友好的，问题出在**参数传递**：
`tar.exe` 是普通 Win32 程序，它的命令行经 `CreateProcess` 按**进程 ANSI 代码页**
（en-US runner 上是 cp1252）转换。`表格汇总助手` 这六个字在交给 tar **之前**
就已经变成 `??????`，属于不可逆的有损转换——打出来的包里目录名就是六个问号，
`安装.bat` 变成 `????.bat`。v0.2.4 的线上包就是这么坏的，当时肉眼没发现，
是解包后读 zip 条目字节才确认（`b'??????/'`）。

**`Compress-Archive`** 是 .NET 实现，写中文名时不置 UTF-8 标志位（bit 11），
在非中文 Windows 或第三方解压工具里显示成乱码。

**Python `zipfile`** 用宽字符 API 取路径，对非 ASCII 名自动置 bit 11，两个坑都绕开。
脚本在写完 zip 后会**重新打开自检**：

1. 条目名里不能出现 `?`（有就说明又被 ANSI 转过）；
2. 非 ASCII 名必须带 bit 11；
3. 条目数不低于 `--expect-min`（CI 传 500），防止打出空壳包。

任一条不满足就让构建非零退出，红在 CI 上而不是红在同事的电脑上。
`tests/test_packaging.py` 在本地复现这三条判定。

另外 `.gitattributes` 把 `*.bat` 钉成 CRLF：`install.bat` 里有 `goto :done`，
cmd.exe 解析纯 LF 文件的标签并不可靠，之前能跑属于运气。

## 15. 后续可扩展

- 公式函数扩充：`VLOOKUP` / `XLOOKUP`（跨表查值）、`REGEX` 系列、`SUMIF(S)`、
  文本分列；以及单元格区域引用（`A1:B2`）——当前只支持 `[字段名]` 按列引用；
- 方案导入/导出与跨电脑共享；
- 多工作表/多行复杂表头；
- 模板的字段分组与条件必填（例如「离职」状态下才要求填离职日期）；
- 校验问题行导出成一张「问题清单」表，方便退回给填报人修改；
- 通过 Windows COM 调用本机 Excel，精确保留图表/透视表；
- 通过 Outlook COM 读取 `.pst/.ost`；
- 局域网只读分享模式（带令牌）。
