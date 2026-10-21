"""Excel 风格公式：词法分析、语法解析、编译与逐行求值。

设计约束（与项目「不静默出错」的原则一致）：

* **绝不使用 eval / exec**：公式来自用户输入，走白名单函数表 + 自建 AST。
* **编译一次、逐行求值**：几万行数据里不能每行都重新解析。`compile_formula()`
  返回可复用的 `Formula` 对象，`Formula.evaluate(fields)` 只做求值。
* **错误分两类**：配置期错误（语法错、引用了不存在的字段）在保存/运行前就拦下，
  给中文提示；运行期计算错（除零、类型不匹配）写标准 Excel 错误值
  （`#DIV/0!` / `#VALUE!` / `#REF!` / `#NUM!`），由调用方汇总进警告。
* **空值语义贴近 Excel**：算术上下文里空值当 0，文本上下文里当 ""，
  日期参与算术时按 Excel 日期序列号（1899-12-30 起的天数）。

引用字段的写法是 `[字段名]`，方括号内按字面匹配源表列名（忽略首尾空白）。
"""
from __future__ import annotations

import datetime as dt
import re
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP, ROUND_UP
from typing import Any, Callable

from .utils import coerce_number, display_value

EXCEL_EPOCH = dt.date(1899, 12, 30)

# Excel 原生错误值：写进单元格后用户一眼能认出「这里没算出来」
ERR_VALUE = "#VALUE!"
ERR_DIV0 = "#DIV/0!"
ERR_REF = "#REF!"
ERR_NAME = "#NAME?"
ERR_NUM = "#NUM!"
ERROR_VALUES = {ERR_VALUE, ERR_DIV0, ERR_REF, ERR_NAME, ERR_NUM}


