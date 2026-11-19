import { useMemo } from 'react';

export type DiffPart = { text: string; type: 'same' | 'add' | 'remove' };

/** Above this many comparison cells we fall back to a single replaced block. */
const MAX_DP_CELLS = 400_000;

function tokenize(value: string) {
  return value.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * Word-level diff with common prefix/suffix trimming, so ordinary edits stay
 * cheap even for long passages.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  const source = tokenize(before);
  const target = tokenize(after);
  const parts: DiffPart[] = [];

  const push = (text: string, type: DiffPart['type']) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += text;
    else parts.push({ text, type });
  };

  let start = 0;
  while (start < source.length && start < target.length && source[start] === target[start]) start += 1;

  let endSource = source.length;
  let endTarget = target.length;
  while (endSource > start && endTarget > start && source[endSource - 1] === target[endTarget - 1]) {
    endSource -= 1;
    endTarget -= 1;
  }

  if (start) push(source.slice(0, start).join(''), 'same');

  const middleSource = source.slice(start, endSource);
  const middleTarget = target.slice(start, endTarget);

  if (middleSource.length * middleTarget.length <= MAX_DP_CELLS) {
    const rows = middleSource.length;
    const columns = middleTarget.length;
    const width = columns + 1;
    const table = new Int32Array((rows + 1) * width);

    for (let row = rows - 1; row >= 0; row -= 1) {
      for (let column = columns - 1; column >= 0; column -= 1) {
        table[row * width + column] = middleSource[row] === middleTarget[column]
          ? table[(row + 1) * width + column + 1] + 1
          : Math.max(table[(row + 1) * width + column], table[row * width + column + 1]);
      }
    }

    let row = 0;
    let column = 0;
    while (row < rows && column < columns) {
      if (middleSource[row] === middleTarget[column]) {
        push(middleSource[row], 'same');
        row += 1;
        column += 1;
      } else if (table[(row + 1) * width + column] >= table[row * width + column + 1]) {
        push(middleSource[row], 'remove');
        row += 1;
      } else {
        push(middleTarget[column], 'add');
        column += 1;
      }
    }
    while (row < rows) {
      push(middleSource[row], 'remove');
      row += 1;
    }
    while (column < columns) {
      push(middleTarget[column], 'add');
      column += 1;
    }
  } else {
    push(middleSource.join(''), 'remove');
    push(middleTarget.join(''), 'add');
  }

  if (endSource < source.length) push(source.slice(endSource).join(''), 'same');

  return parts;
}

export function DiffText({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffWords(before, after), [before, after]);
  const changed = parts.some((part) => part.type !== 'same');

  return (
    <div className="diff-box">
      {parts.map((part, index) => part.type === 'same' ? (
        <span key={index}>{part.text}</span>
      ) : (
        <span key={index} className={part.type === 'add' ? 'diff-add' : 'diff-del'}>
          {part.text}
        </span>
      ))}
      {!changed && <p className="diff-empty">No wording change detected.</p>}
    </div>
  );
}
