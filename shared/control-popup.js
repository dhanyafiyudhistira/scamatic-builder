export const CONTROL_POPUP_TYPE = 'control-popup'
export const CONTROL_POPUP_CHILD_TYPES = new Set(['control-button', 'tuning-slider'])
export const CONTROL_POPUP_MAX_CHILDREN = 16

export function popupChildIdSet(components = []) {
  return new Set(components
    .filter(component => component?.type === CONTROL_POPUP_TYPE)
    .flatMap(component => Array.isArray(component.children) ? component.children : []))
}

export function popupOwnerMap(components = []) {
  const owners = new Map()
  for (const popup of components.filter(component => component?.type === CONTROL_POPUP_TYPE)) {
    for (const childId of Array.isArray(popup.children) ? popup.children : []) {
      if (!owners.has(childId)) owners.set(childId, popup.id)
    }
  }
  return owners
}

export function rootRuntimeComponents(components = []) {
  const childIds = popupChildIdSet(components)
  return components.filter(component => !childIds.has(component.id))
}

export function assignControlToPopup(components, popupId, childId) {
  const child = components.find(component => component.id === childId)
  const popup = components.find(component => component.id === popupId)
  if (!popup || popup.type !== CONTROL_POPUP_TYPE || !child || !CONTROL_POPUP_CHILD_TYPES.has(child.type)) return components
  const currentChildren = Array.isArray(popup.children) ? popup.children : []
  if (!currentChildren.includes(childId) && currentChildren.length >= CONTROL_POPUP_MAX_CHILDREN) return components
  return components.map(component => {
    if (component.type !== CONTROL_POPUP_TYPE) return component
    const withoutChild = (Array.isArray(component.children) ? component.children : []).filter(id => id !== childId)
    return component.id === popupId ? { ...component, children: [...withoutChild, childId] } : { ...component, children: withoutChild }
  })
}

export function detachControlFromPopup(components, popupId, childId) {
  return components.map(component => component.id === popupId && component.type === CONTROL_POPUP_TYPE
    ? { ...component, children: (Array.isArray(component.children) ? component.children : []).filter(id => id !== childId) }
    : component)
}

export function reorderPopupControl(components, popupId, childId, direction) {
  return components.map(component => {
    if (component.id !== popupId || component.type !== CONTROL_POPUP_TYPE) return component
    const children = [...(Array.isArray(component.children) ? component.children : [])]
    const index = children.indexOf(childId)
    const target = Math.max(0, Math.min(children.length - 1, index + direction))
    if (index < 0 || target === index) return component
    const [moved] = children.splice(index, 1)
    children.splice(target, 0, moved)
    return { ...component, children }
  })
}

export function removeComponentsAndCleanPopups(components, ids) {
  const removed = ids instanceof Set ? ids : new Set(ids)
  return components
    .filter(component => !removed.has(component.id))
    .map(component => {
      if (component.type === CONTROL_POPUP_TYPE) return { ...component, children: (Array.isArray(component.children) ? component.children : []).filter(id => !removed.has(id)) }
      if (component.type !== 'operation-shifter') return component
      return {
        ...component,
        properties: {
          ...component.properties,
          controlledComponentIds: (component.properties?.controlledComponentIds || []).filter(id => !removed.has(id)),
          autoSequence: (component.properties?.autoSequence || []).filter(step => !removed.has(step.componentId)),
        },
      }
    })
}

export function copySafeComponent(component) {
  return component?.type === CONTROL_POPUP_TYPE ? { ...component, children: [] } : component
}
