# 表格汇总助手

> **多份表格，汇成一张表。** 为办公室内网准备的本地 Excel 汇总工具：上传 Excel / CSV / Outlook 邮件与附件，按主键把字段汇总到指定模板，逐列指定来源，并支持历史结果对比。**全程离线，数据不出本机。**

![工作台](docs/dashboard.png)

## 下载安装包（给最终用户）

不想碰 Python 的话，直接用打包好的免安装版：

1. 打开 **<https://github.com/lirunwen/table-summary-assistant/releases/latest>**
2. 在 **Assets** 里下载 `TableSummaryAssistant-v*-windows-x64.zip`
3. 解压到任意目录，双击 **「启动.bat」**，浏览器会自动打开工作台

目标电脑**不需要安装 Python，也不需要管理员权限**。全程离线，数据只落在解压目录的 `data\` 文件夹里。删除整个文件夹即完成卸载。

> 这个 zip 由 GitHub Actions 在 `windows-latest` 上自动构建（见 `.github/workflows/build-windows.yml`），
> 构建前会先跑 `tests/test_regressions.py` 和 `tests/smoke.py`，测试不过就不会出包。
> 想自己发版：`git tag v0.2.1 && git push origin v0.2.1`，几分钟后 Release 里就有新包。

## 给文员的完整使用说明

- [Word 版：表格汇总助手-使用说明.docx](<guide/表格汇总助手-使用说明.docx>)（可修改、可打印）
- [PDF 版：表格汇总助手-使用说明.pdf](<guide/表格汇总助手-使用说明.pdf>)（直接发给同事）
- [一页速查：README-使用说明.txt](<README-使用说明.txt>)

说明按“先看这一页 → 上传文件 → 建方案 → 配每列来源 → 预览生成 → 数据对比 → 常见问题”的顺序编写，每一步都有界面截图和勾选清单。

## 为什么是本地 Web 应用

- **同事各自安装、各自使用**：服务只监听 `127.0.0.1`，不需要服务器，也没有账号体系。
- **断网可用**：没有 CDN、Web Font、图标库或统计脚本；CSS、JS、SVG 图标全部随程序分发。
- **无前端构建链**：原生 ES Modules + 手写 CSS，复制源码就能运行，不会遇到“构建产物丢了”的部署问题。
- **面向真实办公文件**：保留 Excel 模板的列宽、表头样式、合并单元格与公式列；邮件正文表格和附件自动展开。
- **状态可追溯**：每次运行生成独立结果文件与运行记录；对比报告可导出为带颜色的 Excel。

## 功能

- 数据接入：`.xlsx` / `.xlsm` / `.xls` / `.csv` / `.tsv` / `.txt`，Outlook `.msg` / `.oft`，邮件 `.eml`。
- 邮件解析：自动提取正文 HTML 表格、附件 Excel/CSV；附件在数据源树中单独展开。
- 目标模板：上传现有 Excel，保留版式；可选择工作表、调整表头行、覆盖或追加写入。
- 逐列映射：每一列指定“来源表 + 来源字段 + 处理方式 + 缺省值”，支持固定值、留空。
- 两种汇总方式：
  - 主表关联：以主表行数为准，按主键（支持组合键）补齐其他表字段；
  - 纵向合并：多张同构表按列名上下拼接，支持同名列自动匹配。
- 运行前预览前 50 行，显示填充率、空值数、关联命中情况。
- 数据对比：两次结果或任意两张表，按主键找出新增 / 删除 / 修改，导出差异 Excel。
- 本地数据目录、运行记录保留策略、一键清理、离线设置。
- 界面响应式，支持 1366 宽办公本与 1024 / 800 宽窗口。

| 数据源 | 字段映射 |
| --- | --- |
| ![数据源](docs/sources.png) | ![字段映射](docs/profile-mapping.png) |

| 运行预览 | 数据对比 |
| --- | --- |
| ![预览](docs/preview.png) | ![对比](docs/compare.png) |

## 快速开始

### 方式 A：下载现成的 Windows 包（推荐给同事）

见上节「下载安装包」，解压即用，无需 Python。

### 方式 B：从源码自己打包 Windows 免安装版

PyInstaller 不支持跨平台交叉编译，**必须在 Windows 上构建**：

```bat
:: 在 Windows 10/11，安装 Python 3.11 或 3.12（64 位）后：
cd table-summary-assistant
packaging\build_windows.bat
```

脚本会自动建虚拟环境、装依赖、跑回归测试、打包、组装并压缩，最终产出
`dist\TableSummaryAssistant-vX.Y.Z-windows-x64.zip`，直接发给同事即可。

### 方式 C：源码运行（开发 / 内网 Python 环境）

```bash
# Python 3.11+
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
python app.py
```

浏览器访问 <http://127.0.0.1:8765>。也可以直接双击 `start.bat`（Windows）或运行 `./start.sh`。

### 无网络安装 Python 依赖

在一台可联网的 Windows 电脑：

```bat
packaging\prepare_offline_wheels.bat
```

把整个项目拷到内网电脑后：

```bat
py -3 -m pip install --no-index --find-links packaging\wheels -r requirements.txt
```

## 三步完成一次汇总

1. **接入数据源**：把文件拖进「数据源」。系统会自动识别工作表、表头行与数据行，可点开预览并修正表头行。
2. **配置汇总方案**：新建方案，上传目标 Excel 模板；选择主表与主键，添加关联表；在「字段映射」里逐列选来源。也可以按列名一键匹配。
3. **运行与对比**：点「生成汇总表」，下载填好的 Excel。下次运行后到「数据对比」，选两次结果与主键（如工号），导出差异报告。

示例文件在 `samples/`：员工主表、考勤、工资 CSV、人员汇总模板、带正文表格和附件的 EML。可直接拖进数据源试用。

## 支持的文件

| 类型 | 读取 | 写入 |
| --- | --- | --- |
| `.xlsx` / `.xlsm` | ✅ 多工作表、合并单元格、表头识别 | ✅ 模板填充 / 新建，`.xlsm` 保留宏 |
| `.xls`（97-2003） | ✅ 读取 | ❌ 模板请先另存为 `.xlsx` |
| `.csv` / `.tsv` / `.txt` | ✅ UTF-8 / GBK / GB18030 等自动识别 | —（结果输出为 Excel） |
| `.msg` / `.oft` | ✅ 主题、发件人、正文表格、附件 | — |
| `.eml` | ✅ 同上 | — |
| `.pst` / `.ost` | ❌ 请先在 Outlook 中另存为 `.msg` | — |

## 数据与隐私

```text
data/
├─ library/     上传的原始文件、邮件正文 CSV、附件
├─ templates/   目标 Excel 模板副本
├─ runs/        每次生成的汇总结果
├─ compares/    对比报告
├─ logs/        运行日志
└─ huiyi.db     方案、数据源、运行记录等元数据
```

- 默认只监听 `127.0.0.1`，同一内网的其他电脑也访问不到。
- 没有云服务、没有遥测、没有外部资源请求。
- 升级时保留 `data/`，替换程序文件即可；建议升级前整体备份。
- 可通过环境变量 `HUIYI_DATA_DIR` 指定其他数据目录。

## 目录结构

```text
app.py                  启动器（端口选择、日志、waitress、打开浏览器）
backend/                解析、汇总、模板写入、对比、API
web/                    原生前端（HTML / CSS / ES Modules / SVG 图标）
samples/                可试用的示例文件
tests/                  端到端冒烟测试、演示数据、截图工具
packaging/              Windows 打包脚本、spec、图标、离线 wheels 脚本
ARCHITECTURE.md         技术选型、模块、数据模型、数据流、部署方案
README-使用说明.txt      给最终使用者的简短说明
```

## 测试

```bash
pip install -r requirements-dev.txt

