import { Mark, Extension, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { TextStyleKit } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import { CharacterCount, Placeholder } from '@tiptap/extensions'

// Tracked-change marks. High parse priority so <del> beats the Strike mark.
const changeMark = (name, tag) => Mark.create({
  name,
  inclusive: false,
  addAttributes() {
    return {
      cid: {
        default: null,
        parseHTML: el => el.getAttribute('data-cid'),
        renderHTML: attrs => ({ 'data-cid': attrs.cid }),
      },
    }
  },
  parseHTML() { return [{ tag: `${tag}[data-cid]`, priority: 1000 }] },
  renderHTML({ HTMLAttributes }) { return [tag, mergeAttributes(HTMLAttributes, { class: `tc-${tag}` }), 0] },
})
export const Insertion = changeMark('insertion', 'ins')
export const Deletion = changeMark('deletion', 'del')

// Whole blocks that were added/removed carry data-track-block="ins:N" / "del:N".
export const TrackBlock = Extension.create({
  name: 'trackBlock',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'horizontalRule'],
      attributes: {
        trackBlock: {
          default: null,
          keepOnSplit: false,
          parseHTML: el => el.getAttribute('data-track-block'),
          renderHTML: attrs => (attrs.trackBlock ? { 'data-track-block': attrs.trackBlock } : {}),
        },
      },
    }]
  },
})

// Keeps the text attached to the chat visibly highlighted while the editor is unfocused.
export const attachKey = new PluginKey('attachHighlight')
export const AttachHighlight = Extension.create({
  name: 'attachHighlight',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: attachKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          const meta = tr.getMeta(attachKey)
          if (meta !== undefined) {
            return meta ? DecorationSet.create(tr.doc, [Decoration.inline(meta.from, meta.to, { class: 'attached-sel' })]) : DecorationSet.empty
          }
          return set.map(tr.mapping, tr.doc)
        },
      },
      props: { decorations: state => attachKey.getState(state) },
    })]
  },
})

export function makeExtensions({ placeholder = true } = {}) {
  return [
    StarterKit.configure({ link: { openOnClick: false } }),
    TextStyleKit,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Highlight.configure({ multicolor: true }),
    CharacterCount,
    ...(placeholder ? [Placeholder.configure({ placeholder: 'Start writing…' })] : []),
    Insertion,
    Deletion,
    TrackBlock,
    AttachHighlight,
  ]
}
