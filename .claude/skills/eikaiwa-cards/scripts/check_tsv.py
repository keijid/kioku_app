#!/usr/bin/env python3
"""キオクの一括取り込みに通す前のTSV検証。

app.js の guessDelim / splitRecords / parseBulk と同じ判定をして、
取り込み時に黙って壊れる形を先に見つけます。
"""
import sys
from collections import Counter

IMPORT_MAX = 2000


def guess_delim(text):
    """app.js の guessDelim と同じ：先頭20行で数がいちばん多いものを区切りとする。"""
    lines = [l for l in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if l.strip()][:20]
    best, best_count = "\t", 0
    for d in ("\t", ",", ";"):
        n = sum(l.count(d) for l in lines)
        if n > best_count:
            best, best_count = d, n
    return best


def main(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()

    problems, warnings = [], []

    delim = guess_delim(text)
    if delim != "\t":
        name = {",": "カンマ", ";": "セミコロン"}[delim]
        problems.append(
            f"区切り文字の自動判定が{name}になります。補足内の ASCII の {delim!r} を "
            f"「、」などに置き換えてください（タブより数が多いと負けます）"
        )

    rows, fronts = [], Counter()
    for i, line in enumerate(text.split("\n"), start=1):
        if not line.strip():
            continue
        cells = [c.strip() for c in line.split("\t")]
        rows.append((i, cells))

        if len(cells) < 2:
            problems.append(f"{i}行目: タブが無く、表と裏に分かれません")
            continue
        if len(cells) > 3:
            problems.append(f"{i}行目: 列が{len(cells)}個あります（3列まで。セル内のタブを疑ってください）")
        if not cells[0] or not cells[1]:
            problems.append(f"{i}行目: 表または裏が空です（この行は取り込まれません）")
            continue

        fronts[cells[0]] += 1
        for col, cell in zip(("表", "裏", "補足"), cells):
            if cell.startswith('"'):
                problems.append(
                    f'{i}行目の{col}: セルが " で始まっています。引用符として食われて中身が変わります'
                    "（「」で囲むか引用符を外してください）"
                )
        if len(cells) < 3 or not cells[2]:
            warnings.append(f"{i}行目: 補足が空です")
        if "　" in "".join(cells):
            warnings.append(f"{i}行目: 全角スペースが入っています")

    for front, n in fronts.items():
        if n > 1:
            problems.append(f"表が重複しています（{n}件）: {front[:30]} — 重複は取り込み時に飛ばされます")

    n = len(rows)
    if n > IMPORT_MAX:
        problems.append(f"{n}行あります。一度に取り込めるのは{IMPORT_MAX}枚までです")

    for p in problems:
        print("NG  " + p)
    for w in warnings:
        print("警告 " + w)

    if not problems:
        print(f"OK  {n}枚。3列タブ区切りとして取り込めます。")
        if n > 20:
            print(f"警告 {n}枚は1回のレッスンぶんとしては多めです（目安15〜20枚）")
    return 1 if problems else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: check_tsv.py <file.tsv>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