# 单元 / 回归测试（快，CI 会跑）
pytest tests/test_regressions.py -q

# 端到端冒烟测试（覆盖真实文件）
python tests/smoke.py
```

回归测试覆盖已修复的缺陷：百分比语义、日期歧义、数据库连接释放、追加模式对比行数、
跨站请求拦截、公式注入、空主键跳过、单元格上限、按需解析工作表。

冒烟测试覆盖：上传解析、表头识别、模板上传、关联汇总、预览、表头调整、运行下载、
结果对比、结果对源表、纵向合并自动匹配、`.xls`、真实 `.msg`、公式注入防护、模板追加模式。

生成一套干净的演示数据：

```bash
python tests/seed_demo.py
HUIYI_DATA_DIR="$PWD/data/_demo" python app.py --no-browser
```

## 已知边界

- openpyxl 无法完整保留图表、图片、数据透视表等对象；复杂模板建议生成后用 Excel 打开核对一次。
- 源文件若含**公式**且从未在 Excel 中打开保存过，公式没有缓存值，读取时是空的。
  预览里会列出"全空列"提示，用 Excel 另存一次再上传即可。
- 暂不直接读取 `.pst/.ost`；也不解析邮件附件中的压缩包。
- 邮件正文表格对复杂的 `rowspan/colspan` 支持有限，建议先预览确认。
- 复杂多行表头需要先在数据源预览里指定表头行，暂不做多级表头合并。
- 单机单实例模型，不提供登录、权限与多人并发；如果改为 `--host 0.0.0.0` 暴露到内网，请自行增加访问控制。
- 单表读取上限 20 万行、300 列，单工作表 300 万个单元格（防内存爆掉）；单文件 100 MB、单次上传 200 MB、邮件附件 50 MB。
- `03/04/2026` 这种**日月顺序不明**的日期不会瞎猜：按原文保留并在警告里提示，需要统一请改成 `2026-03-04`。
- 「转为数值」对 `50%` 按数学语义折算成 `0.5`，并自动套百分比格式显示回 `50%`。

## 更新日志

### 0.2.0

修复：
- **追加写模板后，数据对比多读进模板原有行**（结果行数与对比行数不一致）。运行记录现在保存 `data_start`，对比从真正的写入起点开始读。
- **SQLite 连接从不显式关闭**，长期运行会堆积文件描述符与 `.db-wal` 锁。改为每次操作独立连接并 `finally: close()`。
- **`50%` → `50`** 的静默错误。改为 `0.5` + 百分比数字格式；日期 `03/04/2026` 不再按美式猜测。
- 公式注入防护漏掉 `-` 与前导空白/换行；改用 `lstrip` 判断 + `quotePrefix` 强制文本。
- 单工作表超过 300 万单元格时直接给出可读错误，而不是把内存吃光；读取时只解析被引用的工作表。
- `skip_empty_key` 从"存在但从不生效"变成真正生效，界面上加了开关。

加固：
- 本地服务增加 Host / Origin / `Sec-Fetch-Site` 校验，挡住跨站表单提交与 DNS rebinding。
- 上传体积在落盘**之前**就检查，不再先写满磁盘再拒绝。
- 散落在三处的 100/120/200/50 MB 魔数收敛到 `backend/config.py`。

工程：
- 新增 `tests/test_regressions.py`（26 条 pytest 用例）与 GitHub Actions 自动打包流水线。
- 新增 `LICENSE`（MIT）。
- 版本号 0.1.0 → 0.2.0。


## 技术栈

Python 3.11+ · Flask 3 · waitress · openpyxl · xlrd · extract-msg · SQLite · 原生 HTML/CSS/ES Modules。无需 Node.js，无前端构建步骤，无公网资源。

更多设计与实现细节见 [ARCHITECTURE.md](ARCHITECTURE.md)。