class FormulaError(Exception):
    """运行期计算错误，携带 Excel 错误值。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class FormulaSyntaxError(Exception):
    """配置期语法错误，带出错位置（1 基字符下标）。"""

    def __init__(self, message: str, pos: int = 0):
        super().__init__(message)
        self.message = message
        self.pos = pos


# --------------------------------------------------------------------------
# 词法
# --------------------------------------------------------------------------

TOKEN_NUM = "num"
TOKEN_STR = "str"
TOKEN_REF = "ref"
TOKEN_IDENT = "ident"
TOKEN_OP = "op"
TOKEN_LPAREN = "("
TOKEN_RPAREN = ")"
TOKEN_COMMA = ","
TOKEN_EOF = "eof"

_OPERATORS = ("<>", ">=", "<=", "+", "-", "*", "/", "^", "&", "=", ">", "<")
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_NUM_RE = re.compile(r"\d+(?:\.\d+)?(?:[eE][+-]?\d+)?")


class Token:
    __slots__ = ("kind", "value", "pos")

    def __init__(self, kind: str, value: Any, pos: int):
        self.kind = kind
        self.value = value
        self.pos = pos

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"Token({self.kind},{self.value!r}@{self.pos})"


def tokenize(text: str) -> list[Token]:
    tokens: list[Token] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in " \t\r\n":
            i += 1
            continue
        # 字符串字面量：内部用 "" 表示一个双引号
        if ch == '"':
            start = i
            i += 1
            buf: list[str] = []
            while True:
                if i >= n:
                    raise FormulaSyntaxError("字符串缺少结尾的双引号", start + 1)
                if text[i] == '"':
                    if i + 1 < n and text[i + 1] == '"':
                        buf.append('"')
                        i += 2
                        continue
                    i += 1
                    break
                buf.append(text[i])
                i += 1
            tokens.append(Token(TOKEN_STR, "".join(buf), start + 1))
            continue
        # 字段引用：[字段名]
        if ch == "[":
            start = i
            end = text.find("]", i + 1)
            if end < 0:
                raise FormulaSyntaxError("字段引用缺少右方括号 ]", start + 1)
            name = text[i + 1:end].strip()
            if not name:
                raise FormulaSyntaxError("[] 里要写字段名", start + 1)
            tokens.append(Token(TOKEN_REF, name, start + 1))
            i = end + 1
            continue
        if ch.isdigit() or (ch == "." and i + 1 < n and text[i + 1].isdigit()):
            m = _NUM_RE.match(text, i)
            if not m:
                raise FormulaSyntaxError(f"数字写法有问题：{text[i:i + 8]}", i + 1)
            raw = m.group(0)
            value = float(raw)
            if value.is_integer() and "e" not in raw.lower() and "." not in raw:
                value = int(raw)
            tokens.append(Token(TOKEN_NUM, value, i + 1))
            i = m.end()
            continue
        m = _IDENT_RE.match(text, i)
        if m:
            tokens.append(Token(TOKEN_IDENT, m.group(0).upper(), i + 1))
            i = m.end()
            continue
        if ch == "(":
            tokens.append(Token(TOKEN_LPAREN, ch, i + 1))
            i += 1
            continue
        if ch == ")":
            tokens.append(Token(TOKEN_RPAREN, ch, i + 1))
            i += 1
            continue
        if ch in ",，":
            # 中文逗号一并接受：用户用中文输入法写函数很常见
            tokens.append(Token(TOKEN_COMMA, ",", i + 1))
            i += 1
            continue
        for op in _OPERATORS:
            if text.startswith(op, i):
                tokens.append(Token(TOKEN_OP, op, i + 1))
                i += len(op)
                break
        else:
            raise FormulaSyntaxError(f"看不懂的字符「{ch}」", i + 1)
    tokens.append(Token(TOKEN_EOF, None, n + 1))
    return tokens


# --------------------------------------------------------------------------
# 语法：优先级从低到高  比较 < & < +- < */ < ^ < 一元 < 原子
# --------------------------------------------------------------------------


class Parser:
    def __init__(self, tokens: list[Token]):
        self.tokens = tokens
        self.i = 0

    def peek(self) -> Token:
        return self.tokens[self.i]

    def next(self) -> Token:
        tok = self.tokens[self.i]
        self.i += 1
        return tok

    def accept(self, kind: str, value: Any = None) -> Token | None:
        tok = self.peek()
        if tok.kind == kind and (value is None or tok.value == value):
            return self.next()
        return None

    def expect(self, kind: str, value: Any = None, what: str = "") -> Token:
        tok = self.accept(kind, value)
        if tok is None:
            got = self.peek()
            label = what or (value or kind)
            raise FormulaSyntaxError(f"这里需要「{label}」", got.pos)
        return tok

    def parse(self):
        node = self.expr()
        if self.peek().kind != TOKEN_EOF:
            tok = self.peek()
            raise FormulaSyntaxError(f"多余的内容「{tok.value}」", tok.pos)
        return node

    def expr(self):
        return self.compare()

    def compare(self):
        node = self.concat()
        while True:
            tok = self.peek()
            if tok.kind == TOKEN_OP and tok.value in ("=", "<>", ">", "<", ">=", "<="):
                self.next()
                node = ("bin", tok.value, node, self.concat())
            else:
                return node

    def concat(self):
        node = self.additive()
        while True:
            tok = self.peek()
            if tok.kind == TOKEN_OP and tok.value == "&":
                self.next()
                node = ("bin", "&", node, self.additive())
            else:
                return node

    def additive(self):
        node = self.multiplicative()
        while True:
            tok = self.peek()
            if tok.kind == TOKEN_OP and tok.value in ("+", "-"):
                self.next()
                node = ("bin", tok.value, node, self.multiplicative())
            else:
                return node

    def multiplicative(self):
        node = self.power()
        while True:
            tok = self.peek()
            if tok.kind == TOKEN_OP and tok.value in ("*", "/"):
                self.next()
                node = ("bin", tok.value, node, self.power())
            else:
                return node

    def power(self):
        node = self.unary()
        tok = self.peek()
        if tok.kind == TOKEN_OP and tok.value == "^":
            self.next()
            # 右结合：2^3^2 = 2^(3^2)
            return ("bin", "^", node, self.power())
        return node

    def unary(self):
        tok = self.peek()
        if tok.kind == TOKEN_OP and tok.value in ("+", "-"):
            self.next()
            operand = self.unary()
            return ("neg", operand) if tok.value == "-" else operand
        return self.primary()

    def primary(self):
        tok = self.next()
        if tok.kind == TOKEN_NUM:
            return ("num", tok.value)
        if tok.kind == TOKEN_STR:
            return ("str", tok.value)
        if tok.kind == TOKEN_REF:
            return ("ref", tok.value)
        if tok.kind == TOKEN_LPAREN:
            node = self.expr()
            self.expect(TOKEN_RPAREN, None, "右括号 )")
            return node
        if tok.kind == TOKEN_IDENT:
            if tok.value in ("TRUE", "FALSE"):
                if self.peek().kind == TOKEN_LPAREN:
                    raise FormulaSyntaxError(f"{tok.value} 不是函数，不要加括号", tok.pos)
                return ("bool", tok.value == "TRUE")
            if self.peek().kind == TOKEN_LPAREN:
                return self.call(tok)
            raise FormulaSyntaxError(
                f"「{tok.value}」如果是字段，要写成 [{tok.value}]；如果是函数，后面要跟 (",
                tok.pos,
            )
        if tok.kind == TOKEN_EOF:
            raise FormulaSyntaxError("公式没有写完", tok.pos)
        raise FormulaSyntaxError(f"这里不该出现「{tok.value}」", tok.pos)

    def call(self, name_tok: Token):
        self.expect(TOKEN_LPAREN)
        args = []
        if self.peek().kind != TOKEN_RPAREN:
            args.append(self.expr())
            while self.accept(TOKEN_COMMA):
                args.append(self.expr())
        self.expect(TOKEN_RPAREN, None, "右括号 )")
        name = name_tok.value
        # IF / IFERROR / ISERROR 在求值阶段做惰性处理（不能预先求值所有分支，
        # 否则没走到的分支也会抛除零之类的错误），所以它们不在 FUNCTIONS 里。
        if name not in FUNCTIONS and name not in LAZY_FUNCTIONS:
            raise FormulaSyntaxError(
                f"不支持的函数 {name}（可用函数见编辑器里的函数速查）", name_tok.pos
            )
        return ("call", name, args, name_tok.pos)


# --------------------------------------------------------------------------
# 取值与类型转换
# --------------------------------------------------------------------------


def _is_date(value: Any) -> bool:
    return isinstance(value, (dt.date, dt.datetime))


def _to_serial(value: Any) -> float | None:
    """日期转 Excel 序列号（含小数时间）。"""
    if isinstance(value, dt.datetime):
        delta = value - dt.datetime.combine(EXCEL_EPOCH, dt.time())
        return delta.total_seconds() / 86400.0
    if isinstance(value, dt.date):
        return float((value - EXCEL_EPOCH).days)
    return None


def to_number(value: Any, *, excel_date: bool = True) -> float:
    """算术上下文取值：空→0、布尔→1/0、日期→序列号、文本按项目规则解析。"""
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if _is_date(value) and excel_date:
        serial = _to_serial(value)
        if serial is not None:
            return serial
    if isinstance(value, str) and value.strip() == "":
        return 0.0
    num = coerce_number(value)
    if num is None:
        raise FormulaError(ERR_VALUE, f"「{display_value(value)}」不是数字")
    return float(num)


def to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    return display_value(value)


def to_bool(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if _is_date(value):
        return True
    text = str(value).strip().upper()
    if text in ("TRUE", "是", "Y", "YES"):
        return True
    if text in ("FALSE", "否", "N", "NO", ""):
        return False
    num = coerce_number(value)
    if num is not None:
        return num != 0
    return True


def _num_out(value: float) -> int | float:
    """数值输出规整：整数值返回 int，避免 3.0 这种显示。"""
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e15:
        return int(value)
    return value


def _round(value: float, digits: int, mode: str = ROUND_HALF_UP) -> float:
    """Excel 的 ROUND 是「四舍五入且远离零」，Python 的 round 是银行家舍入。"""
    quant = Decimal(1).scaleb(-int(digits))
    return float(Decimal(str(value)).quantize(quant, rounding=mode))


# --------------------------------------------------------------------------
# 函数表
# --------------------------------------------------------------------------

FUNCTIONS: dict[str, Callable[..., Any]] = {}

# 这三个函数必须自己控制「哪些参数要真求值」，因此不进 FUNCTIONS 表，
# 单独在 _eval 里处理；解析阶段只做名字白名单校验。
LAZY_FUNCTIONS = frozenset({"IF", "IFERROR", "ISERROR"})


def _register(name: str, min_args: int, max_args: int | None = None):
    """注册函数并统一做参数个数校验。max_args=None 表示不限。"""

    def wrapper(fn):
        def checked(args: list[Any]):
            low = min_args
            high = max_args if max_args is not None else min_args
            if len(args) < low or (max_args is not None and len(args) > high):
                if max_args is None:
                    need = f"至少 {low} 个"
                elif low == high:
                    need = f"{low} 个"
                else:
                    need = f"{low}~{high} 个"
                raise FormulaError(ERR_VALUE, f"{name} 需要{need}参数，实际给了 {len(args)} 个")
            return fn(args)

        FUNCTIONS[name] = checked
        return checked

    return wrapper


def _flat_numbers(args: list[Any]) -> list[float]:
    """SUM/MAX/MIN 的取值：非数字忽略（与 Excel 一致），空值忽略。"""
    out: list[float] = []
    for arg in args:
        if arg is None or (isinstance(arg, str) and arg.strip() == ""):
            continue
        if _is_date(arg):
            serial = _to_serial(arg)
            if serial is not None:
                out.append(serial)
            continue
        if isinstance(arg, bool):
            out.append(1.0 if arg else 0.0)
            continue
        try:
            out.append(to_number(arg))
        except FormulaError:
            continue
    return out


@_register("SUM", 1, None)
def _fn_sum(args):
    return _num_out(sum(_flat_numbers(args)))


@_register("MAX", 1, None)
def _fn_max(args):
    nums = _flat_numbers(args)
    return _num_out(max(nums)) if nums else 0


@_register("MIN", 1, None)
def _fn_min(args):
    nums = _flat_numbers(args)
    return _num_out(min(nums)) if nums else 0


@_register("ABS", 1)
def _fn_abs(args):
    return _num_out(abs(to_number(args[0])))


@_register("INT", 1)
def _fn_int(args):
    return int(to_number(args[0]) // 1)


@_register("MOD", 2)
def _fn_mod(args):
    a, b = to_number(args[0]), to_number(args[1])
    if b == 0:
        raise FormulaError(ERR_DIV0, "MOD 的除数为 0")
    # Excel MOD 的结果符号跟随除数
    return _num_out(a - b * int(a / b))


@_register("POWER", 2)
def _fn_power(args):
    return _num_out(to_number(args[0]) ** to_number(args[1]))


@_register("SQRT", 1)
def _fn_sqrt(args):
    v = to_number(args[0])
    if v < 0:
        raise FormulaError(ERR_NUM, "SQRT 的参数不能是负数")
    return _num_out(v ** 0.5)


@_register("ROUND", 2)
def _fn_round(args):
    return _num_out(_round(to_number(args[0]), int(to_number(args[1])), ROUND_HALF_UP))


@_register("ROUNDUP", 2)
def _fn_roundup(args):
    return _num_out(_round(to_number(args[0]), int(to_number(args[1])), ROUND_UP))


@_register("ROUNDDOWN", 2)
def _fn_rounddown(args):
    return _num_out(_round(to_number(args[0]), int(to_number(args[1])), ROUND_DOWN))


@_register("LEN", 1)
def _fn_len(args):
    return len(to_text(args[0]))


@_register("TRIM", 1)
def _fn_trim(args):
    return " ".join(to_text(args[0]).split())


@_register("UPPER", 1)
def _fn_upper(args):
    return to_text(args[0]).upper()


@_register("LOWER", 1)
def _fn_lower(args):
    return to_text(args[0]).lower()


@_register("LEFT", 1, 2)
def _fn_left(args):
    text = to_text(args[0])
    n = 1 if len(args) < 2 else int(to_number(args[1]))
    if n < 0:
        raise FormulaError(ERR_VALUE, "LEFT 的个数不能是负数")
    return text[:n]


@_register("RIGHT", 1, 2)
def _fn_right(args):
    text = to_text(args[0])
    n = 1 if len(args) < 2 else int(to_number(args[1]))
    if n < 0:
        raise FormulaError(ERR_VALUE, "RIGHT 的个数不能是负数")
    return text[-n:] if n else ""


@_register("MID", 3)
def _fn_mid(args):
    text = to_text(args[0])
    start = int(to_number(args[1]))
    length = int(to_number(args[2]))
    if start < 1 or length < 0:
        raise FormulaError(ERR_VALUE, "MID 的起始位置要 ≥1，长度不能为负")
    return text[start - 1:start - 1 + length]


@_register("SUBSTITUTE", 3, 4)
def _fn_substitute(args):
    text, old, new = to_text(args[0]), to_text(args[1]), to_text(args[2])
    if len(args) == 3:
        return text.replace(old, new)
    which = int(to_number(args[3]))
    if which < 1:
        raise FormulaError(ERR_VALUE, "SUBSTITUTE 的第 4 个参数要 ≥1")
    parts = text.split(old)
    if which >= len(parts):
        return text
    return old.join(parts[:which]) + new + old.join(parts[which:])


@_register("CONCAT", 1, None)
def _fn_concat(args):
    return "".join(to_text(a) for a in args)


FUNCTIONS["CONCATENATE"] = FUNCTIONS["CONCAT"]


@_register("VALUE", 1)
def _fn_value(args):
    num = coerce_number(args[0])
    if num is None:
        raise FormulaError(ERR_VALUE, f"VALUE 转不成数字：「{display_value(args[0])}」")
    return _num_out(float(num))


@_register("AND", 1, None)
def _fn_and(args):
    return all(to_bool(a) for a in args)


@_register("OR", 1, None)
def _fn_or(args):
    return any(to_bool(a) for a in args)


@_register("NOT", 1)
def _fn_not(args):
    return not to_bool(args[0])


@_register("ISBLANK", 1)
def _fn_isblank(args):
    v = args[0]
    return v is None or (isinstance(v, str) and v.strip() == "")


@_register("ISNUMBER", 1)
def _fn_isnumber(args):
    v = args[0]
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return True
    return coerce_number(v) is not None if isinstance(v, str) else False


@_register("TODAY", 0)
def _fn_today(args):
    return dt.date.today()


@_register("NOW", 0)
def _fn_now(args):
    return dt.datetime.now().replace(microsecond=0)


def _as_date(value: Any) -> dt.date:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    num = coerce_number(value)
    if num is not None:
        # 数字按 Excel 序列号解释（与 parse_date_value「裸数字不猜」不同，
        # 这里是用户显式在公式里做日期运算，意图明确）
        return EXCEL_EPOCH + dt.timedelta(days=int(num))
    from .utils import parse_date_value

    ok, parsed = parse_date_value(value)
    if ok and isinstance(parsed, (dt.date, dt.datetime)):
        return parsed.date() if isinstance(parsed, dt.datetime) else parsed
    raise FormulaError(ERR_VALUE, f"「{display_value(value)}」不是日期")


@_register("YEAR", 1)
def _fn_year(args):
    return _as_date(args[0]).year


@_register("MONTH", 1)
def _fn_month(args):
    return _as_date(args[0]).month


@_register("DAY", 1)
def _fn_day(args):
    return _as_date(args[0]).day


@_register("DATE", 3)
def _fn_date(args):
    try:
        return dt.date(int(to_number(args[0])), int(to_number(args[1])), int(to_number(args[2])))
    except ValueError as exc:
        raise FormulaError(ERR_NUM, f"DATE 的年月日无效：{exc}") from exc


@_register("DAYS", 2)
def _fn_days(args):
    return (_as_date(args[0]) - _as_date(args[1])).days


def _add_months(d: dt.date, months: int) -> dt.date:
    total = d.year * 12 + (d.month - 1) + months
    year, month = divmod(total, 12)
    month += 1
    # 目标月没有这一天时取月末（与 Excel EDATE 一致）
    for day in (d.day, 30, 29, 28):
        try:
            return dt.date(year, month, day)
        except ValueError:
            continue
    return dt.date(year, month, 1)


@_register("EDATE", 2)
def _fn_edate(args):
    return _add_months(_as_date(args[0]), int(to_number(args[1])))


@_register("EOMONTH", 2)
def _fn_eomonth(args):
    d = _add_months(_as_date(args[0]), int(to_number(args[1])) + 1)
    return d.replace(day=1) - dt.timedelta(days=1)


# ---- TEXT(value, format) --------------------------------------------------

# 最长匹配优先。不用 strftime 的 %-m/%-d：Windows 上不支持这两个修饰符，
# 而这个工具的目标平台就是 Windows。
_DATE_TOKENS = ("YYYY", "YY", "MM", "DD", "HH", "mm", "SS", "M", "D", "H", "S")


def _format_date(value: Any, fmt: str) -> str:
    if isinstance(value, dt.datetime):
        d = value
    elif isinstance(value, dt.date):
        d = dt.datetime(value.year, value.month, value.day)
    else:
        d = dt.datetime.combine(_as_date(value), dt.time())
    has_time = "H" in fmt or "S" in fmt
    out: list[str] = []
    i = 0
    n = len(fmt)
    while i < n:
        for token in _DATE_TOKENS:
            if not fmt.startswith(token, i):
                continue
            if token == "MM":
                out.append(f"{d.month:02d}")
            elif token == "M":
                out.append(str(d.month))
            elif token == "DD":
                out.append(f"{d.day:02d}")
            elif token == "D":
                out.append(str(d.day))
            elif token == "YYYY":
                out.append(f"{d.year:04d}")
            elif token == "YY":
                out.append(f"{d.year % 100:02d}")
            elif token == "HH":
                out.append(f"{d.hour:02d}")
            elif token == "H":
                out.append(str(d.hour))
            elif token == "SS":
                out.append(f"{d.second:02d}")
            elif token == "S":
                out.append(str(d.second))
            elif token == "mm":
                # 带时间时 mm 是分钟，否则按月份（与 Excel 的上下文规则一致）
                out.append(f"{d.minute:02d}" if has_time else f"{d.month:02d}")
            i += len(token)
            break
        else:
            out.append(fmt[i])
            i += 1
    return "".join(out)


def _format_number(value: float, fmt: str) -> str:
    if "%" in fmt:
        decimals = len(fmt.split(".")[1].replace("%", "")) if "." in fmt else 0
        text = f"{value * 100:,.{decimals}f}" if "," in fmt else f"{value * 100:.{decimals}f}"
        return text + "%"
    decimals = 0
    if "." in fmt:
        tail = fmt.split(".", 1)[1]
        decimals = sum(1 for ch in tail if ch in "0#")
    rounded = _round(value, decimals)
    if "," in fmt:
        return f"{rounded:,.{decimals}f}"
    return f"{rounded:.{decimals}f}"


@_register("TEXT", 2)
def _fn_text(args):
    value, fmt = args[0], to_text(args[1])
    if _is_date(value) or any(t in fmt.upper() for t in ("YYYY", "年", "MM月", "DD日")):
        if _is_date(value):
            return _format_date(value, fmt)
        try:
            return _format_date(_as_date(value), fmt)
        except FormulaError:
            pass
    try:
        return _format_number(to_number(value), fmt)
    except FormulaError:
        return to_text(value)


# --------------------------------------------------------------------------
# 求值
# --------------------------------------------------------------------------


def _compare(op: str, left: Any, right: Any) -> bool:
    both_date = _is_date(left) and _is_date(right)
    if both_date:
        a, b = _as_date(left), _as_date(right)
        numeric = False
    else:
        try:
            a, b = to_number(left), to_number(right)
            numeric = True
        except FormulaError:
            a, b = to_text(left), to_text(right)
            numeric = False
    if op == "=":
        return a == b
    if op == "<>":
        return a != b
    if op == ">":
        return a > b
    if op == "<":
        return a < b
    if op == ">=":
        return a >= b
    if op == "<=":
        return a <= b
    raise FormulaError(ERR_VALUE, f"不认识的比较符 {op}")


def _eval(node, fields: dict[str, Any]):
    kind = node[0]
    if kind == "num" or kind == "str" or kind == "bool":
        return node[1]
    if kind == "ref":
        name = node[1]
        if name not in fields:
            raise FormulaError(ERR_REF, f"找不到字段「{name}」")
        return fields[name]
    if kind == "neg":
        return -to_number(_eval(node[1], fields))
    if kind == "bin":
        op = node[1]
        if op == "&":
            return to_text(_eval(node[2], fields)) + to_text(_eval(node[3], fields))
        if op in ("=", "<>", ">", "<", ">=", "<="):
            return _compare(op, _eval(node[2], fields), _eval(node[3], fields))
        left = to_number(_eval(node[2], fields))
        right = to_number(_eval(node[3], fields))
        if op == "+":
            return left + right
        if op == "-":
            return left - right
        if op == "*":
            return left * right
        if op == "/":
            if right == 0:
                raise FormulaError(ERR_DIV0, "除数为 0")
            return left / right
        if op == "^":
            return left ** right
        raise FormulaError(ERR_VALUE, f"不认识的运算符 {op}")
    if kind == "call":
        name, arg_nodes = node[1], node[2]
        # IF / IFERROR / ISERROR 需要惰性求值：否则没走到的分支也会抛错
        if name == "IF":
            if len(arg_nodes) not in (2, 3):
                raise FormulaError(ERR_VALUE, f"IF 需要 2~3 个参数，实际给了 {len(arg_nodes)} 个")
            cond = to_bool(_eval(arg_nodes[0], fields))
            if cond:
                return _eval(arg_nodes[1], fields)
            return _eval(arg_nodes[2], fields) if len(arg_nodes) == 3 else False
        if name == "IFERROR":
            if len(arg_nodes) != 2:
                raise FormulaError(ERR_VALUE, f"IFERROR 需要 2 个参数，实际给了 {len(arg_nodes)} 个")
            try:
                return _eval(arg_nodes[0], fields)
            except FormulaError:
                return _eval(arg_nodes[1], fields)
        if name == "ISERROR":
            if len(arg_nodes) != 1:
                raise FormulaError(ERR_VALUE, f"ISERROR 需要 1 个参数，实际给了 {len(arg_nodes)} 个")
            try:
                _eval(arg_nodes[0], fields)
                return False
            except FormulaError:
                return True
        fn = FUNCTIONS.get(name)
        if fn is None:
            raise FormulaError(ERR_NAME, f"不支持的函数 {name}")
        args = [_eval(a, fields) for a in arg_nodes]
        return fn(args)
    raise FormulaError(ERR_VALUE, "公式结构异常")


class Formula:
    """编译后的公式：AST + 引用字段列表，可反复求值。"""

    __slots__ = ("text", "ast", "refs")

    def __init__(self, text: str):
        self.text = text
        cleaned = text.strip()
        if cleaned.startswith("="):
            cleaned = cleaned[1:]
        if not cleaned.strip():
            raise FormulaSyntaxError("公式不能为空", 1)
        self.ast = Parser(tokenize(cleaned)).parse()
        self.refs = sorted(_collect_refs(self.ast))

    def evaluate(self, fields: dict[str, Any]) -> Any:
        value = _eval(self.ast, fields)
        if isinstance(value, bool):
            return "TRUE" if value else "FALSE"
        if isinstance(value, float):
            return _num_out(value)
        return value


def _collect_refs(node, out: set[str] | None = None) -> set[str]:
    out = out if out is not None else set()
    kind = node[0]
    if kind == "ref":
        out.add(node[1])
    elif kind == "neg":
        _collect_refs(node[1], out)
    elif kind == "bin":
        _collect_refs(node[2], out)
        _collect_refs(node[3], out)
    elif kind == "call":
        for arg in node[2]:
            _collect_refs(arg, out)
    return out


def compile_formula(text: str) -> Formula:
    """编译公式；语法错误抛 FormulaSyntaxError。"""
    return Formula(text or "")


def formula_refs(text: str) -> list[str]:
    return compile_formula(text).refs


# 供前端展示的函数速查（分类 + 签名 + 说明）
FUNCTION_CATALOG: list[dict] = [
    {"group": "数学计算", "items": [
        {"name": "SUM", "sig": "SUM(值1, 值2, …)", "desc": "求和，忽略空值与非数字"},
        {"name": "ROUND", "sig": "ROUND(数值, 位数)", "desc": "四舍五入（远离零）"},
        {"name": "ROUNDUP", "sig": "ROUNDUP(数值, 位数)", "desc": "向上舍入"},
        {"name": "ROUNDDOWN", "sig": "ROUNDDOWN(数值, 位数)", "desc": "向下舍入"},
        {"name": "ABS", "sig": "ABS(数值)", "desc": "绝对值"},
        {"name": "INT", "sig": "INT(数值)", "desc": "向下取整"},
        {"name": "MOD", "sig": "MOD(数值, 除数)", "desc": "取余，符号随除数"},
        {"name": "POWER", "sig": "POWER(底数, 指数)", "desc": "乘幂"},
        {"name": "SQRT", "sig": "SQRT(数值)", "desc": "平方根"},
        {"name": "MAX", "sig": "MAX(值1, 值2, …)", "desc": "最大值"},
        {"name": "MIN", "sig": "MIN(值1, 值2, …)", "desc": "最小值"},
    ]},
    {"group": "文本处理", "items": [
        {"name": "CONCAT", "sig": "CONCAT(值1, 值2, …)", "desc": "拼接文本，也可用 & 连接"},
        {"name": "LEFT", "sig": "LEFT(文本, 个数)", "desc": "从左侧截取"},
        {"name": "RIGHT", "sig": "RIGHT(文本, 个数)", "desc": "从右侧截取"},
        {"name": "MID", "sig": "MID(文本, 起始, 长度)", "desc": "从中间截取，起始从 1 计"},
        {"name": "LEN", "sig": "LEN(文本)", "desc": "字符个数"},
        {"name": "TRIM", "sig": "TRIM(文本)", "desc": "去除多余空格"},
        {"name": "UPPER", "sig": "UPPER(文本)", "desc": "转大写"},
        {"name": "LOWER", "sig": "LOWER(文本)", "desc": "转小写"},
        {"name": "SUBSTITUTE", "sig": "SUBSTITUTE(文本, 旧, 新, [第几个])", "desc": "替换文本"},
        {"name": "TEXT", "sig": "TEXT(值, \"格式\")", "desc": "按格式转文本，如 TEXT([金额],\"0.00\")"},
        {"name": "VALUE", "sig": "VALUE(文本)", "desc": "文本转数字"},
    ]},
    {"group": "条件判断", "items": [
        {"name": "IF", "sig": "IF(条件, 成立值, [不成立值])", "desc": "条件判断"},
        {"name": "IFERROR", "sig": "IFERROR(表达式, 出错时的值)", "desc": "出错时兜底"},
        {"name": "AND", "sig": "AND(条件1, 条件2, …)", "desc": "全部成立"},
        {"name": "OR", "sig": "OR(条件1, 条件2, …)", "desc": "任一成立"},
        {"name": "NOT", "sig": "NOT(条件)", "desc": "取反"},
        {"name": "ISBLANK", "sig": "ISBLANK(值)", "desc": "是否为空"},
        {"name": "ISNUMBER", "sig": "ISNUMBER(值)", "desc": "是否为数字"},
        {"name": "ISERROR", "sig": "ISERROR(表达式)", "desc": "是否计算失败"},
    ]},
    {"group": "日期计算", "items": [
        {"name": "TODAY", "sig": "TODAY()", "desc": "今天"},
        {"name": "NOW", "sig": "NOW()", "desc": "当前时间"},
        {"name": "YEAR", "sig": "YEAR(日期)", "desc": "取年"},
        {"name": "MONTH", "sig": "MONTH(日期)", "desc": "取月"},
        {"name": "DAY", "sig": "DAY(日期)", "desc": "取日"},
        {"name": "DATE", "sig": "DATE(年, 月, 日)", "desc": "构造日期"},
        {"name": "DAYS", "sig": "DAYS(结束日期, 开始日期)", "desc": "相差天数"},
        {"name": "EDATE", "sig": "EDATE(日期, 月数)", "desc": "加减若干月"},
        {"name": "EOMONTH", "sig": "EOMONTH(日期, 月数)", "desc": "所在月最后一天"},
    ]},
]
