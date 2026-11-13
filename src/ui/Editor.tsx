// A YAML editor: CodeMirror 6 with its YAML mode, and the compiler's errors
// shown inline on the line they name.

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';
import type { FileIssue } from '../project/project.ts';

const look = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'var(--panel)' },
  '.cm-gutters': { backgroundColor: 'var(--band)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' },
});
const colors = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--accent)' },
  { tag: [tags.string, tags.content], color: 'var(--ink)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--good)' },
  { tag: tags.meta, color: 'var(--muted)' },
]);

export function Editor({ name, text, issues, readOnly, line, onChange }: {
  /** What is being edited: a new name opens a fresh document. */
  name: string;
  text: string;
  issues: FileIssue[];
  readOnly?: boolean;
  /** A line to bring into view. */
  line?: number;
  onChange(text: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    const made = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(), history(), drawSelection(), indentOnInput(), bracketMatching(), highlightActiveLine(), lintGutter(), yaml(), look,
          syntaxHighlighting(colors), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          editable.current.of(EditorState.readOnly.of(Boolean(readOnly))),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && update.transactions.some((transaction) => transaction.isUserEvent('input') || transaction.isUserEvent('delete') || transaction.isUserEvent('undo') || transaction.isUserEvent('redo') || transaction.isUserEvent('move'))) {
              changed.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = made;
    (host.current as unknown as { view: EditorView }).view = made;
    return () => made.destroy();
  }, [name]);

  // The file changed under the editor: an undo, a tool, another panel.
  useEffect(() => {
    const made = view.current;
    if (made && made.state.doc.toString() !== text) made.dispatch({ changes: { from: 0, to: made.state.doc.length, insert: text } });
  }, [text]);

  useEffect(() => view.current?.dispatch({ effects: editable.current.reconfigure(EditorState.readOnly.of(Boolean(readOnly))) }), [readOnly]);

  useEffect(() => {
    const made = view.current;
    if (!made) return;
    const diagnostics: Diagnostic[] = issues.map((issue) => {
      const at = made.state.doc.line(Math.max(1, Math.min(made.state.doc.lines, issue.line ?? 1)));
      return { from: at.from, to: Math.max(at.from, at.to), severity: 'error', message: `${issue.path ? `${issue.path}: ` : ''}${issue.message}` };
    });
    made.dispatch(setDiagnostics(made.state, diagnostics));
  }, [issues, text, name]);

  useEffect(() => {
    const made = view.current;
    if (!made || !line) return;
    const at = made.state.doc.line(Math.max(1, Math.min(made.state.doc.lines, line)));
    made.dispatch({ selection: { anchor: at.from }, effects: EditorView.scrollIntoView(at.from, { y: 'center' }) });
  }, [line, name]);

  return <div className="editor" ref={host} data-editor={name} />;
}
