// The parts of CodeMirror 6 SlideX's editor uses, exposed as window.CM.
// Rebuild with: cd tools/codemirror && npm install && npm run build
export { EditorView, keymap, Decoration, ViewPlugin, lineNumbers, highlightActiveLine,
         highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection } from '@codemirror/view';
export { EditorState, StateField, StateEffect, RangeSetBuilder, Compartment } from '@codemirror/state';
export { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
export { searchKeymap, highlightSelectionMatches, search, openSearchPanel } from '@codemirror/search';
export { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching,
         indentOnInput, foldGutter, foldKeymap } from '@codemirror/language';
export { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap, startCompletion,
         acceptCompletion } from '@codemirror/autocomplete';
export { stex } from '@codemirror/legacy-modes/mode/stex';
export { tags } from '@lezer/highlight';
