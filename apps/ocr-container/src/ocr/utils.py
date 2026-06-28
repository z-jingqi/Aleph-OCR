from pathlib import Path


def safe_filename(filename: str, fallback: str) -> str:
    value = Path(filename or fallback).name
    return value or fallback
