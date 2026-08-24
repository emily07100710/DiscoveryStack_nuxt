export default function rehypeHeadingAnchors() {
  /** @param {any} tree */
  return function transform(tree) {
    /** @param {any} node */
    const visit = (node) => {
      if (node?.type === 'element' && /^h[2-6]$/.test(node.tagName) && node.properties?.id) {
        const alreadyLinked = node.children?.some(/** @param {any} child */ (child) => child?.type === 'element' && child.tagName === 'a')
        if (!alreadyLinked) {
          const id = String(node.properties.id)
          node.children = [{ type: 'element', tagName: 'a', properties: { href: `#${id}` }, children: node.children || [] }]
        }
      }
      for (const child of node.children || []) visit(child)
    }
    visit(tree)
  }
}
