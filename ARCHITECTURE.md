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
│  ├─ templates.py        目标模板登记、工作表/表头解析
│  ├─ formula.py          Excel 风格公式：词法、语法、白名单函数、逐行求值
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
│     ├─ components.js    方案卡片、新建方案、运行详情
│     └─ pages/           工作台、数据源、方案、编辑、对比、记录、设置
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
templates(id, name, path, size, created_at, meta JSON)
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
      "table_id": "s_ab12::s0",
      "column_index": 0,
      "column_name": "工号",
      "transform": "trim",
      "fallback": ""
    },
    "c_x2": {
      "mode": "table",
      "table_id": "s_ab12::s0",
      "column_index": 2,
      "column_name": "业务日期",
      "transform": "date",
      "date_format": "YYYY年M月D日"
    },
    "c_x3": {
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

- `table`：指定数据表 + 列索引，可叠加处理方式与缺省值；
- `const`：整列固定值；
- `blank`：显式留空。

每条映射还带两个可选的列级增强字段，二者互不排斥但公式优先：

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `formula_on` | `bool` | 该列是否启用公式。只有显式 `true` 才生效，老方案缺省即关闭 |
| `formula` | `string` | 公式正文，如 `=[单价]*[数量]`；`formula_on` 为真但正文为空会直接报配置错误 |
| `date_format` | `string` | 日期列的展示格式键（见 §7），仅在 `transform` 为 `date` 或列类型为 `date` 时参与写入 |

`formula_on` 与 `formula` 拆成两个字段，是为了让「关掉公式但留住内容」不丢配置：
用户在界面上取消勾选公式后，`formula` 仍留在 JSON 里，下次打开还能接着改。

启用公式的列会**跳过** `mode` / `table_id` / `column_index` / `transform`：
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
- 否则若开启“同名列自动匹配”，按目标列名在当前表中查找同名列；
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
| POST | `/api/templates/upload` | 上传目标 Excel 模板 |
| POST | `/api/templates/:id/inspect` | 按工作表/表头行重新解析 |
| POST | `/api/preview` | 不落盘，按当前配置生成前 50 行预览 |
| POST | `/api/profiles/:id/run` | 保存配置并生成结果 |
| GET | `/api/runs/:id/download` | 下载结果文件 |
| POST | `/api/compare` | 生成对比并导出报告 |
| GET | `/api/compares/:id/download` | 下载对比报告 |
| PUT | `/api/settings` | 日期格式、空格清理、保留条数 |
| POST | `/api/cleanup` | 清理旧运行记录与过期对比报告 |
| GET | `/api/formula/help` | 函数速查（39 个，分四组）、日期格式键、引用语法与说明 |
| POST | `/api/formula/check` | 只校验语法与字段引用，不需要完整方案；恒返回 200 |
| POST | `/api/formula/try` | 取指定表前 N 行（默认 5）真算一遍，返回 `samples[].{row,result,error,message,inputs}` |

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
4. 把整个文件夹复制到目标电脑，双击「启动表格汇总助手.bat」；
5. 首次启动自动创建 `data/`，无需管理员权限、无需安装。

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
- `tests/smoke.py`：Flask test client 端到端覆盖上传、模板、关联汇总、预览、表头调整、运行、下载、两次结果对比、结果对源表、纵向自动匹配、`.xls`、真实 `.msg`、公式注入、模板追加。
- `tests/ui/check-formula-mapping.mjs`：23 项浏览器断言，覆盖公式按钮、弹窗、
  实时校验状态条、试算表、日期格式下拉与预览列格式化。
- `tests/ui/check-template-entry.mjs`：6 项，守住「模板入口在三张卡片第一层」这个回归。
- `tests/ui_shot.py`：开发期用 Chrome DevTools Protocol 截图与检查浏览器异常。
- `samples/make_samples.py`：生成可复现的示例文件。

当前基线：`pytest tests -q` → **116 passed**；两个 UI 巡检脚本 29/29 通过。

## 14.1 发布流水线

`.github/workflows/build-windows.yml`：

- 触发：推送 `v*` tag，或 Actions 页面手动 Run workflow；
- 环境：`windows-latest` + Python 3.12 x64（PyInstaller 不能跨平台交叉编译，必须 Windows）；
- 步骤：装依赖（含 `red-black-tree-mod` sdist 解包失败的兜底）→ 校验 import →
  跑 `pytest` → 跑 `smoke.py` → PyInstaller → 组装目录 → zip → Artifacts / Release；
- 产物：`TableSummaryAssistant-vX.Y.Z-windows-x64.zip`，解压双击「启动.bat」即用。

## 15. 后续可扩展

- 公式函数扩充：`VLOOKUP` / `XLOOKUP`（跨表查值）、`REGEX` 系列、`SUMIF(S)`、
  文本分列；以及单元格区域引用（`A1:B2`）——当前只支持 `[字段名]` 按列引用；
- 方案导入/导出与跨电脑共享；
- 多工作表/多行复杂表头；
- 数据校验规则（必填、唯一、枚举）与问题行导出；
- 通过 Windows COM 调用本机 Excel，精确保留图表/透视表；
- 通过 Outlook COM 读取 `.pst/.ost`；
- 局域网只读分享模式（带令牌）。
