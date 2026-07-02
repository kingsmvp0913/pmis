"""各格式讀取器,對外統一介面(見 base.py)。"""
from .base import ParseError, ParseResult, parse, detect_type

__all__ = ["ParseError", "ParseResult", "parse", "detect_type"]
